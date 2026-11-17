import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createTimelineNativePan, createTimelineNativePanDelivery, initialTimelineNativePanState } from '../src/components/editor/timeline-native-pan.ts';

function fixture({ axis, holdAxis, holdMilliseconds = 350, recordBegin = false } = {}) {
  const handlers = {}, config = {}, calls = [];
  const pan = {};
  for (const name of ['manualActivation', 'runOnJS', 'maxPointers', 'blocksExternalGesture']) {
    pan[name] = (...args) => { config[name] = args; return pan; };
  }
  for (const name of ['onTouchesDown', 'onTouchesMove', 'onTouchesCancelled', 'onTouchesUp', 'onStart', 'onUpdate', 'onEnd', 'onFinalize']) {
    pan[name] = (callback) => { handlers[name] = callback; return pan; };
  }
  const state = { value: initialTimelineNativePanState() };
  const scrolls = [{ id: 'horizontal' }, { id: 'vertical' }];
  const callbacks = {
    axis, holdAxis, prepare: () => calls.push(['prepare']), holdMilliseconds,
    begin: (...args) => calls.push(['begin', ...(recordBegin ? args : args.slice(0, 2))]), move: (...args) => calls.push(['move', ...args]),
    finish: () => calls.push(['finish']), cancel: () => calls.push(['cancel']),
  };
  createTimelineNativePan(pan, callbacks, scrolls, { state,
    deliver: createTimelineNativePanDelivery(callbacks).dispatch, schedule: (fn, ...args) => fn(...args) });
  const manager = { activate: () => calls.push(['activate']), fail: () => calls.push(['fail']) };
  const touch = (dx = 0, dy = 0, numberOfTouches = 1) => ({
    handlerTag: 42, numberOfTouches, allTouches: [{ absoluteX: 100 + dx, absoluteY: 200 + dy }],
  });
  handlers.onTouchesDown(touch(), manager);
  const event = (dx, dy = 0, numberOfPointers = 1) => ({ absoluteX: 100 + dx, absoluteY: 200 + dy, translationX: 0, translationY: 0, numberOfPointers });
  return { handlers, config, calls, scrolls, manager, touch, event,
    arm(milliseconds = 400) { state.value = { ...state.value, startedAt: Date.now() - milliseconds }; } };
}

test('overlay hold requires vertical intent, then delivers reorder to the existing begin', (t) => {
  t.mock.method(Date, 'now', () => 1000);
  const f = fixture({ holdAxis: 'vertical', recordBegin: true });
  f.arm(350);
  f.handlers.onTouchesMove(f.touch(0, 1), f.manager);
  f.handlers.onTouchesMove(f.touch(7, 7), f.manager);
  assert.deepEqual(f.calls, [['prepare']], 'elapsed hold alone or jitter cannot acquire');
  f.handlers.onTouchesMove(f.touch(1, 20), f.manager);
  f.handlers.onStart(f.event(1, 20));
  assert.deepEqual(f.calls, [['prepare'], ['activate'], ['begin', 1, 20, true, 220]]);
});

test('quick overlay vertical intent yields for the entire stream, even after the hold', (t) => {
  t.mock.method(Date, 'now', () => 1000);
  const f = fixture({ holdAxis: 'vertical', recordBegin: true });
  f.arm(349);
  f.handlers.onTouchesMove(f.touch(0, 20), f.manager);
  f.arm(800);
  f.handlers.onTouchesMove(f.touch(0, 40), f.manager);
  f.handlers.onTouchesMove(f.touch(60, 0), f.manager);
  f.handlers.onStart(f.event(0, 40));
  f.handlers.onUpdate(f.event(0, 50));
  f.handlers.onEnd(f.event(0, 60), true);
  f.handlers.onFinalize();
  assert.deepEqual(f.calls, [['prepare'], ['fail']]);
});

for (const elapsed of [0, 350, 700]) {
  test(`overlay horizontal timing remains ordinary after ${elapsed}ms`, (t) => {
    t.mock.method(Date, 'now', () => 1000);
    const f = fixture({ holdAxis: 'vertical', recordBegin: true });
    f.arm(elapsed);
    f.handlers.onTouchesMove(f.touch(20, 1), f.manager);
    f.handlers.onStart(f.event(20, 1));
    f.handlers.onEnd(f.event(20, 1), true); f.handlers.onFinalize();
    assert.deepEqual(f.calls, [['prepare'], ['activate'], ['begin', 20, 1, false, 201], ['finish']]);
  });
}

