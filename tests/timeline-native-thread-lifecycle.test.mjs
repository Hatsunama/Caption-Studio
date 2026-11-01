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
  for (const name of ['onTouchesDown', 'onTouchesMove', 'onTouchesCancelled', 'onStart', 'onUpdate', 'onEnd', 'onFinalize']) {
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

function mountedWrapper() {
  const effects = [], ui = [], rn = [], handlers = {}, nativeStates = [], calls = [], exported = {};
  let thread = 'rn';
  const pan = {};
  for (const name of ['manualActivation', 'runOnJS', 'maxPointers', 'blocksExternalGesture']) pan[name] = () => pan;
  for (const name of ['onTouchesDown', 'onTouchesMove', 'onTouchesCancelled', 'onStart', 'onUpdate', 'onEnd', 'onFinalize']) pan[name] = (fn) => { handlers[name] = fn; return pan; };
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
  const event = (dx) => ({ handlerTag: 42, absoluteX: 100 + dx, absoluteY: 200, numberOfPointers: 1, translationX: 0, translationY: 0 });
  const start = () => runUI(() => {
    const manager = { activate() { assert.equal(thread, 'ui'); }, fail() { assert.equal(thread, 'ui'); } };
    handlers.onTouchesDown({ ...event(0), numberOfTouches: 1, allTouches: [event(0)] }, manager);
    handlers.onTouchesMove({ ...event(9), numberOfTouches: 1, allTouches: [event(9)] }, manager);
    handlers.onStart(event(9));
  });
  const finish = () => runUI(() => { handlers.onEnd(event(20), true); handlers.onFinalize(); });
  const unmount = () => { for (const cleanup of cleanups) cleanup(); cleanups = []; };
  const remount = () => { cleanups = effects.map((setup) => setup()).filter(Boolean); };
  return { geometry, calls, nativeStates, flushUI, flushRN, start, finish, unmount, remount };
}

test('mounted wrapper invalidates queued RN callbacks before UI cancellation catches up', () => {
  const f = mountedWrapper(); f.start();
  f.geometry.update({ viewportWidth: 600 });
  f.flushRN();
  assert.deepEqual(f.calls, []);
  f.flushUI();
  assert.deepEqual(f.nativeStates, [[42, 3]]);
  f.finish(); f.flushRN();
  assert.deepEqual(f.calls, []);
  f.start(); f.finish(); f.flushRN();
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 1);
  f.unmount(); f.flushUI();
});

test('mounted wrapper cancels active work once and releases subscriptions through remount', () => {
  const f = mountedWrapper(); f.start(); f.flushRN();
  f.geometry.update({ scale: 32 }); f.flushUI(); f.finish(); f.flushRN();
  assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 0);
  f.unmount(); f.flushUI();
  f.remount(); f.start(); f.finish(); f.flushRN();
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 1);
  f.unmount(); f.flushUI();
});
