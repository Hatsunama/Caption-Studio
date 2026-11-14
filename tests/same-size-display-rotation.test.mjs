import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { mountedWrapper } from './timeline-native-thread-lifecycle.test.mjs';
import { createTimelineTimingGesture } from '../src/lib/timeline-gesture.ts';

const requireLocal = createRequire(import.meta.url);
const rotation = { name: 'landscape-primary', rotationDegrees: -90, isLandscape: true };
// Native ROTATION_270 -> ROTATION_90: identical dimensions, changed page origin.
function emitter() {
  const listeners = new Map();
  return {
    addListener(name, fn) {
      const set = listeners.get(name) ?? new Set(); listeners.set(name, set); set.add(fn);
      return { remove: () => set.delete(fn) };
    },
    emit(name, value) { for (const fn of [...(listeners.get(name) ?? [])]) fn(value); },
    snapshot() { return [...(listeners.get('namedOrientationDidChange') ?? [])]; },
  };
}

// Mount production hooks in the same VM style as the existing preview audit.
// Effects execute at commit, never during render; replay retains hook state.
function mountRuntime(events) {
  const slots = [], pending = [], cache = new Map();
  let cursor = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
    useState(value) {
      const i = cursor++; slots[i] ??= { value: typeof value === 'function' ? value() : value };
      return [slots[i].value, next => { slots[i].value = typeof next === 'function' ? next(slots[i].value) : next; }];
    },
    useMemo(factory, deps) {
      const i = cursor++;
      if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, value: factory() };
      return slots[i].value;
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(setup, deps) {
      const i = cursor++;
      if (!slots[i] || !same(slots[i].deps, deps)) pending.push(() => {
        slots[i]?.cleanup?.(); slots[i] = { deps, setup, cleanup: setup() };
      });
    },
  };
  react.useLayoutEffect = react.useEffect;
  function load(path) {
    if (cache.has(path)) return cache.get(path);
    const exports = {}; cache.set(path, exports);
    // Let the baseline run without the proposed hook and fail on stale behavior.
    if (!existsSync(new URL(path, import.meta.url))) return { useDisplayRotationInvalidation() {} };
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    runInNewContext(ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    } }).outputText, { exports, require(name) {
      if (name === 'react') return react;
      if (name === 'react-native') return { DeviceEventEmitter: events };
      if (name.startsWith('@/hooks/')) return load('../src/hooks/' + name.slice(8) + '.ts');
      if (name.startsWith('@/lib/')) return requireLocal('../src/lib/' + name.slice(6) + '.ts');
      throw new Error(name);
    } });
    return exports;
  }
  return { react, load,
    render(fn, commit = true) { cursor = 0; const value = fn(); if (commit) this.commit(); return value; },
    commit() { pending.splice(0).forEach(fn => fn()); },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); },
    replay() { slots.forEach(slot => { if (slot?.setup) slot.cleanup = slot.setup(); }); },
  };
}

