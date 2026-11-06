import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as native from '../src/components/editor/timeline-native-pan.ts';
import { createTimelineTimingGesture, createTimelineGestureGeometry } from '../src/lib/timeline-gesture.ts';

function fixture({ holdMilliseconds = 0 } = {}) {
  const handlers = {}, config = {}, queue = [], calls = [];
  let thread = 'rn';
  const pan = {};
  for (const name of ['manualActivation', 'runOnJS', 'maxPointers', 'blocksExternalGesture']) {
    pan[name] = (...args) => { config[name] = args; return pan; };
  }
  for (const name of ['onTouchesDown', 'onTouchesMove', 'onTouchesCancelled', 'onTouchesUp', 'onStart', 'onUpdate', 'onEnd', 'onFinalize']) {
    pan[name] = (fn) => { handlers[name] = fn; return pan; };
  }
  const state = { value: native.initialTimelineNativePanState?.() ?? {} };
  const callbacks = { holdMilliseconds };
  for (const kind of ['prepare', 'begin', 'move', 'finish', 'cancel']) callbacks[kind] = (...args) => {
    assert.equal(thread, 'rn', 'editor callbacks must stay on the RN thread');
    calls.push([kind, ...args]);
  };
  const delivery = native.createTimelineNativePanDelivery?.(callbacks);
  native.createTimelineNativePan(pan, callbacks, [], {
    state, deliver: delivery?.dispatch,
    schedule(fn, ...args) { assert.equal(thread, 'ui'); queue.push(() => fn(...args)); },
  });
  const manager = {};
  for (const kind of ['activate', 'fail']) manager[kind] = () => {
    assert.equal(thread, 'ui', 'native gesture state cannot be changed from RN');
    calls.push([kind]);
  };
  const touch = (dx = 0, dy = 0, numberOfTouches = 1) => ({ handlerTag: 42, numberOfTouches,
    allTouches: [{ absoluteX: 100 + dx, absoluteY: 200 + dy }] });
  const event = (dx, dy = 0, translationX = 0) => ({ handlerTag: 42, absoluteX: 100 + dx,
    absoluteY: 200 + dy, translationX, translationY: 0, numberOfPointers: 1 });
  const invoke = (name, ...args) => {
    thread = config.runOnJS?.[0] === false ? 'ui' : 'rn';
    try { handlers[name]?.(...args); } finally { thread = 'rn'; }
  };
  const flush = () => { while (queue.length) queue.shift()(); };
  const down = () => invoke('onTouchesDown', touch(), manager);
  const start = (dx = 9) => {
    invoke('onTouchesMove', touch(dx), manager);
    invoke('onStart', event(dx));
  };
  return { handlers, config, state, delivery, calls, manager, touch, event, invoke, flush, down, start };
}

test('manual recognition stays on UI and queues editor work onto RN', () => {
  const f = fixture(); f.down();
  assert.equal(f.config.runOnJS[0], false);
  assert.deepEqual(f.calls, []);
  f.start();
  assert.deepEqual(f.calls, [['activate']]);
  f.flush();
  assert.deepEqual(f.calls, [['activate'], ['prepare'], ['begin', 9, 0, false]]);
});

test('native activation rebasing never creates a second displacement threshold', () => {
  const f = fixture(); f.down(); f.start(9); f.flush();
  assert.deepEqual(f.calls.at(-1), ['begin', 9, 0, false]);
  f.invoke('onUpdate', f.event(15, 0, 6)); f.flush();
  assert.deepEqual(f.calls.at(-1), ['move', 15, 0, 1]);
  const changes = [], gesture = createTimelineTimingGesture();
  gesture.begin({ startMs: 1000, endMs: 2000, durationMs: 5000, trackWidth: 1000,
    onPress() {}, onChangeStart() {}, onEnd() {}, onChange: (...args) => changes.push(args) }, 'end');
  gesture.move(f.calls[2][1], f.calls[2][2]);
  assert.equal(changes[0][2], 2045);
});

