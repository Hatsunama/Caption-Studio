import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as native from '../src/components/editor/timeline-native-pan.ts';
import { createTimelineGestureGeometry } from '../src/lib/timeline-gesture.ts';

const layerSource = readFileSync(new URL('../src/components/editor/layer-timeline.tsx', import.meta.url), 'utf8');
const wrapperSource = readFileSync(new URL('../src/components/editor/timeline-native-gesture.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('layer.tsx', layerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const trackSource = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'TimelineTrackHandle').getText(ast);
const compile = (source) => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;

function fixture({ disabled = false, axis, holdMilliseconds = 0 } = {}) {
  let thread = 'rn';
  const ui = [], rn = [], effects = [], handlers = {}, config = {}, calls = [], states = [];
  const pan = {};
  for (const name of ['enabled', 'manualActivation', 'runOnJS', 'maxPointers', 'blocksExternalGesture']) {
    pan[name] = (...args) => { config[name] = args; return pan; };
  }
  for (const name of ['onTouchesDown', 'onTouchesMove', 'onTouchesCancelled', 'onStart', 'onUpdate', 'onEnd', 'onFinalize']) {
    pan[name] = (fn) => { handlers[name] = fn; return pan; };
  }
  const geometry = createTimelineGestureGeometry({ viewportWidth: 360, scale: 16 });
  const hooks = { createContext: (value) => ({ value }), useContext: (context) => context.value,
    useState: (init) => [typeof init === 'function' ? init() : init], useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn, useEffect: (setup) => effects.push(setup) };
  const jsx = (type, props) => ({ type, props });
  const exports = {};
  const onRN = (kind, ...args) => { assert.equal(thread, 'rn'); calls.push([kind, ...args]); };
  const runUI = (fn) => { thread = 'ui'; try { fn(); } finally { thread = 'rn'; } };
  runInNewContext(compile(wrapperSource), { exports, require(name) {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'react-native') return { Platform: { OS: 'android' }, View: 'View', ScrollView: 'ScrollView' };
    if (name === 'react-native-gesture-handler') return { Gesture: { Pan: () => pan, Native: () => ({}) }, GestureDetector: 'GestureDetector', State: { FAILED: 1, CANCELLED: 3 } };
    if (name === 'react-native-reanimated') return { useSharedValue: (value) => ({ value }), setGestureState: (...args) => {
      assert.equal(thread, 'ui'); states.push(args);
    } };
    if (name === 'react-native-worklets') return {
      scheduleOnRN: (fn, ...args) => { assert.equal(thread, 'ui'); rn.push(() => fn(...args)); },
      scheduleOnUI: (fn, ...args) => { assert.equal(thread, 'rn'); ui.push(() => fn(...args)); },
    };
    if (name === './timeline-native-pan') return native;
    throw new Error(name);
  } });
  const scrolls = exports.createTimelineNativeScrollGestures();
  exports.TimelineNativeGestureContext.value = scrolls;
  exports.TimelineNativeGeometryContext.value = geometry;
  const scope = { ...hooks, exports: {}, require: () => ({ jsx, jsxs: jsx }),
    PanResponder: { create: (panHandlers) => ({ panHandlers }) }, View: 'View',
    TimelineGestureGeometryContext: exports.TimelineNativeGeometryContext,
    TimelineNativeGestureView: exports.TimelineNativeGestureView,
    timelineTouchIntent: (dx, dy) => Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx) * 1.5 ? 'vertical' : 'pending' };
  runInNewContext(compile('export ' + trackSource), scope);
  const track = scope.exports.TimelineTrackHandle({ label: 'TEXT', disabled,
    onStart: () => onRN('start'), onMove: (...args) => onRN('move', ...args),
    onFinish: (...args) => onRN('finish', ...args), onAccessibleMove: (...args) => onRN('accessible', ...args) });
  if (axis === undefined) {
    if (track.type === exports.TimelineNativeGestureView) track.type(track.props);
  } else exports.TimelineNativeGestureView({ panHandlers: {}, nativeCallbacks: {
    axis, holdMilliseconds, begin: (...args) => onRN('begin', ...args), move: (...args) => onRN('move', ...args),
    finish: () => onRN('finish'), cancel: () => onRN('cancel'),
  } });
  const cleanups = effects.map((setup) => setup()).filter(Boolean);
  const manager = { activate() { assert.equal(thread, 'ui'); calls.push(['activate']); },
    fail() { assert.equal(thread, 'ui'); calls.push(['fail']); } };
  const event = (dx = 0, dy = 0, count = 1) => ({ handlerTag: 42, absoluteX: 100 + dx,
    absoluteY: 200 + dy, numberOfPointers: count, translationX: 0, translationY: 0 });
  const touch = (dx = 0, dy = 0, count = 1) => ({ handlerTag: 42, numberOfTouches: count, allTouches: [event(dx, dy)] });
  const invoke = (name, ...args) => runUI(() => {
    assert.equal(config.runOnJS?.[0], false, 'track recognition must run on UI');
    assert.equal(typeof handlers[name], 'function', 'track grab must install a native recognizer');
    handlers[name](...args);
  });
  const flushRN = () => { while (rn.length) rn.shift()(); };
  const flushUI = () => { while (ui.length) runUI(ui.shift()); };
  const down = () => invoke('onTouchesDown', touch(), manager);
  const start = () => { down(); invoke('onTouchesMove', touch(0, 9), manager); invoke('onStart', event(0, 9)); };
  const end = (dy = 40, success = true) => { invoke('onEnd', event(0, dy), success); invoke('onFinalize'); };
  return { config, calls, states, scrolls, geometry, track, invoke, event, touch, manager, flushRN, flushUI, down, start, end,
    unmount: () => cleanups.forEach((cleanup) => cleanup()) };
}