function mountTimeline(f, events) {
  const runtime = mountRuntime(events);
  const { useDisplayRotationInvalidation } = runtime.load('../src/hooks/use-display-rotation-invalidation.ts');
  const source = readFileSync(new URL('../src/components/editor/layer-timeline.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('timeline.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const parent = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'LayerTimeline');
  const binding = parent.body.statements.find(n => ts.isExpressionStatement(n)
    && ts.isCallExpression(n.expression) && n.expression.expression.getText(ast) === 'useDisplayRotationInvalidation');
  const refs = { invalidatedScrollTouchRef: { current: false }, scrubEndTimer: { current: null },
    scrubbingRef: { current: true }, selectionOwnsViewportRef: { current: true }, pinch: { current: { distance: 100 } } };
  const run = new Function('useDisplayRotationInvalidation', 'useCallback', 'gestureGeometry', ...Object.keys(refs),
    binding ? binding.getText(ast) : '');
  runtime.render(() => run(useDisplayRotationInvalidation, runtime.react.useCallback, f.geometry, ...Object.values(refs)));
  return { runtime, refs };
}

for (const stage of ['pending', 'queued-begin', 'active', 'queued-finish']) {
  test(`same-size 180 display rotation rejects ${stage} RN/UI work and preserves live prefix`, () => {
    const events = emitter(), gesture = createTimelineTimingGesture();
    const changes = []; let commits = 0, cancelled = 0;
    const owner = { startMs: 1000, endMs: 2000, durationMs: 5000, trackWidth: 1000,
      onPress() {}, onChangeStart() {}, onChange: (...args) => changes.push(args),
      onEnd() { commits++; }, onCancel() { cancelled++; } };
    const f = mountedWrapper({ callbackOverrides: {
      begin(dx, dy) { gesture.begin(owner, 'move'); gesture.move(dx, dy); },
      move(dx, dy) { gesture.move(dx, dy); }, finish() { gesture.finish(); }, cancel() { gesture.cancel(); },
    } });
    const parent = mountTimeline(f, events);
    if (stage === 'pending') f.down(); else f.start();
    if (stage === 'active' || stage === 'queued-finish') { f.flushRN(); f.update(); f.flushRN(); }
    if (stage === 'queued-finish') f.finish();
    const prefix = structuredClone(changes);
    events.emit('namedOrientationDidChange', rotation); f.setOrigin(178);
    f.update(); f.finish(); f.flushRN(); f.flushLastUI(); f.flushUI();
    assert.deepEqual(changes, prefix, 'rotation retains live edits but rejects the old coordinate suffix');
    assert.equal(commits, 0, 'stale release cannot commit');
    assert.equal(cancelled, prefix.length ? 1 : 0);
    assert.equal(parent.refs.pinch.current.distance, 0);
    assert.equal(parent.refs.invalidatedScrollTouchRef.current, true);
    assert.equal(f.geometry.update({ viewportWidth: 360, scale: 16 }), false);
    f.start(); f.update(); f.finish(); f.flushRN();
    assert.equal(commits, 1, 'fresh contact works with unchanged geometry');
    parent.runtime.unmount(); f.unmount(); f.flushUI();
  });
}

test('hook subscribes at commit, cleans up/replays, and rejects saved removed listeners', () => {
  const events = emitter(), runtime = mountRuntime(events);
  const { useDisplayRotationInvalidation: hook } = runtime.load('../src/hooks/use-display-rotation-invalidation.ts');
  let calls = 0; const callback = () => calls++;
  runtime.render(() => hook(callback), false);
  assert.equal(events.snapshot().length, 0);
  runtime.commit(); assert.equal(events.snapshot().length, 1);
  const old = events.snapshot(); runtime.unmount(); runtime.replay();
  old.forEach(fn => fn(rotation)); assert.equal(calls, 0);
  events.emit('didUpdateDimensions', { window: { width: 360, height: 720 } });
  assert.equal(calls, 0, 'unrelated duplicate dimensions are a no-op');
  events.emit('namedOrientationDidChange', rotation); assert.equal(calls, 1);
  const replaced = events.snapshot(); let newCalls = 0;
  runtime.render(() => hook(() => newCalls++), false);
  events.emit('namedOrientationDidChange', rotation); assert.equal(calls, 2);
  assert.equal(newCalls, 0, 'render cannot publish an uncommitted callback');
  runtime.commit(); replaced.forEach(fn => fn(rotation)); assert.equal(calls, 2);
  events.emit('namedOrientationDidChange', rotation); assert.equal(newCalls, 1);
  runtime.unmount(); events.emit('namedOrientationDidChange', rotation);
  assert.equal(events.snapshot().length, 0); assert.equal(calls, 2); assert.equal(newCalls, 1);
});

test('duplicate dimensions preserve an active edit; replay rejects removed rotation listener', () => {
  const events = emitter(), f = mountedWrapper(), parent = mountTimeline(f, events);
  f.start(); f.flushRN();
  events.emit('didUpdateDimensions', { window: { width: 360, height: 720 } });
  assert.equal(f.geometry.update({ viewportWidth: 360, scale: 16 }), false);
  f.update(); f.finish(); f.flushRN();
  assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, 0);
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 1);
  const stale = events.snapshot(); parent.runtime.unmount(); parent.runtime.replay();
  f.start(); f.flushRN(); stale.forEach(fn => fn(rotation)); f.finish(); f.flushRN();
  assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, 0);
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 2);
  parent.runtime.unmount(); f.unmount(); f.flushUI();
});