for (const stage of ['pending', 'recognized', 'active']) {
  test(`second finger cancels overlay ${stage} acquisition without committing`, (t) => {
    t.mock.method(Date, 'now', () => 1000);
    const f = fixture({ holdAxis: 'vertical', recordBegin: true }); f.arm(350);
    assert.deepEqual(f.config.maxPointers, [1]);
    if (stage !== 'pending') f.handlers.onTouchesMove(f.touch(0, 20), f.manager);
    if (stage === 'active') f.handlers.onStart(f.event(0, 20));
    f.handlers.onTouchesDown(f.touch(0, 20, 2), f.manager);
    f.handlers.onStart(f.event(0, 30));
    f.handlers.onUpdate(f.event(0, 40, 2));
    f.handlers.onEnd(f.event(0, 50), true); f.handlers.onFinalize();
    assert.equal(f.calls.filter(([kind]) => kind === 'activate').length, stage === 'pending' ? 0 : 1);
    assert.equal(f.calls.filter(([kind]) => kind === 'begin').length, stage === 'active' ? 1 : 0);
    assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, stage === 'active' ? 1 : 0);
    assert.ok(!f.calls.some(([kind]) => kind === 'finish' || kind === 'move'));
    assert.equal(f.calls.at(-1)[0], 'fail');
  });
}

test('overlay reorder delivers the release sample before finishing exactly once', (t) => {
  t.mock.method(Date, 'now', () => 1000);
  const f = fixture({ holdAxis: 'vertical', recordBegin: true }); f.arm(350);
  f.handlers.onTouchesMove(f.touch(1, 20), f.manager);
  f.handlers.onStart(f.event(1, 20));
  f.handlers.onUpdate(f.event(2, 30));
  f.handlers.onEnd(f.event(3, 45), true); f.handlers.onFinalize();
  f.handlers.onEnd(f.event(3, 45), true); f.handlers.onFinalize();
  assert.deepEqual(f.calls, [['prepare'], ['activate'], ['begin', 1, 20, true, 220],
    ['move', 2, 30, 1, 230], ['move', 3, 45, 1, 245], ['finish']]);
});

for (const holdAxis of [undefined, 'horizontal']) {
  for (const [dx, dy, elapsed, reorder] of [[0, 1, 350, true], [20, 0, 350, true], [20, 0, 0, false]]) {
    test(`main clip holdAxis=${holdAxis}: (${dx},${dy}) at ${elapsed}ms preserves reorder=${reorder}`, (t) => {
      t.mock.method(Date, 'now', () => 1000);
      const f = fixture({ holdAxis, recordBegin: true }); f.arm(elapsed);
      f.handlers.onTouchesMove(f.touch(dx, dy), f.manager);
      f.handlers.onStart(f.event(dx, dy));
      assert.deepEqual(f.calls, [['prepare'], ['activate'], ['begin', dx, dy, reorder]]);
    });
  }
}

test('vertical handles still acquire immediately without reorder after a long hold', (t) => {
  t.mock.method(Date, 'now', () => 1000);
  const f = fixture({ axis: 'vertical', recordBegin: true }); f.arm(700);
  f.handlers.onTouchesMove(f.touch(0, 9), f.manager);
  f.handlers.onStart(f.event(0, 9));
  assert.deepEqual(f.calls, [['prepare'], ['activate'], ['begin', 0, 9, false, 209]]);
});

test('both native scroll recognizers wait for the shared directional decision', () => {
  const f = fixture();
  assert.deepEqual(f.config.blocksExternalGesture, f.scrolls);
  assert.deepEqual(f.config.manualActivation, [true]);
  assert.deepEqual(f.config.runOnJS, [false]);
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
  assert.deepEqual(f.calls, [['prepare'], ['fail']]);
});

test('native displacement reaches the existing timing lifecycle exactly once', () => {
  const f = fixture();
  f.handlers.onTouchesMove(f.touch(20, 0), f.manager);
  f.handlers.onStart(f.event(20));
  f.handlers.onUpdate(f.event(35, 1));
  f.handlers.onEnd(f.event(35, 1), true); f.handlers.onFinalize();
  assert.deepEqual(f.calls, [['prepare'], ['activate'], ['begin', 20, 0], ['move', 35, 1, 1], ['finish']]);
});