test('release applies a fresh final sample before committing exactly once', () => {
  const f = fixture(); f.down(); f.start();
  f.invoke('onUpdate', f.event(15, 0, 6));
  f.invoke('onEnd', f.event(30, 0, 21), true);
  f.invoke('onFinalize'); f.flush();
  assert.deepEqual(f.calls.slice(-3), [['move', 15, 0, 1], ['move', 30, 0, 1], ['finish']]);
});

test('release at the last delivered position does not duplicate a preview', () => {
  const f = fixture(); f.down(); f.start();
  f.invoke('onUpdate', f.event(15)); f.invoke('onEnd', f.event(15), true); f.invoke('onFinalize'); f.flush();
  assert.equal(f.calls.filter(([kind]) => kind === 'move').length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 1);
});

for (const stage of ['pending', 'queued-start', 'active']) test(`${stage}: invalidation rejects stale queued callbacks and release`, () => {
  const f = fixture(); f.down();
  if (stage !== 'pending') f.start();
  if (stage === 'active') f.flush();
  assert.ok(f.delivery, 'a versioned RN delivery boundary is required');
  const epoch = f.delivery.invalidate();
  f.state.value = { ...f.state.value, epoch, phase: 'failed' };
  f.invoke('onStart', f.event(12)); f.invoke('onEnd', f.event(40), true); f.invoke('onFinalize'); f.flush();
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 0);
  assert.equal(f.calls.filter(([kind]) => kind === 'begin').length, stage === 'active' ? 1 : 0);
  assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, stage === 'active' ? 1 : 0);
  f.down(); f.start(); f.invoke('onEnd', f.event(9), true); f.invoke('onFinalize'); f.flush();
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 1, 'fresh touch recovers');
});

test('vertical intent yields to scrolling without selection or history', () => {
  const f = fixture(); f.down(); f.invoke('onTouchesMove', f.touch(0, 20), f.manager); f.invoke('onFinalize'); f.flush();
  assert.deepEqual(f.calls, [['fail'], ['prepare']]);
});

test('a second finger cancels active work once and never commits', () => {
  const f = fixture(); f.down(); f.start(); f.flush();
  f.invoke('onTouchesMove', f.touch(20, 0, 2), f.manager);
  f.invoke('onEnd', f.event(40), true); f.invoke('onFinalize'); f.flush();
  assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 0);
});

test('a non-finite final coordinate cancels instead of persisting timing', () => {
  const f = fixture(); f.down(); f.start(); f.invoke('onEnd', f.event(NaN), true); f.invoke('onFinalize'); f.flush();
  assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 0);
});

test('video hold intent is decided on UI without calling an RN ref', () => {
  const f = fixture({ holdMilliseconds: 350 }); f.down();
  f.state.value = { ...f.state.value, startedAt: Date.now() - 400 };
  f.start(0); f.flush();
  assert.deepEqual(f.calls.at(-1), ['begin', 0, 0, true]);
  f.invoke('onUpdate', f.event(12, 20));
  f.invoke('onEnd', f.event(18, 25), true); f.invoke('onFinalize'); f.flush();
  assert.deepEqual(f.calls.slice(-3), [['move', 12, 20, 1], ['move', 18, 25, 1], ['finish']]);
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 1);
});

test('unmounted delivery ignores queued touches and supports strict-effect remount', () => {
  const f = fixture(); f.down(); f.start();
  assert.ok(f.delivery);
  f.delivery.unmount(); f.flush();
  assert.ok(!f.calls.some(([kind]) => kind === 'begin'));
  f.delivery.mount();
  f.state.value = { ...f.state.value, epoch: f.delivery.epoch(), phase: 'idle' };
  f.down(); f.start(); f.invoke('onEnd', f.event(9), true); f.invoke('onFinalize'); f.flush();
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 1);
});

