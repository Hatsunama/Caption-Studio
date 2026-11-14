import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Reuse the full production timeline/timing-hook harness without registering
// its unrelated tests. Adapt its host double to RN's public View handler keys.
const fixtureURL = new URL('./timeline-horizontal-recovery.test.mjs', import.meta.url);
let source = readFileSync(fixtureURL, 'utf8').split('\nfunction aligned(h)')[0];
source = source.replace("new URL('../src/', import.meta.url)", JSON.stringify(new URL('../src/', import.meta.url).href));
source = source.replace('PanResponder: { create: panHandlers => ({ panHandlers }) }', `PanResponder: { create: config => ({ panHandlers: Object.fromEntries([
  ['onStartShouldSetResponderCapture', 'onStartShouldSetPanResponderCapture'],
  ['onStartShouldSetResponder', 'onStartShouldSetPanResponder'],
  ['onMoveShouldSetResponderCapture', 'onMoveShouldSetPanResponderCapture'],
  ['onMoveShouldSetResponder', 'onMoveShouldSetPanResponder'],
  ['onResponderGrant', 'onPanResponderGrant'], ['onResponderMove', 'onPanResponderMove'],
  ['onResponderRelease', 'onPanResponderRelease'], ['onResponderTerminate', 'onPanResponderTerminate'],
  ['onResponderTerminationRequest', 'onPanResponderTerminationRequest'],
].map(([key, callback]) => [key, event => config[callback]?.(event, event.testMovement)])) }) }`);
source = source.replace('{ exports, clearTimeout, setTimeout,', '{ exports, Date, clearTimeout, setTimeout,');
source = source.replace('const pan = wrapper.props.gesture.handlers, calls = [];', 'const pan = wrapper.props.gesture?.handlers ?? {}, calls = [];');
source = source.replace('return { calls,', `return { calls, wrapper,
  replay() {
    const mounted = childSlots.at(-1).filter(slot => slot?.setup);
    const old = mounted.map(slot => slot.cleanup).filter(Boolean);
    for (const cleanup of old) cleanup();
    for (const slot of mounted) slot.cleanup = slot.setup();
    return () => { for (const cleanup of old) cleanup(); };
  },`);
// Resolve this shared fixture's sole bare dependency before using a data URL.
source = source.replace("import ts from 'typescript';", `import ts from ${JSON.stringify(import.meta.resolve('typescript'))};`);
source += '\nexport { harness };';
const { harness } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

function fallback(platform = 'ios', initialBackground = false) {
  const commits = [], ends = [], locks = [];
  const layers = ['back', 'front'].map(id => ({ id, name: id, kind: 'image', visible: true, startMs: 0, endMs: 2000 }));
  const h = harness({ layers, currentMs: 0, onReorderVisualLayer: (...args) => commits.push(args) }, { platform, manualIntervals: true });
  h.ready();
  if (initialBackground) h.appState('background');
  const block = h.findAll('TimedBlock').find(v => v.label === 'front');
  const item = h.mountItemPan({ ...block, onTouchLock: locked => { locks.push(locked); block.onTouchLock?.(locked); },
    onReorderEnd: cancelled => { ends.push(cancelled); block.onReorderEnd(cancelled); } }, 'move');
  const handlers = item.wrapper.props;
  let now = Date.now();
  const originalNow = Date.now;
  Date.now = () => now;
  const invoke = (key, dy = 50, dx = 0) => {
    const result = handlers[key]({ nativeEvent: { touches: key === 'onResponderRelease' ? [] : [{}] }, testMovement: { dx, dy } });
    h.flush(); return result;
  };
  return { h, item, commits, ends, locks, invoke,
    start() { invoke('onStartShouldSetResponderCapture', 0); now += 400; },
    grant() { return invoke('onResponderGrant'); },
    close() { Date.now = originalNow; h.close(); },
  };
}

for (const platform of ['ios', 'web']) {
  for (const status of ['inactive', 'background']) {
    test(`${platform}/${status}: actual fallback reorder stops timer and rejects retired callbacks until fresh start`, () => {
      const f = fallback(platform);
      try {
        assert.equal(f.item.wrapper.type, 'View');
        assert.equal(f.item.wrapper.props.onPanResponderRelease, undefined);
        f.start(); assert.equal(f.invoke('onMoveShouldSetResponderCapture'), true); f.grant();
        assert.equal(f.h.intervalCount, 1);
        f.h.appState(status);
        assert.equal(f.h.intervalCount, 0, 'availability loss must stop the real reorder timer');
        assert.deepEqual(f.ends, [true]); assert.equal(f.locks.at(-1), false);
        f.h.appState(status); f.invoke('onResponderRelease');
        f.h.appState('active');
        f.grant(); f.invoke('onResponderMove'); f.invoke('onResponderRelease'); f.h.tickIntervals();
        assert.deepEqual(f.commits, []); assert.deepEqual(f.ends, [true]);
        assert.equal(f.h.intervalCount, 0);
        f.start(); f.grant(); f.invoke('onResponderRelease');
        assert.equal(f.commits.length, 1); assert.deepEqual(f.ends, [true, false]);
      } finally { f.close(); }
    });
  }
  for (const interruption of ['availability', 'geometry', 'replay']) {
    test(`${platform}: pending stream cannot grant after ${interruption}`, () => {
      const f = fallback(platform);
      try {
        f.start();
        if (interruption === 'availability') { f.h.appState('background'); f.h.appState('active'); }
        if (interruption === 'geometry') f.h.resize(500);
        if (interruption === 'replay') f.item.replay();
        f.grant(); f.invoke('onResponderMove'); f.invoke('onResponderRelease');
        assert.deepEqual(f.commits, []); assert.deepEqual(f.ends, []); assert.deepEqual(f.locks, []);
        f.start(); f.grant(); f.invoke('onResponderRelease'); assert.equal(f.commits.length, 1);
      } finally { f.close(); }
    });
  }
  test(`${platform}: background at mount rejects start/grant and old cleanup cannot cancel replayed stream`, () => {
    const f = fallback(platform, true);
    try {
      f.start(); f.grant(); assert.equal(f.h.intervalCount, 0);
      f.h.appState('active'); f.grant(); assert.equal(f.h.intervalCount, 0);
      f.start(); f.grant(); const staleListeners = f.h.captureAppStateListeners();
      const oldCleanup = f.item.replay();
      f.start(); f.grant(); oldCleanup();
      for (const listener of staleListeners) listener('background');
      assert.equal(f.h.intervalCount, 1);
      f.invoke('onResponderRelease'); assert.equal(f.commits.length, 1);
    } finally { f.close(); }
  });
}