test('rotation cannot reopen blur/background timeline ownership', () => {
  const events = emitter(), listeners = new Map();
  const appState = { currentState: 'active', addEventListener(kind, fn) {
    listeners.set(kind, fn); return { remove: () => listeners.delete(kind) };
  } };
  const f = mountedWrapper({ appState }), parent = mountTimeline(f, events);
  f.start(); f.flushRN(); listeners.get('blur')(); listeners.get('change')('background');
  events.emit('namedOrientationDidChange', rotation); f.flushLastUI(); f.flushUI();
  f.start(); f.finish(); f.flushRN();
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 0);
  listeners.get('change')('active'); listeners.get('focus')(); f.flushUI();
  f.start(); f.finish(); f.flushRN();
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 1);
  parent.runtime.unmount(); f.unmount(); f.flushUI();
});

test('preview rotation cancels draft, rejects old measurement and release, and allows fresh origin', () => {
  const events = emitter(), runtime = mountRuntime(events);
  const { usePreviewSceneGesture } = runtime.load('../src/hooks/use-preview-scene-gesture.ts');
  const geometry = { position: { x: 0.5, y: 0.5 }, box: { width: 0.4, height: 0.4 }, rotation: 0, scale: 1 };
  const stored = structuredClone(geometry), changes = []; let ends = 0, measure;
  const options = { enabled: true, selectedKey: 'item', targets: [{ key: 'item', selection: 'item', geometry, order: 1 }],
    onSelect() {}, onClearSelection() {}, onDelete() {}, onInteractionStart() {},
    onInteractionEnd() { ends++; }, onChange: (_, value) => changes.push(value) };
  const scene = runtime.render(() => usePreviewSceneGesture(options));
  scene.canvasRef.current = { measureInWindow(fn) { measure = fn; } };
  scene.onLayout({ nativeEvent: { layout: { width: 400, height: 300 } } });
  const event = (x, pageX = 73, withOrigin = true) => ({ nativeEvent: {
    ...(withOrigin ? { pageX: pageX + x, pageY: 299, locationX: x, locationY: 150 } : {}),
    touches: [{ identifier: 1, pageX: pageX + x, pageY: 299 }], changedTouches: [], identifier: 1,
  } });
  scene.responders.onResponderGrant(event(200)); scene.responders.onResponderMove(event(230));
  events.emit('didUpdateDimensions', { window: { width: 400, height: 300 } });
  assert.equal(ends, 0, 'duplicate dimensions do not cancel the preview');
  events.emit('namedOrientationDidChange', rotation);
  assert.equal(ends, 1, 'active preview is cancelled immediately');
  measure(73, 149); // Old asynchronous measure must not restore the old origin.
  scene.responders.onResponderMove(event(300, 151)); scene.responders.onResponderRelease();
  assert.equal(changes.length, 0); assert.deepEqual(geometry, stored);
  scene.responders.onResponderGrant(event(200, 151, false));
  scene.responders.onResponderMove(event(230, 151, false)); scene.responders.onResponderRelease();
  assert.equal(changes.length, 0, 'cleared fallback cannot acquire with stale measurement');
  scene.responders.onResponderGrant(event(200, 151)); scene.responders.onResponderMove(event(230, 151));
  scene.responders.onResponderRelease(); assert.equal(changes.length, 1);
  assert.equal(changes[0].position.x, 0.575); assert.deepEqual(geometry, stored);
  scene.onLayout({ nativeEvent: { layout: { width: 400, height: 300 } } });
  runtime.unmount(); runtime.replay(); measure(73, 149);
  scene.responders.onResponderGrant(event(200, 151, false));
  scene.responders.onResponderMove(event(230, 151, false)); scene.responders.onResponderRelease();
  assert.equal(changes.length, 1, 'a pre-unmount measurement cannot repopulate the fallback after replay');
  runtime.render(() => usePreviewSceneGesture({ ...options, enabled: false }));
  events.emit('namedOrientationDidChange', rotation);
  scene.responders.onResponderGrant(event(200, 151)); scene.responders.onResponderMove(event(230, 151));
  scene.responders.onResponderRelease(); assert.equal(changes.length, 1, 'rotation cannot reopen a disabled preview');
  runtime.unmount(); assert.equal(events.snapshot().length, 0);
});