function mountedWrapper({ flushMount = true } = {}) {
  const effects = [], ui = [], rn = [], handlers = {}, nativeStates = [], liveStates = [], calls = [], exported = {};
  let liveTouch = false;
  let originX = 100;
  let thread = 'rn';
  const pan = {};
  for (const name of ['manualActivation', 'runOnJS', 'maxPointers', 'blocksExternalGesture']) pan[name] = () => pan;
  for (const name of ['onTouchesDown', 'onTouchesMove', 'onTouchesCancelled', 'onTouchesUp', 'onStart', 'onUpdate', 'onEnd', 'onFinalize']) pan[name] = (fn) => { handlers[name] = fn; return pan; };
  const geometry = createTimelineGestureGeometry({ viewportWidth: 360, scale: 16 });
  const source = readFileSync(new URL('../src/components/editor/timeline-native-gesture.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const scheduleOnRN = (fn, ...args) => { assert.equal(thread, 'ui'); rn.push(() => fn(...args)); };
  const scheduleOnUI = (fn, ...args) => { assert.equal(thread, 'rn'); ui.push(() => fn(...args)); };
  runInNewContext(code, { exports: exported, require(name) {
    if (name === 'react') return { createContext: (value) => ({ value }), useContext: (context) => context.value,
      useState: (initialize) => [initialize()], useEffect: (setup) => effects.push(setup) };
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }) };
    if (name === '@/components/spring-scroll-view') return {
      SpringScrollView: 'ScrollView', SpringScrollGestureContext: { value: [] },
    };
    if (name === 'react-native') return { Platform: { OS: 'android' }, View: 'View', ScrollView: 'ScrollView' };
    if (name === 'react-native-gesture-handler') return { Gesture: { Pan: () => pan }, GestureDetector: 'GestureDetector', State: { FAILED: 1, CANCELLED: 3 } };
    if (name === 'react-native-reanimated') return { useSharedValue: (value) => ({ value }), setGestureState: (...args) => {
      assert.equal(thread, 'ui'); nativeStates.push(args);
      // Model the recorded invalid native precondition at queue drain, not the
      // unknown device timing that produced it. Missing registry is a no-op;
      // ordinary reset preserves terminal state and prepare restores ownership.
      throw new Error('Exception in HostFunction: java.lang.NullPointerException (modeled observed boundary)');
    } };
    if (name === 'react-native-worklets') return { scheduleOnRN, scheduleOnUI };
    if (name === './timeline-native-pan') return native;
    throw new Error(name);
  } });
  exported.TimelineNativeGeometryContext.value = geometry;
  const callbacks = {};
  for (const kind of ['begin', 'move', 'finish', 'cancel']) callbacks[kind] = (...args) => {
    assert.equal(thread, 'rn'); calls.push([kind, ...args]);
  };
  exported.TimelineNativeGestureView({ nativeCallbacks: callbacks, panHandlers: {}, style: { width: 24 } });
  let cleanups = effects.map((setup) => setup()).filter(Boolean);
  const runUI = (fn) => { thread = 'ui'; try { fn(); } finally { thread = 'rn'; } };
  const flushUI = () => { while (ui.length) runUI(ui.shift()); };
  const flushRN = () => { while (rn.length) rn.shift()(); };
  const event = (dx) => ({ handlerTag: 42, absoluteX: originX + dx, absoluteY: 200, numberOfPointers: 1, translationX: 0, translationY: 0 });
  const touch = (dx = 0) => ({ ...event(dx), numberOfTouches: 1, allTouches: [event(dx)] });
  const invokeTouch = (name, dx = 0) => runUI(() => {
    liveTouch = true;
    const manager = {};
    for (const kind of ['activate', 'fail']) manager[kind] = () => {
      assert.equal(thread, 'ui');
      assert.equal(liveTouch, true, 'manager is usable only inside its live touch callback');
      liveStates.push(kind);
    };
    try { handlers[name](touch(dx), manager); } finally { liveTouch = false; }
  });
  const down = () => invokeTouch('onTouchesDown');
  const move = () => invokeTouch('onTouchesMove', 9);
  const up = () => invokeTouch('onTouchesUp', 20);
  const cancelled = () => invokeTouch('onTouchesCancelled');
  const start = () => {
    down(); move(); runUI(() => handlers.onStart(event(9)));
  };
  const update = () => runUI(() => handlers.onUpdate(event(15)));
  const finish = () => runUI(() => { handlers.onEnd(event(20), true); handlers.onFinalize(); });
  const unmount = () => { for (const cleanup of cleanups) cleanup(); cleanups = []; };
  const remount = () => { cleanups = effects.map((setup) => setup()).filter(Boolean); };
  const flushLastUI = () => { if (ui.length) runUI(ui.pop()); };
  if (flushMount) flushUI(); // Initial mounted generation is available to live touch callbacks.
  return { geometry, calls, nativeStates, liveStates, flushUI, flushLastUI, flushRN,
    down, move, up, cancelled, start, update, finish, unmount, remount,
    queuedUI: () => ui.length, setOrigin: (x) => { originX = x; } };

}