test('track grab owns vertical native intent before RN delivery and blocks the label scroll', () => {
  const f = fixture(); f.down();
  assert.equal(f.scrolls.length, 3, 'fixed labels need their own native scroll recognizer');
  assert.deepEqual(f.config.blocksExternalGesture, Array.from(f.scrolls));
  f.invoke('onTouchesMove', f.touch(0, 8), f.manager);
  f.invoke('onTouchesMove', f.touch(12, 11), f.manager);
  assert.deepEqual(f.calls, []);
  f.invoke('onTouchesMove', f.touch(0, 9), f.manager);
  assert.deepEqual(f.calls, [['activate']]);
  f.invoke('onStart', f.event(0, 9)); f.flushRN();
  assert.deepEqual(f.calls.slice(-2), [['start'], ['move', 9, 209]]);
  f.invoke('onUpdate', f.event(0, 20)); f.end(45); f.flushRN();
  assert.deepEqual(f.calls.slice(-3), [['move', 20, 220], ['move', 45, 245], ['finish', false]]);
});

test('native label scroll is attached without changing its ref or scroll contract', () => {
  const labels = [];
  function visit(node) { if (ts.isJsxOpeningElement(node) && node.attributes.properties.some((p) => p.name?.text === 'testID' && p.initializer?.text === 'timeline-track-labels')) labels.push(node); ts.forEachChild(node, visit); }
  visit(ast);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].tagName.getText(ast), 'TimelineNativeScrollView');
  assert.ok(labels[0].attributes.properties.some((p) => p.name?.text === 'nativeGesture' && p.initializer.expression.getText(ast) === 'nativeScrollGestures[2]'));
});

for (const reason of ['failure', 'touch-cancel', 'second-finger', 'invalid-release', 'finalize']) test(`${reason}: cancels once, releases ownership and recovers`, () => {
  const f = fixture(); f.start(); f.flushRN();
  if (reason === 'failure') f.end(20, false);
  if (reason === 'touch-cancel') f.invoke('onTouchesCancelled', f.touch(), f.manager);
  if (reason === 'second-finger') f.invoke('onTouchesMove', f.touch(0, 20, 2), f.manager);
  if (reason === 'invalid-release') f.end(NaN);
  if (reason === 'finalize') f.invoke('onFinalize');
  f.end(); f.flushRN();
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'finish'), [['finish', true]]);
  f.start(); f.end(); f.flushRN();
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'finish'), [['finish', true], ['finish', false]]);
});

for (const stage of ['pending', 'queued-start', 'active']) test(`${stage}: geometry epoch rejects stale release and allows a fresh grab`, () => {
  const f = fixture(); if (stage === 'pending') f.down(); else f.start();
  if (stage === 'active') f.flushRN();
  f.geometry.update({ viewportWidth: 600 }); f.flushRN(); f.flushUI(); f.end(); f.flushRN();
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'finish'), stage === 'active' ? [['finish', true]] : []);
  assert.deepEqual(f.states, [[42, stage === 'pending' ? 1 : 3]]);
  f.start(); f.end(); f.flushRN();
  assert.equal(f.calls.filter(([kind, cancelled]) => kind === 'finish' && !cancelled).length, 1);
});

for (const delivered of [false, true]) test(`unmount with ${delivered ? 'active' : 'queued'} grab rejects late delivery`, () => {
  const f = fixture(); f.start(); if (delivered) f.flushRN();
  f.unmount(); f.flushUI(); f.end(); f.flushRN();
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'finish'), delivered ? [['finish', true]] : []);
});

test('disabled handle preserves geometry and accessibility while disabling native recognition', () => {
  const f = fixture({ disabled: true });
  assert.deepEqual(f.config.enabled, [false]);
  assert.equal(f.track.props.hitSlop, 10);
  assert.equal(f.track.props.style.width, 24);
  assert.equal(f.track.props.style.minHeight, 44);
  assert.equal(f.track.props.accessibilityLabel, 'Reorder TEXT track');
  f.track.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } });
  assert.deepEqual(f.calls, []);
});

test('horizontal item keeps yielding vertical intent even after a video hold', () => {
  const f = fixture({ axis: 'horizontal', holdMilliseconds: 350 }); f.down();
  f.invoke('onTouchesMove', f.touch(0, 20), f.manager);
  f.invoke('onTouchesMove', f.touch(80, 20), f.manager); f.invoke('onFinalize'); f.flushRN();
  assert.deepEqual(f.calls, [['fail']]);
});

test('horizontal movement on a track fails and a tap never starts reorder', () => {
  const f = fixture(); f.down(); f.invoke('onTouchesMove', f.touch(20, 0), f.manager); f.invoke('onFinalize'); f.flushRN();
  assert.deepEqual(f.calls, [['fail']]);
  f.down(); f.invoke('onFinalize'); f.flushRN();
  assert.deepEqual(f.calls, [['fail']]);
});
