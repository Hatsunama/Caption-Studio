import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createTimelineNativePan } from '../src/lib/timeline-native-pan.ts';

function fixture() {
  const handlers = {}, config = {}, calls = [];
  const pan = {};
  for (const name of ['manualActivation', 'runOnJS', 'maxPointers', 'blocksExternalGesture']) {
    pan[name] = (...args) => { config[name] = args; return pan; };
  }
  for (const name of ['onTouchesDown', 'onTouchesMove', 'onStart', 'onUpdate', 'onEnd', 'onFinalize']) {
    pan[name] = (callback) => { handlers[name] = callback; return pan; };
  }
  let armed = false;
  const scrolls = [{ id: 'horizontal' }, { id: 'vertical' }];
  createTimelineNativePan(pan, {
    prepare: () => calls.push(['prepare']), shouldActivate: () => armed,
    begin: (...args) => calls.push(['begin', ...args]), move: (...args) => calls.push(['move', ...args]),
    finish: () => calls.push(['finish']), cancel: () => calls.push(['cancel']),
  }, scrolls);
  const manager = { activate: () => calls.push(['activate']), fail: () => calls.push(['fail']) };
  const touch = (dx = 0, dy = 0, numberOfTouches = 1) => ({
    numberOfTouches, allTouches: [{ absoluteX: 100 + dx, absoluteY: 200 + dy }],
  });
  handlers.onTouchesDown(touch(), manager);
  return { handlers, config, calls, scrolls, manager, touch, arm() { armed = true; } };
}

test('both native scroll recognizers wait for the shared directional decision', () => {
  const f = fixture();
  assert.deepEqual(f.config.blocksExternalGesture, f.scrolls);
  assert.deepEqual(f.config.manualActivation, [true]);
  assert.deepEqual(f.config.runOnJS, [true]);
  f.handlers.onTouchesMove(f.touch(8, 0), f.manager);
  f.handlers.onTouchesMove(f.touch(12, 11), f.manager);
  assert.deepEqual(f.calls, [['prepare']], 'jitter and diagonal movement must not edit or scroll early');
  f.handlers.onTouchesMove(f.touch(12, 8), f.manager);
  assert.deepEqual(f.calls.at(-1), ['activate']);
});

test('vertical intent fails without selecting, locking or starting history', () => {
  const f = fixture();
  f.handlers.onTouchesMove(f.touch(0, 20), f.manager);
  f.handlers.onTouchesMove(f.touch(100, 20), f.manager);
  f.handlers.onFinalize();
  assert.deepEqual(f.calls, [['prepare'], ['fail'], ['fail']]);
});

test('native displacement reaches the existing timing lifecycle exactly once', () => {
  const f = fixture();
  f.handlers.onTouchesMove(f.touch(20, 0), f.manager);
  f.handlers.onStart({ translationX: 20, translationY: 0 });
  f.handlers.onUpdate({ translationX: 35, translationY: 1, numberOfPointers: 1 });
  f.handlers.onEnd({}, true); f.handlers.onFinalize();
  assert.deepEqual(f.calls, [['prepare'], ['activate'], ['begin', 20, 0], ['move', 35, 1, 1], ['finish']]);
});

for (const stage of ['pending', 'active']) {
  test(`a second finger cancels ${stage} work without committing`, () => {
    const f = fixture();
    if (stage === 'active') f.handlers.onStart({ translationX: 20, translationY: 0 });
    f.handlers.onTouchesMove(f.touch(30, 0, 2), f.manager);
    f.handlers.onUpdate({ translationX: 40, translationY: 0, numberOfPointers: 2 });
    f.handlers.onEnd({}, true); f.handlers.onFinalize();
    assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, stage === 'active' ? 1 : 0);
    assert.ok(!f.calls.some(([kind]) => kind === 'finish' || kind === 'move'));
  });
}

test('native termination cancels once, then the same recognizer accepts a fresh touch', () => {
  const f = fixture();
  f.handlers.onStart({ translationX: 20, translationY: 0 });
  f.handlers.onEnd({}, false); f.handlers.onFinalize();
  f.handlers.onTouchesDown(f.touch(), f.manager);
  f.handlers.onTouchesMove(f.touch(-20, 0), f.manager);
  f.handlers.onStart({ translationX: -20, translationY: 0 });
  f.handlers.onEnd({}, true); f.handlers.onFinalize();
  assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'finish').length, 1);
});

test('a deliberate video hold can activate reorder without horizontal motion', () => {
  const f = fixture(); f.arm();
  f.handlers.onTouchesMove(f.touch(0, 1), f.manager);
  assert.deepEqual(f.calls, [['prepare'], ['activate']]);
});

test('unactivated tap finalization does not create a timing edit', () => {
  const f = fixture(); f.handlers.onFinalize();
  assert.deepEqual(f.calls, [['prepare']]);
});

for (const platform of ['android', 'ios', 'web']) {
  test(`${platform}: the scroll wrapper forwards the actual ref, layout, accessibility and scroll props`, () => {
    const source = readFileSync(new URL('../src/components/editor/timeline-native-gesture.tsx', import.meta.url), 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText;
    const exports = {};
    const jsx = (type, props) => ({ type, props });
    runInNewContext(output, { exports, require(name) {
      if (name === 'react') return { createContext: (value) => ({ value }), useContext: (context) => context.value,
        useState: (initialize) => [initialize()] };
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === 'react-native') return { Platform: { OS: platform }, View: 'View', ScrollView: 'ScrollView' };
      if (name === 'react-native-gesture-handler') return { Gesture: { Native: () => ({ native: true }) }, GestureDetector: 'GestureDetector' };
      if (name === '@/lib/timeline-native-pan') return { createTimelineNativePan };
      throw new Error(name);
    } });
    const scrolls = exports.createTimelineNativeScrollGestures();
    const ref = { current: null }, onScroll = () => {};
    const style = { flex: 1 }, child = { fixture: true };
    const tree = exports.TimelineNativeScrollView({ ref, style, onScroll, scrollEnabled: true,
      accessibilityLabel: 'Timeline', nativeGesture: scrolls[0], children: child });
    const view = platform === 'android' ? tree.props.children : tree;
    assert.equal(view.type, 'ScrollView');
    assert.equal(view.props.ref, ref);
    assert.equal(view.props.style, style);
    assert.equal(view.props.onScroll, onScroll);
    assert.equal(view.props.scrollEnabled, true);
    assert.equal(view.props.accessibilityLabel, 'Timeline');
    assert.equal(view.props.children, child);
    assert.equal('nativeGesture' in view.props, false);
    assert.equal(tree.type, platform === 'android' ? 'GestureDetector' : 'ScrollView');
  });
}