test('mounted wrapper invalidates queued RN callbacks before UI cancellation catches up', () => {
  const f = mountedWrapper(); f.start();
  f.geometry.update({ viewportWidth: 600 });
  f.flushRN();
  assert.deepEqual(f.calls, []);
  f.flushUI();
  assert.deepEqual(f.nativeStates, []);
  f.move();
  assert.equal(f.liveStates.at(-1), 'fail', 'invalidated stream yields through its live manager');
  f.finish(); f.flushRN();
  assert.deepEqual(f.calls, []);
  f.start(); f.finish(); f.flushRN();
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 1);
  f.unmount(); f.flushUI();
});

test('mounted wrapper cancels active work once and releases subscriptions through remount', () => {
  const f = mountedWrapper(); f.start(); f.flushRN();
  f.geometry.update({ scale: 32 });
  assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, 1, 'RN editor cancellation is immediate');
  f.flushUI(); f.move();
  assert.equal(f.liveStates.at(-1), 'fail');
  f.finish(); f.flushRN();
  assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 0);
  f.unmount(); f.flushUI();
  f.remount(); f.flushUI(); f.start(); f.finish(); f.flushRN();
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 1);
  f.unmount(); f.flushUI();
});

for (const stage of ['pending', 'queued-start', 'active']) {
  test(`wrapper ${stage}: teardown drains safely at the observed invalid-native boundary`, () => {
    const f = mountedWrapper();
    if (stage === 'pending') f.down(); else f.start();
    if (stage === 'active') f.flushRN();
    f.unmount();
    assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, stage === 'active' ? 1 : 0);
    // Any raw native lifecycle command here throws the captured HostFunction
    // failure. This exercises the actual wrapper cleanup, not a copied helper.
    assert.doesNotThrow(() => f.flushUI());
    const liveCount = f.liveStates.length;
    f.move(); f.up(); f.cancelled(); f.down(); f.update(); f.finish(); f.flushRN();
    assert.equal(f.liveStates.length, liveCount, 'callbacks after detach cannot command native state');
    assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 0);
    assert.equal(f.calls.filter(([kind]) => kind === 'begin').length, stage === 'active' ? 1 : 0);
    assert.deepEqual(f.nativeStates, []);
    f.remount(); f.flushUI(); f.start(); f.finish(); f.flushRN();
    assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 1);
    f.unmount(); f.flushUI();
  });
}