for (const stage of ['pending', 'active']) {
  test(`a second finger cancels ${stage} work without committing`, () => {
    const f = fixture();
    if (stage === 'active') { f.handlers.onTouchesMove(f.touch(20), f.manager); f.handlers.onStart(f.event(20)); }
    f.handlers.onTouchesMove(f.touch(30, 0, 2), f.manager);
    f.handlers.onUpdate(f.event(40, 0, 2));
    f.handlers.onEnd(f.event(40), true); f.handlers.onFinalize();
    assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, stage === 'active' ? 1 : 0);
    assert.ok(!f.calls.some(([kind]) => kind === 'finish' || kind === 'move'));
  });
}

test('native termination cancels once, then the same recognizer accepts a fresh touch', () => {
  const f = fixture();
  f.handlers.onTouchesMove(f.touch(20), f.manager); f.handlers.onStart(f.event(20));
  f.handlers.onEnd(f.event(20), false); f.handlers.onFinalize();
  f.handlers.onTouchesDown(f.touch(), f.manager);
  f.handlers.onTouchesMove(f.touch(-20, 0), f.manager);
  f.handlers.onStart(f.event(-20));
  f.handlers.onEnd(f.event(-20), true); f.handlers.onFinalize();
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
        useState: (initialize) => [initialize()], useEffect() {} };
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === '@/components/spring-scroll-view') return { SpringScrollView: 'SpringScrollView' };
      if (name === 'react-native') return { Platform: { OS: platform }, View: 'View', ScrollView: 'ScrollView' };
      if (name === 'react-native-gesture-handler') return { Gesture: { Native: () => ({ native: true,
        disallowInterruption() { return this; }, shouldCancelWhenOutside() { return this; },
      }) }, GestureDetector: 'GestureDetector' };
      if (name === 'react-native-reanimated') return { useSharedValue: (value) => ({ value }), setGestureState() {} };
      if (name === 'react-native-worklets') return { scheduleOnRN: (fn, ...args) => fn(...args), scheduleOnUI: (fn, ...args) => fn(...args) };
      if (name === './timeline-native-pan') return { createTimelineNativePan, createTimelineNativePanDelivery, initialTimelineNativePanState };
      throw new Error(name);
    } });
    const scrolls = exports.createTimelineNativeScrollGestures();
    const ref = { current: null }, onScroll = () => {};
    const style = { flex: 1 }, child = { fixture: true };
    const tree = exports.TimelineNativeScrollView({ ref, style, onScroll, scrollEnabled: true,
      accessibilityLabel: 'Timeline', nativeGesture: scrolls[0], children: child });
    // Native recognizer ownership now belongs to the shared adapter; its
    // actual RN forwarding and cancellation are tested in spring-scroll-view.
    const view = tree;
    assert.equal(view.type, 'SpringScrollView');
    assert.equal(view.props.ref, ref);
    assert.equal(view.props.style, style);
    assert.equal(view.props.onScroll, onScroll);
    assert.equal(view.props.scrollEnabled, true);
    assert.equal(view.props.accessibilityLabel, 'Timeline');
    assert.equal(view.props.children, child);
    assert.equal(view.props.nativeGesture, scrolls[0]);
    assert.equal(tree.type, 'SpringScrollView');
  });
}


test('vertical moves retain absolute pageY and finish once after the final sample', () => {
  const f = fixture({ axis: 'vertical' });
  f.handlers.onTouchesMove(f.touch(0, 9), f.manager);
  f.handlers.onStart(f.event(0, 9));
  f.handlers.onUpdate(f.event(0, 15));
  f.handlers.onEnd(f.event(0, 20), true); f.handlers.onFinalize();
  f.handlers.onEnd(f.event(0, 20), true); f.handlers.onFinalize();
  // begin's existing test callback only records dx/dy; move records pageY too.
  assert.deepEqual(f.calls, [['prepare'], ['activate'], ['begin', 0, 9],
    ['move', 0, 15, 1, 215], ['move', 0, 20, 1, 220], ['finish']]);
});

test('held vertical body delivery retains actual absolute pointer coordinates', () => {
  const f = fixture({ holdAxis: 'vertical', recordBegin: true }); f.arm(400);
  f.handlers.onTouchesMove(f.touch(1, 20), f.manager); f.handlers.onStart(f.event(1, 20));
  f.handlers.onUpdate(f.event(2, 30)); f.handlers.onEnd(f.event(3, 45), true);
  assert.deepEqual(f.calls, [['prepare'], ['activate'], ['begin', 1, 20, true, 220],
    ['move', 2, 30, 1, 230], ['move', 3, 45, 1, 245], ['finish']]);
});
