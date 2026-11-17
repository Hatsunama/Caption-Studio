import assert from 'node:assert/strict';
import test from 'node:test';
import { mountedWrapper } from './timeline-native-thread-lifecycle.test.mjs';

function fakeAppState(initial = 'active') {
  const listeners = new Map();
  return {
    currentState: initial,
    addEventListener(kind, listener) {
      const set = listeners.get(kind) ?? new Set();
      listeners.set(kind, set); set.add(listener);
      return { remove: () => set.delete(listener) };
    },
    emit(kind, value) {
      if (kind === 'change') this.currentState = value;
      for (const listener of [...(listeners.get(kind) ?? [])]) listener(value);
    },
    snapshot(kind) { return [...(listeners.get(kind) ?? [])]; },
    count() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); },
  };
}

for (const interruption of ['blur', 'background', 'inactive']) {
  for (const stage of ['pending', 'queued-begin', 'queued-finish', 'active']) {
    test(`focus ${interruption}/${stage}: stale work cannot commit without native cancellation`, () => {
      const appState = fakeAppState();
      const f = mountedWrapper({ appState });
      if (stage === 'pending') f.down(); else f.start();
      if (stage === 'active') f.flushRN();
      if (stage === 'queued-finish') { f.update(); f.finish(); }
      if (interruption === 'blur') appState.emit('blur'); else appState.emit('change', interruption);
      assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, stage === 'active' ? 1 : 0);
      // RN drains while the UI still has the old epoch; even a successful release is stale.
      f.update(); f.finish(); f.flushRN();
      assert.equal(f.calls.filter(([kind]) => kind === 'begin').length, stage === 'active' ? 1 : 0);
      assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 0);
      f.flushUI(); f.start(); f.update(); f.finish(); f.flushRN();
      assert.equal(f.calls.filter(([kind]) => kind === 'begin').length, stage === 'active' ? 1 : 0, 'UI recognition stays disabled while suspended');
      appState.emit('change', 'active'); appState.emit('focus'); f.flushUI();
      f.move(); f.update(); f.finish(); f.flushRN();
      assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 0, 'resume cannot continue an old stream');
      f.start(); f.finish(); f.flushRN();
      assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 1, 'fresh prepare recovers');
      f.unmount(); f.flushUI();
      assert.equal(appState.count(), 0);
    });
  }
}

test('blur clears parent reorder visual once; queued begin cannot reacquire it after resume', () => {
  const appState = fakeAppState();
  let visual = false, ends = 0, commits = 0;
  const f = mountedWrapper({ appState, callbackOverrides: {
    begin() { visual = true; }, move() {},
    cancel() { visual = false; ends++; }, // parent onReorderEnd(true) also clears its hold timer/state.
    finish() { visual = false; commits++; },
  } });
  f.start(); f.flushRN(); assert.equal(visual, true);
  f.update(); appState.emit('blur'); appState.emit('blur'); appState.emit('change', 'background');
  assert.equal(visual, false); assert.equal(ends, 1);
  appState.emit('change', 'active'); appState.emit('focus');
  f.finish(); f.flushRN(); f.flushLastUI(); f.flushUI();
  assert.equal(visual, false); assert.equal(commits, 0);
  f.start(); // A queued begin when the parent's hold timer has cleared its visual state.
  appState.emit('blur'); visual = false;
  appState.emit('focus'); f.flushLastUI(); f.flushUI(); f.flushRN();
  assert.equal(visual, false, 'old queued begin cannot reacquire cleared parent state');
  f.start(); f.flushRN(); assert.equal(visual, true);
  f.flushUI(); f.finish(); f.flushRN(); assert.equal(commits, 1);
  f.unmount(); f.flushUI();
});

test('geometry cannot reopen suspended ownership; reversed UI tasks preserve newest focus epoch', () => {
  const appState = fakeAppState(); const f = mountedWrapper({ appState });
  f.start(); f.flushRN(); appState.emit('blur');
  f.geometry.update({ scale: 32 }); f.flushLastUI(); f.flushUI();
  f.start(); f.finish(); f.flushRN();
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 0);
  appState.emit('focus'); f.geometry.update({ scale: 64 }); f.flushLastUI();
  f.start(); f.flushRN(); f.flushUI(); f.finish(); f.flushRN();
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, 1);
  f.unmount(); f.flushUI();
});

test('initial background and strict replay remove listeners and reject removed event snapshots', () => {
  const appState = fakeAppState('background'); const f = mountedWrapper({ appState, flushMount: false });
  f.flushLastUI(); f.flushUI(); f.start(); f.finish(); f.flushRN(); assert.deepEqual(f.calls, []);
  appState.emit('change', 'active'); f.flushUI(); f.start(); f.flushRN();
  const stale = appState.snapshot('blur'); assert.equal(stale.length, 1);
  f.unmount(); assert.equal(appState.count(), 0); f.remount(); f.flushLastUI();
  f.start(); f.flushRN();
  for (const listener of stale) listener();
  f.flushUI(); f.finish(); f.flushRN();
  assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 1);
  f.unmount(); appState.emit('focus'); f.flushUI(); assert.equal(appState.count(), 0);
});

for (const stage of ['queued-begin', 'queued-move', 'queued-finish']) {
  test(`resume rejects ${stage} held on RN across blur, background, focus and fresh prepare`, () => {
    const appState = fakeAppState(); const f = mountedWrapper({ appState });
    f.start();
    if (stage !== 'queued-begin') f.flushRN();
    f.update();
    if (stage === 'queued-finish') f.finish();
    appState.emit('blur'); appState.emit('change', 'background');
    appState.emit('focus'); // Focus alone cannot enable a background app.
    f.flushLastUI(); f.flushUI(); f.start(); f.finish();
    appState.emit('change', 'active'); f.flushLastUI();
    // No native cancelled/finalized callback is needed to retire the old stream.
    f.update(); f.finish();
    f.start(); f.update(); f.finish();
    f.flushUI(); f.flushRN();
    assert.equal(f.calls.filter(([kind]) => kind === 'begin').length, stage === 'queued-begin' ? 1 : 2);
    assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, stage === 'queued-begin' ? 0 : 1);
    assert.deepEqual(f.calls.filter(([kind]) => kind === 'move'), [['move', 15, 0, 1], ['move', 20, 0, 1]]);
    assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 1, 'only the fresh stream commits');
    f.unmount(); f.flushUI();
  });
}
