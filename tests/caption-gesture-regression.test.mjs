import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const requireLocal = createRequire(import.meta.url);
const componentPath = 'components/editor/layer-timeline.tsx';
const exportsSuffix = '\nexports.TimedBlock = TimedBlock; exports.DirectTimelineGestureSurface = DirectTimelineGestureSurface; exports.TimelineTimingGrip = TimelineTimingGrip;';

function harness() {
  const slots = [];
  let cursor = 0;
  let result;
  const same = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const react = {
    Fragment: 'Fragment',
    useMemo(factory, deps) { const index = cursor++; if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { deps, value: factory() }; return slots[index].value; },
    useRef(value) { const index = cursor++; slots[index] ??= { current: value }; return slots[index]; },
    useEffect() { cursor++; },
    useState(value) { const index = cursor++; slots[index] ??= { value }; return [slots[index].value, () => {}]; },
    useCallback(fn) { cursor++; return fn; },
  };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const source = readFileSync(new URL('../src/' + componentPath, import.meta.url), 'utf8');
  const output = ts.transpileModule(source + exportsSuffix, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    fileName: componentPath,
  }).outputText;
  const exports = {};
  runInNewContext(output, {
    exports, setTimeout() { return 0; }, clearTimeout() {}, requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === 'react-native') return { View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView', PanResponder: { create: (handlers) => ({ panHandlers: handlers }) } };
      if (name === 'expo-image') return { Image: 'Image' };
      if (name.startsWith('@/services/')) return {};
      if (name.startsWith('@/lib/')) return requireLocal('../src/lib/' + name.slice(6) + '.ts');
      throw new Error('Unexpected module: ' + name);
    },
  });
  function all(predicate, node, found = []) {
    if (arguments.length < 2) node = result;
    if (Array.isArray(node)) node.forEach((child) => all(predicate, child, found));
    else if (node && typeof node === 'object') {
      if (predicate(node)) found.push(node);
      all(predicate, node.props?.children, found);
    }
    return found;
  }
  return { ui: exports, render(component, props) { cursor = 0; result = component(props); return result; }, all, get result() { return result; } };
}

function item(overrides = {}) {
  return { label: 'Timeline item', startMs: 1000, endMs: 1080, durationMs: 5000, trackWidth: 1000,
    lane: 0, color: '#00B8FF', selected: true, onPress() {}, onTouchLock() {}, onChangeStart() {}, onChange() {}, onEnd() {}, ...overrides };
}

function surfaceFor(props) {
  const block = harness();
  block.render(block.ui.TimedBlock, props);
  const surface = block.all((node) => node.type?.name === 'DirectTimelineGestureSurface')[0];
  assert.ok(surface, 'each timeline item renders the shared direct gesture surface');
  const direct = harness();
  direct.render(direct.ui.DirectTimelineGestureSurface, surface.props);
  return { block, direct, surface, grips: direct.all((node) => node.type?.name === 'TimelineTimingGrip') };
}

for (const kind of ['caption', 'translation', 'text', 'image', 'audio']) {
  test(`${kind} has only direct timeline box interactions`, () => {
    const { block, surface, grips } = surfaceFor(item({ label: kind, endMs: 2000 }));
    assert.equal(surface.props.width, 200, 'selected blocks retain their actual timeline width');
    assert.equal(grips.length, 3);
    assert.deepEqual(grips.map((grip) => grip.props.edge).sort(), ['end', 'move', 'start']);
    assert.equal(block.all((node) => node.props?.accessibilityLabel?.startsWith('Timing controls')).length, 0);
    assert.equal(block.all((node) => node.props?.accessibilityLabel === 'Edit cue timing').length, 0);
  });
}

test('direct box edges partition the selected item without overlap', () => {
  const { grips, surface } = surfaceFor(item({ startMs: 0, endMs: 1000 }));
  const ordered = grips.map((grip) => grip.props).sort((left, right) => left.left - right.left);
  assert.equal(ordered[0].left, 0);
  assert.equal(ordered.at(-1).left + ordered.at(-1).width, surface.props.width);
  assert.ok(ordered.filter((grip) => grip.edge !== 'move').every((grip) => grip.width >= 8 && grip.width <= 16));
  assert.equal(ordered[0].left + ordered[0].width, ordered[1].left);
  assert.equal(ordered[1].left + ordered[1].width, ordered[2].left);
});

test('unselected blocks keep a tap surface without visible trim grips', () => {
  const { grips, surface } = surfaceFor(item({ selected: false, endMs: 2000 }));
  assert.equal(surface.props.width, 200);
  assert.deepEqual(grips.map((grip) => grip.props.edge), ['move']);
  assert.equal(grips[0].props.left, 0);
  assert.equal(grips[0].props.width, 200);
});

test('a tap selects without mutating timing, while a body drag moves the same item', () => {
  const calls = [];
  const gripHarness = harness();
  const props = item({ edge: 'move', left: 32, width: 32, height: 32,
    onPress() { calls.push('select'); }, onChangeStart() { calls.push('begin'); }, onChange(...change) { calls.push(change); }, onEnd() { calls.push('end'); } });
  gripHarness.render(gripHarness.ui.TimelineTimingGrip, props);
  let handlers = gripHarness.result.props;
  handlers.onPanResponderGrant();
  handlers.onPanResponderRelease();
  assert.deepEqual(calls, ['select']);
  handlers.onPanResponderGrant();
  handlers.onPanResponderMove({ nativeEvent: { touches: [{}] } }, { dx: 16, dy: 0 });
  handlers.onPanResponderRelease();
  assert.equal(calls[1], 'select');
  assert.equal(calls[2], 'begin');
  assert.equal(calls[3][0], 'move');
  assert.equal(calls[4], 'end');
});

test('the timeline source contains no attached timing buttons, rails, or alternate cue editor', () => {
  const source = readFileSync(new URL('../src/components/editor/layer-timeline.tsx', import.meta.url), 'utf8');
  for (const forbidden of ['Magnified cue timing', 'Edit cue timing', 'CaptionMagnifier', 'timelineControlRail', 'timelineBlockControls', 'TimelineMoveGrip', 'TimingGrip side']) {
    assert.equal(source.includes(forbidden), false, forbidden + ' must not return');
  }
  assert.match(source, /<DirectTimelineGestureSurface/);
  assert.match(source, /timelineHandleLayout\(props\.selected, props\.width\)/);
});