for (const stage of ['pending', 'queued-start', 'active']) {
  for (const release of ['move', 'up']) test(`wrapper ${stage}: geometry cancellation yields on live ${release}`, () => {
    const f = mountedWrapper();
    if (stage === 'pending') f.down(); else f.start();
    if (stage === 'active') f.flushRN();
    f.geometry.update({ scale: 32 });
    assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, stage === 'active' ? 1 : 0);
    // Stale UI callbacks may still queue, but RN must already reject them.
    f.update(); f.flushRN();
    assert.equal(f.calls.filter(([kind]) => kind === 'move').length, 0);
    assert.doesNotThrow(() => f.flushUI());
    const count = f.liveStates.length;
    f[release]();
    assert.equal(f.liveStates.length, count + 1);
    assert.equal(f.liveStates.at(-1), 'fail', 'release the scroll dependency in the live callback');
    f.move(); f.up();
    assert.equal(f.liveStates.length, count + 1, 'do not fail an already released stream again');
    f.finish(); f.flushRN();
    assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 0);
    f.start(); f.finish(); f.flushRN();
    assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 1);
    assert.deepEqual(f.nativeStates, []);
    f.unmount(); f.flushUI();
  });
}

test('strict replay: delayed old cleanup cannot cancel a newer mounted touch', () => {
  const f = mountedWrapper(); f.start(); f.flushRN();
  f.unmount(); f.remount();
  f.flushLastUI(); // New mount reaches UI before the old queued cleanup.
  f.start(); f.flushRN();
  assert.equal(f.calls.filter(([kind]) => kind === 'begin').length, 2);
  f.flushUI(); f.update(); f.finish(); f.flushRN();
  assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 1);
  f.unmount(); f.flushUI();
});

test('out-of-order geometry tasks cannot rewind epoch or cancel a fresh touch', () => {
  const f = mountedWrapper(); f.start(); f.flushRN();
  f.geometry.update({ scale: 32 }); f.geometry.update({ scale: 64 });
  f.flushLastUI(); f.start(); f.flushRN();
  f.flushUI(); f.finish(); f.flushRN();
  assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 1);
  f.unmount(); f.flushUI();
});


test('unmount before initial queued UI setup drains cannot revive detached ownership', () => {
  const f = mountedWrapper({ flushMount: false });
  f.start(); f.unmount(); f.flushLastUI(); f.flushUI(); f.flushRN();
  const count = f.liveStates.length;
  f.down(); f.move(); f.up(); f.cancelled(); f.finish(); f.flushRN();
  assert.equal(f.liveStates.length, count);
  assert.deepEqual(f.calls, []);
  f.geometry.update({ scale: 32 });
  assert.equal(f.queuedUI(), 0, 'detached geometry subscription is removed');
  f.remount(); f.flushUI(); f.start(); f.finish(); f.flushRN();
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 1);
  f.unmount(); f.flushUI();
});

test('fresh geometry epoch uses a new absolute coordinate origin and rejects old queued samples', () => {
  const f = mountedWrapper(); f.start(); f.flushRN(); f.update();
  f.geometry.update({ viewportWidth: 720 }); f.flushUI();
  f.move(); f.finish();
  f.setOrigin(500); f.start(); f.update(); f.finish(); f.flushRN();
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'begin'), [['begin', 9, 0, false], ['begin', 9, 0, false]]);
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'move'), [['move', 15, 0, 1], ['move', 20, 0, 1]]);
  assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 1);
  f.unmount(); f.flushUI();
});

test('initial mount synchronization preserves a touch already accepted on UI', () => {
  const f = mountedWrapper({ flushMount: false });
  f.start(); f.flushRN();
  assert.equal(f.calls.filter(([kind]) => kind === 'begin').length, 1);
  f.flushUI(); f.update(); f.finish(); f.flushRN();
  assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, 0);
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 1);
  f.unmount(); f.flushUI();
});

test('duplicate mount leaves an existing delivery and active edit intact', () => {
  const f = fixture(); f.down(); f.start(); f.flush();
  const epoch = f.delivery.epoch();
  assert.equal(f.delivery.mount(), epoch);
  assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, 0);
  f.invoke('onEnd', f.event(25), true); f.invoke('onFinalize'); f.flush();
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 1);
});
