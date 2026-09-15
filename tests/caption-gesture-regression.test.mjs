import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { DEFAULT_CAPTION_STYLE } from '../src/types/project.ts';
import { captionPreviewState } from '../src/lib/caption-preview.ts';
import { timelineBlockControls, timelineControlRail, timelineVisibleTrackBounds, TIMELINE_GRIP_WIDTH } from '../src/lib/timeline-gesture.ts';
import { packTimelineMarkers } from '../src/lib/timeline-layout.ts';
import { decodeVersionTwoProject, serializeProjectSnapshot } from '../src/lib/project-schema.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { createTranslationCaptionTrack, resolveCaptionPairs } from '../src/lib/caption-tracks.ts';
import { applyTimelineItemTiming } from '../src/lib/timeline-item-editor.ts';

const requireLocal = createRequire(import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));
// Reuse compilation only. Every mount still executes fresh production code in
// its own VM with independent hooks, effects, responders and native adapters.
const compiledModules = new Map();
// Execute the production hook, timeline responders and overlay JSX. Only React
// scheduling, native views and the OS event source are adapted for Node.
function harness() {
  const slots = [], frames = new Map(), timers = new Map();
  let cursor = 0, effects = [], dirty = false, result, component, props, nextId = 0;
  const depsEqual = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  function memo(factory, deps) {
    const i = cursor++;
    if (!slots[i] || !depsEqual(slots[i].deps, deps)) slots[i] = { value: factory(), deps };
    return slots[i].value;
  }
  const react = {
    useMemo: memo, useCallback: (fn, deps) => memo(() => fn, deps), memo: (fn) => fn, Fragment: 'Fragment',
    useRef: (value) => memo(() => ({ current: value }), []),
    useState(initial) {
      const i = cursor++;
      slots[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, (value) => {
        const next = typeof value === 'function' ? value(slots[i].value) : value;
        if (!Object.is(next, slots[i].value)) { slots[i].value = next; dirty = true; }
      }];
    },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !depsEqual(slots[i].deps, deps)) effects.push(() => {
        slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() };
      });
    },
  };
  const native = { View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView',
    PanResponder: { create: (handlers) => ({ panHandlers: handlers }) } };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const modules = new Map();
  function load(path, suffix = '') {
    if (modules.has(path)) return modules.get(path);
    const exports = {}; modules.set(path, exports);
    const cacheKey = path + suffix;
    let outputText = compiledModules.get(cacheKey);
    if (!outputText) {
      const source = readFileSync(new URL('../src/' + path, import.meta.url), 'utf8');
      outputText = ts.transpileModule(source + suffix, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
        fileName: path,
      }).outputText;
      compiledModules.set(cacheKey, outputText);
    }
    runInNewContext(outputText, { exports,
      requestAnimationFrame(fn) { frames.set(++nextId, fn); return nextId; },
      cancelAnimationFrame(id) { frames.delete(id); },
      setTimeout(fn) { timers.set(++nextId, fn); return nextId; }, clearTimeout(id) { timers.delete(id); },
      require(name) {
        if (name === 'react') return react;
        if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
        if (name === 'react-native') return native;
        if (name === 'expo-image') return { Image: 'Image' };
        if (name === '@/hooks/use-layer-gesture') return load('hooks/use-layer-gesture.ts');
        if (name === './caption-presentation') return { CaptionPresentation: 'CaptionPresentation' };
        if (name === './layer-transform-overlay') return { LayerTransformOverlay: 'LayerTransformOverlay' };
        if (name.startsWith('@/services/')) return {};
        if (name.startsWith('@/lib/')) return requireLocal('../src/lib/' + name.slice(6) + '.ts');
        throw new Error('Unexpected dependency ' + name);
      },
    });
    return exports;
  }
  function render(nextComponent = component, nextProps = props) {
    component = nextComponent; props = nextProps;
    let passes = 0;
    do {
      assert.ok(++passes < 20); cursor = 0; effects = []; dirty = false;
      result = component(props); effects.forEach((fn) => fn());
    } while (dirty);
    return result;
  }
  function all(predicate, value = result, out = []) {
    if (Array.isArray(value)) value.forEach((child) => all(predicate, child, out));
    else if (value && typeof value === 'object') {
      if (predicate(value)) out.push(value);
      all(predicate, value.props?.children ?? null, out);
    }
    return out;
  }
  return { load, render, all, get result() { return result; },
    frame() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((fn) => fn()); render(); },
    timers() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((fn) => fn()); },
  };
}
const timelineSuffix = '\nexports.TimingGrip = TimingGrip; exports.TimelineMoveGrip = TimelineMoveGrip; exports.TimedBlock = TimedBlock;';
const event = (x, y) => ({ nativeEvent: { touches: [{ identifier: 1, pageX: x, pageY: y }] } });

// Resolve the actual TimedBlock/Grip JSX bounds before dispatching native touch
// events. A regression that widens selected bodies or overlays a neighboring
// lane is caught here, independently of the gesture state-machine assertions.
function blockTargets(props) {
  const blockHarness = harness();
  const ui = blockHarness.load('components/editor/layer-timeline.tsx', timelineSuffix);
  const tree = blockHarness.render(ui.TimedBlock, props);
  const targets = [];
  function visit(node, parent) {
    if (Array.isArray(node)) { node.forEach((child) => visit(child, parent)); return; }
    if (!node || typeof node !== 'object' || node.props?.pointerEvents === 'none') return;
    if (['TimingGrip', 'TimelineMoveGrip'].includes(node.type?.name)) {
      const gripHarness = harness();
      const grips = gripHarness.load('components/editor/layer-timeline.tsx', timelineSuffix);
      const rendered = gripHarness.render(grips[node.type.name], node.props);
      const s = rendered.props.style;
      targets.push({ label: props.label, edge: node.props.side ?? 'move', rail: Boolean(node.props.side || node.props.controlRail),
        left: parent.left + (s.left ?? parent.width - (s.right ?? 0) - (s.width ?? parent.width)),
        top: parent.top + (s.top ?? 0),
        width: s.width ?? parent.width - (s.left ?? 0) - (s.right ?? 0),
        height: s.height ?? parent.height - (s.top ?? 0) - (s.bottom ?? 0), handlers: rendered.props });
      return;
    }
    const s = node.props?.style;
    const rect = s ? { left: parent.left + (s.left ?? 0), top: parent.top + (s.top ?? 0),
      width: s.width ?? parent.width, height: s.height ?? parent.height } : parent;
    visit(node.props?.children, rect);
  }
  visit(tree, { left: 0, top: 0, width: props.trackWidth, height: props.controlTop + 36 });
  return targets;
}
const contains = (r, x, y) => x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height;
const intersects = (a, b) => a.left < b.left + b.width && b.left < a.left + a.width
  && a.top < b.top + b.height && b.top < a.top + a.height;

for (const kind of ['caption', 'translation']) for (const selectedId of ['a', 'b', 'overlap']) {
  for (const edge of ['move', 'start', 'end']) test(`${kind} tiny ${selectedId} ${edge}: adjacent and overlapping bodies own their touches`, () => {
    let project = createCaptionProject({ id: 'hit-test', name: 'Hit testing', sources: [{ id: 'video',
      uri: 'file:///test.mp4', storageMode: 'copied', displayName: 'Video', durationMs: 60000,
      width: 1080, height: 1920, rotation: 0, frameRate: 30 }] });
    project.captions = [['a', 100, 300], ['b', 300, 500], ['overlap', 200, 400]].map(([id, startMs, endMs]) => ({
      id, startMs, endMs, text: 'caption-' + id, wordIds: [],
    }));
    project = createTranslationCaptionTrack(project, { id: 'fr', languageTag: 'fr', displayName: 'French',
      translations: Object.fromEntries(project.captions.map((cue) => [cue.id, 'translation-' + cue.id])) });
    const before = structuredClone(project), calls = { select: [], edits: [], history: 0, persist: 0, seeks: [] };
    const h = harness();
    const { LayerTimeline } = h.load('components/editor/layer-timeline.tsx');
    h.render(LayerTimeline, { projectId: project.id, currentMs: 150, durationMs: 60000, clips: [], sources: [],
      captions: project.captions, layers: [{ id: 'captions', kind: 'captions', name: 'Captions' }], audioClips: [], audioSources: [],
      translationTracks: [{ id: 'fr', name: 'French', visible: true, pairs: resolveCaptionPairs(project, 'fr') }],
      selectedLayerId: kind === 'caption' ? 'captions' : 'fr', selectedCaptionId: selectedId,
      onSeek(ms) { calls.seeks.push(ms); }, onScrubStart() {},
      onSelectCaption(cue) { calls.select.push(cue.id); },
      onSelectTranslationCaption(_track, pair) { calls.select.push(pair.source.id); },
      onTimingChangeStart() { calls.history++; }, onTimingChangeEnd() { calls.persist++; },
      onItemTimingChange(item, side, start, end) {
        calls.edits.push(plain({ item, side })); project = applyTimelineItemTiming(project, item, side, start, end, 60000);
      },
    });
    const blocks = h.all((node) => node.type?.name === 'TimedBlock' && node.props.label.startsWith(kind + '-'));
    assert.equal(blocks.length, 3);
    const targets = blocks.flatMap((block) => blockTargets(block.props));
    const bodies = targets.filter((target) => !target.rail);
    const rails = targets.filter((target) => target.rail);
    assert.equal(rails.length, 3);
    for (const rail of rails) for (const body of bodies) assert.equal(intersects(rail, body), false);
    for (const body of bodies) {
      assert.ok(body.width < 8, 'exercise tiny cue hit bounds');
      const hit = targets.filter((r) => contains(r, body.left + body.width / 2, body.top + body.height / 2));
      assert.equal(hit.length, 1, body.label + ' must have exactly one responder');
      assert.equal(hit[0], body);
      body.handlers.onPanResponderGrant();
      body.handlers.onPanResponderMove({}, { dx: 8, dy: 0 });
      body.handlers.onPanResponderRelease();
      assert.equal(calls.select.at(-1), body.label.slice(kind.length + 1));
    }
    assert.deepEqual(project, before);
    assert.equal(calls.history, 0);
    const target = rails.find((r) => r.edge === edge);
    const hit = targets.filter((r) => contains(r, target.left + target.width / 2, target.top + target.height / 2));
    assert.deepEqual(hit, [target]);
    target.handlers.onPanResponderGrant();
    for (const [dx, dy] of [[8, 0], [-8, 0], [9, 12]]) target.handlers.onPanResponderMove({}, { dx, dy });
    assert.equal(calls.edits.length, 0);
    target.handlers.onPanResponderMove({}, { dx: edge === 'start' ? -9 : 9, dy: 0 });
    target.handlers.onPanResponderRelease(); target.handlers.onPanResponderTerminate();
    assert.equal(calls.history, 1); assert.equal(calls.persist, 1);
    assert.deepEqual(calls.edits, [{ item: kind === 'caption' ? { kind, captionId: selectedId }
      : { kind, trackId: 'fr', sourceCaptionId: selectedId }, side: edge }]);
    const oldItems = kind === 'caption' ? before.captions : before.captionTracks.translations[0].cues;
    const newItems = kind === 'caption' ? project.captions : project.captionTracks.translations[0].cues;
    const ownerId = kind === 'caption' ? selectedId : 'fr:' + selectedId;
    for (const item of oldItems) {
      const next = newItems.find((cue) => cue.id === item.id);
      if (item.id !== ownerId) assert.deepEqual(next, item);
      else {
        assert.notDeepEqual([next.startMs, next.endMs], [item.startMs, item.endMs]);
        if (edge === 'start') assert.equal(next.endMs, item.endMs);
        if (edge === 'end') assert.equal(next.startMs, item.startMs);
        if (edge === 'move') assert.equal(next.endMs - next.startMs, item.endMs - item.startMs);
      }
    }
    if (kind === 'translation') assert.deepEqual(project.captions, before.captions);
    assert.deepEqual(calls.seeks, []);
  });
}

for (const kind of ['caption', 'translation', 'audio', 'text', 'image']) {
  for (const edge of ['start', 'end', 'move']) test(`${kind} ${edge} jittered taps never change timing, words, history, persistence or fixed-time content`, () => {
    const h = harness();
    const ui = h.load('components/editor/layer-timeline.tsx', timelineSuffix);
    const cue = { id: 'cue', text: 'Still visible', startMs: 0, endMs: 1000, wordIds: ['word-1'] };
    const before = structuredClone(cue);
    const calls = { select: 0, history: 0, mutate: 0, persist: 0 };
    const props = { ...cue, side: edge, selected: true, label: kind, durationMs: 60_000, trackWidth: 120,
      onPress() { calls.select++; }, onChangeStart() { calls.history++; },
      onChange(_edge, startMs, endMs) { calls.mutate++; cue.startMs = startMs; cue.endMs = endMs; },
      onEnd() { calls.persist++; } };
    h.render(edge === 'move' ? ui.TimelineMoveGrip : ui.TimingGrip, props);
    for (let tap = 0; tap < 4; tap++) {
      const handlers = h.result.props;
      handlers.onPanResponderGrant();
      for (const [dx, dy] of [[1, 0], [3, 2], [-4, 1], [8, 0], [9, 12], [0, 0]]) {
        handlers.onPanResponderMove({}, { dx, dy });
      }
      handlers.onPanResponderRelease(); handlers.onPanResponderTerminate();
      assert.deepEqual(cue, before);
      assert.equal(captionPreviewState([cue], 5).active, cue);
    }
    assert.deepEqual(calls, { select: 4, history: 0, mutate: 0, persist: 0 });
  });
}

test('timing controls activate once after deliberate drag and retain the original gesture owner', () => {
  const h = harness();
  const { TimingGrip } = h.load('components/editor/layer-timeline.tsx', timelineSuffix);
  const calls = [];
  const props = { side: 'start', startMs: 0, endMs: 1000, trackWidth: 1000, durationMs: 5000,
    onPress() {}, onChangeStart() { calls.push('start'); },
    onChange(...args) { calls.push(args); }, onEnd() { calls.push('end'); } };
  h.render(TimingGrip, props); const handlers = h.result.props;
  handlers.onPanResponderGrant(); handlers.onPanResponderMove({}, { dx: 8, dy: 0 });
  assert.deepEqual(calls, []);
  handlers.onPanResponderMove({}, { dx: 10, dy: 0 });
  h.render(TimingGrip, { ...props, startMs: 900, onChange() { assert.fail('new cue cannot steal drag'); } });
  handlers.onPanResponderMove({}, { dx: 20, dy: 0 });
  handlers.onPanResponderRelease(); handlers.onPanResponderTerminate();
  assert.deepEqual(calls, ['start', ['start', 50, 1000], ['start', 100, 1000], 'end']);
});

test('selected tiny blocks have separate start, move and end targets without inflated duration geometry', () => {
  for (const width of [2, 4, 10, 24, 48, 80, 150]) {
    const rail = timelineBlockControls(width, true);
    assert.ok(rail.controlWidth - 2 * TIMELINE_GRIP_WIDTH >= 32);
    assert.equal(rail.width, width);
    const h = harness();
    const ui = h.load('components/editor/layer-timeline.tsx', timelineSuffix);
    h.render(ui.TimingGrip, { side: 'start' });
    assert.equal(h.result.props.style.left, 0);
    assert.equal(h.result.props.style.width, TIMELINE_GRIP_WIDTH);
    assert.equal(h.result.props.hitSlop, undefined);
  }
});

test('canvas measurements survive successive gestures, cue switches, style changes and undo without layout', () => {
  const h = harness();
  const { useLayerGesture } = h.load('hooks/use-layer-gesture.ts');
  let geometry = structuredClone(DEFAULT_CAPTION_STYLE), id = 'cue-0', commits = 0;
  const options = () => ({ id, geometry, interactive: true,
    onChange(next) { geometry = { ...geometry, ...next }; commits++; }, onEnd() {} });
  h.render(useLayerGesture, options());
  h.result.measureCanvas(200, 100, { measureInWindow(fn) { fn(30, 20); } });
  for (const change of ['first', 'successive', 'cue', 'style', 'undo']) {
    if (change === 'cue') id = 'cue-1';
    if (change === 'style') geometry = { ...geometry, textColor: '#00FF00' };
    if (change === 'undo') geometry = structuredClone(DEFAULT_CAPTION_STYLE);
    h.render(useLayerGesture, options());
    const start = { ...geometry.position };
    const responder = h.result.responders.move;
    responder.onPanResponderGrant(event(100, 60));
    responder.onPanResponderMove(event(120, 70)); h.frame();
    assert.ok(Math.abs(h.result.geometry.position.x - start.x - 0.1) < 1e-12, change);
    assert.ok(Math.abs(h.result.geometry.position.y - start.y - 0.1) < 1e-12, change);
    responder.onPanResponderRelease(); h.render(useLayerGesture, options());
    assert.ok(Math.abs(geometry.position.x - start.x - 0.1) < 1e-12, change);
  }
  assert.equal(commits, 5);
});

test('narrow selection rails stay inside timeline bounds and preserve actual cue positions', () => {
  for (const startMs of [0, 2450, 4900]) {
    const h = harness();
    const { TimedBlock } = h.load('components/editor/layer-timeline.tsx', timelineSuffix);
    h.render(TimedBlock, { startMs, endMs: startMs + 100, durationMs: 5000, trackWidth: 200,
      selected: true, lane: 0, controlTop: 35, color: '#FFFFFF', label: 'Narrow' });
    const rail = h.all((node) => node.props?.accessibilityLabel === 'Timing controls for Narrow')[0].props.style;
    const bodyParent = h.result.props.children[0].props.style;
    const body = h.all((node) => node.props?.style?.backgroundColor === '#FFFFFFB8')[0].props.style;
    assert.ok(rail.left >= 0 && rail.left + rail.width <= 200);
    assert.equal(bodyParent.left + body.left, startMs / 5000 * 200);
    assert.equal(body.width, 4);
    assert.ok(rail.top >= bodyParent.top + bodyParent.height);
  }
});

test('overlay paints active overlapping cues independently of selected non-active text, with one shared live transform', () => {
  const h = harness();
  const { CaptionOverlay } = h.load('components/editor/caption-overlay.tsx');
  const captions = ['first', 'overlap'].map((id) => ({ id, text: id, startMs: 0, endMs: 1000, wordIds: [] }));
  const selected = { id: 'future', text: 'Future', startMs: 2000, endMs: 3000, wordIds: [] };
  const props = { caption: captions[0], captions, selectionCaption: selected, words: [],
    currentMs: 500, interactive: true, interactionId: 'captions', projectStyle: DEFAULT_CAPTION_STYLE };
  h.render(CaptionOverlay, props);
  const content = () => h.all((node) => node.type === 'CaptionPresentation');
  assert.deepEqual(content().map((node) => node.props.caption.id), ['first', 'overlap']);
  assert.ok(content().every((node) => node.props.currentMs === 500 && !node.props.editingPreview));
  h.result.props.onLayout({ nativeEvent: { layout: { width: 200, height: 100 } } });
  const handles = h.all((node) => node.type === 'LayerTransformOverlay')[0].props.responders.move;
  handles.onPanResponderGrant(event(50, 50)); handles.onPanResponderMove(event(70, 60)); h.frame();
  const geometries = content().map((node) => plain(node.props.geometry));
  assert.deepEqual(geometries[0], geometries[1]);
  assert.equal(geometries[0].position.x, 0.6);
  assert.equal(content()[0].props.caption, captions[0]);
  handles.onPanResponderRelease();
  h.render(CaptionOverlay, { ...props, caption: undefined, captions: [] });
  assert.equal(content().length, 0);
  assert.equal(h.all((node) => node.type === 'LayerTransformOverlay').length, 1);
});

test('caption selection cancels pending scrub completion; scroll-end noise never seeks a fixed playhead', () => {
  const h = harness();
  const { LayerTimeline } = h.load('components/editor/layer-timeline.tsx');
  const caption = { id: 'cue', text: 'Caption', startMs: 0, endMs: 1000, wordIds: [] };
  const pair = { source: caption, translation: { id: 'fr:cue', text: 'French', status: 'reviewed' }, startMs: 0, endMs: 1000, timelineVisible: true };
  const calls = { seek: [], select: [] };
  h.render(LayerTimeline, { currentMs: 500, durationMs: 5000, clips: [], sources: [],
    captions: [caption], layers: [{ id: 'captions', kind: 'captions', name: 'Captions' }], audioClips: [], audioSources: [],
    translationTracks: [{ id: 'fr', name: 'French', visible: true, pairs: [pair] }],
    onSeek(ms) { calls.seek.push(ms); }, onScrubStart() {},
    onSelectCaption(cue) { calls.select.push(cue.id); }, onSelectTranslationCaption(id) { calls.select.push(id); } });
  const scroll = h.all((node) => node.type === 'ScrollView' && node.props.horizontal)[0].props;
  const blocks = h.all((node) => node.type?.name === 'TimedBlock');
  for (const block of blocks) {
    block.props.onPress(); scroll.onScrollEndDrag(); scroll.onMomentumScrollBegin(); scroll.onMomentumScrollEnd(); h.timers();
    assert.deepEqual(calls.seek, []);
    scroll.onScrollBeginDrag(); scroll.onScrollEndDrag();
    block.props.onPress(); scroll.onMomentumScrollEnd(); h.timers();
    assert.deepEqual(calls.seek, []);
  }
  assert.deepEqual(calls.select, ['cue', 'cue', 'fr', 'fr']);
  scroll.onScrollBeginDrag(); scroll.onScroll({ nativeEvent: { contentOffset: { x: 10 } } });
  assert.equal(calls.seek.length, 1, 'intentional scrub still seeks');
});

for (const kind of ['caption', 'translation']) for (const selectedId of ['zero', 'tiny']) {
  for (const edge of ['move', 'start', 'end']) test(`${kind} ${selectedId} at minimum zoom: owned marker selects, then deliberate ${edge} edits only its cue`, () => {
    let project = createCaptionProject({ id: 'marker-test', name: 'Markers', sources: [{ id: 'video',
      uri: 'file:///test.mp4', storageMode: 'copied', displayName: 'Video', durationMs: 600000,
      width: 1080, height: 1920, rotation: 0, frameRate: 30 }] });
    project.captions = [['zero', 0, 0], ['tiny', 0, 80], ['adjacent', 80, 160], ['overlap', 40, 120]]
      .map(([id, startMs, endMs]) => ({ id, startMs, endMs, text: 'caption-' + id, wordIds: [] }));
    project = createTranslationCaptionTrack(project, { id: 'fr', languageTag: 'fr', displayName: 'French',
      translations: Object.fromEntries(project.captions.map((cue) => [cue.id, 'translation-' + cue.id])) });
    project = structuredClone(decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(project))));
    const before = structuredClone(project), calls = { selects: [], edits: [], history: 0, persist: 0, seeks: [] };
    const h = harness(), { LayerTimeline } = h.load('components/editor/layer-timeline.tsx');
    const props = { projectId: project.id, currentMs: 0, durationMs: 600000, clips: [], sources: [],
      captions: project.captions, layers: [{ id: 'captions', kind: 'captions', name: 'Captions' }], audioClips: [], audioSources: [],
      translationTracks: [{ id: 'fr', name: 'French', visible: true, pairs: resolveCaptionPairs(project, 'fr') }],
      onSeek(ms) { calls.seeks.push(ms); }, onScrubStart() {},
      onSelectCaption(cue) { props.selectedLayerId = 'captions'; props.selectedCaptionId = cue.id; calls.selects.push(cue.id); },
      onSelectTranslationCaption(id, pair) { props.selectedLayerId = id; props.selectedCaptionId = pair.source.id; calls.selects.push(pair.source.id); },
      onTimingChangeStart() { calls.history++; }, onTimingChangeEnd() { calls.persist++; },
      onItemTimingChange(item, side, start, end) {
        calls.edits.push(plain({ item, side })); project = applyTimelineItemTiming(project, item, side, start, end, 600000);
      },
    };
    h.render(LayerTimeline, props);
    for (let step = 0; step < 12; step++) {
      h.all((node) => node.type?.name === 'ZoomButton' && node.props.label !== '+')[0].props.onPress(); h.render();
    }
    const blocks = () => h.all((node) => node.type?.name === 'TimedBlock' && node.props.label.startsWith(kind + '-'));
    assert.equal(blocks()[0].props.trackWidth, 300, '0.5 pixels/second is the minimum scale');
    const bodies = blocks().flatMap((block) => blockTargets(block.props)).filter((target) => !target.rail);
    const markers = blocks().map((block) => {
      const markerHarness = harness(), ui = markerHarness.load('components/editor/layer-timeline.tsx', timelineSuffix);
      markerHarness.render(ui.TimedBlock, block.props);
      const node = markerHarness.all((entry) => entry.type === 'Pressable' && entry.props.accessibilityLabel?.startsWith('Select short cue:'))[0];
      return { label: block.props.label, ...node.props.style, onPress: node.props.onPress };
    });
    assert.equal(markers.length, 4);
    for (const marker of markers) {
      assert.ok(marker.width >= 44 && marker.height >= 36);
      for (const body of bodies) assert.equal(intersects(marker, body), false);
      for (const other of markers) if (other !== marker) assert.equal(intersects(marker, other), false);
      assert.ok(marker.left >= 0 && marker.left + marker.width <= 300);
    }
    const marker = markers.find((entry) => entry.label === kind + '-' + selectedId);
    marker.onPress(); h.render();
    const scroll = h.all((node) => node.type === 'ScrollView' && node.props.horizontal)[0].props;
    scroll.onScrollEndDrag(); scroll.onMomentumScrollBegin(); scroll.onMomentumScrollEnd(); h.timers();
    assert.deepEqual(calls.selects, [selectedId]);
    assert.deepEqual(calls.seeks, []);
    assert.deepEqual(project, before);
    const selected = blocks().find((block) => block.props.selected);
    const rails = blockTargets(selected.props).filter((target) => target.rail);
    assert.equal(rails.length, 3);
    for (const rail of rails) {
      assert.ok(rail.width >= 32);
      for (const target of [...bodies, ...markers]) assert.equal(intersects(rail, target), false);
    }
    const target = rails.find((entry) => entry.edge === edge);
    target.handlers.onPanResponderGrant(); target.handlers.onPanResponderMove({}, { dx: 8, dy: 0 });
    target.handlers.onPanResponderRelease();
    assert.equal(calls.history, 0); assert.equal(calls.persist, 0); assert.deepEqual(project, before);
    target.handlers.onPanResponderGrant();
    target.handlers.onPanResponderMove({}, { dx: edge === 'start' ? -9 : 9, dy: 0 });
    target.handlers.onPanResponderRelease(); target.handlers.onPanResponderTerminate();
    assert.equal(calls.history, 1); assert.equal(calls.persist, 1);
    assert.deepEqual(calls.edits, [{ item: kind === 'caption' ? { kind, captionId: selectedId }
      : { kind, trackId: 'fr', sourceCaptionId: selectedId }, side: edge }]);
    const oldItems = kind === 'caption' ? before.captions : before.captionTracks.translations[0].cues;
    const nextItems = kind === 'caption' ? project.captions : project.captionTracks.translations[0].cues;
    const ownerId = kind === 'caption' ? selectedId : 'fr:' + selectedId;
    for (const item of oldItems) {
      const next = nextItems.find((cue) => cue.id === item.id);
      if (item.id !== ownerId) assert.deepEqual(next, item);
      else { assert.ok(next.startMs >= 0); assert.ok(next.endMs - next.startMs >= 80); }
    }
    if (kind === 'translation') assert.deepEqual(project.captions, before.captions);
    assert.deepEqual(calls.seeks, []);
    const reopened = decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(project)));
    const saved = kind === 'caption' ? reopened.captions : reopened.captionTracks.translations[0].cues;
    assert.deepEqual(saved.map(({ id, startMs, endMs }) => ({ id, startMs, endMs })),
      nextItems.map(({ id, startMs, endMs }) => ({ id, startMs, endMs })));
  });
}

test('tiny marker lanes pack independently at both track edges and across zoom levels', () => {
  for (const trackWidth of [278, 300, 960, 144000]) {
    const duration = 600000;
    const cues = [['zero-start', 0, 0], ['start', 0, 80], ['adjacent', 80, 160],
      ['overlap', 40, 120], ['end', duration - 80, duration], ['zero-end', duration, duration]]
      .map(([id, startMs, endMs]) => ({ id, startMs, endMs }));
    const packed = packTimelineMarkers(cues, duration, trackWidth);
    const markers = [...packed.byId.values()].map((entry) => ({ ...entry, top: entry.lane * 44, height: 38 }));
    assert.equal(markers.length, cues.length);
    for (const marker of markers) {
      assert.ok(marker.left >= 0 && marker.left + marker.width <= trackWidth);
      for (const other of markers) if (marker !== other) assert.equal(intersects(marker, other), false);
    }
  }
});

for (const kind of ['caption', 'translation']) test(`${kind} selected long-cue rail follows actual viewport scroll at start, middle, end and zoom`, () => {
  const h = harness(), { LayerTimeline } = h.load('components/editor/layer-timeline.tsx');
  const duration = 600000;
  const cue = { id: 'long', text: 'Long cue', startMs: 0, endMs: duration, wordIds: [] };
  const calls = { seeks: [], edits: 0 };
  const props = { projectId: 'long-test', currentMs: 0, durationMs: duration, clips: [], sources: [],
    captions: [cue], layers: [{ id: 'captions', kind: 'captions', name: 'Captions' }], audioClips: [], audioSources: [],
    translationTracks: [{ id: 'fr', name: 'French', visible: true, pairs: [{ source: cue,
      translation: { id: 'fr:long', text: 'Long translation' }, startMs: 0, endMs: duration, timelineVisible: true }] }],
    selectedLayerId: kind === 'caption' ? 'captions' : 'fr', selectedCaptionId: 'long',
    onSeek(ms) { calls.seeks.push(ms); }, onItemTimingChange() { calls.edits++; },
  };
  h.render(LayerTimeline, props);
  for (const viewportWidth of [240, 360, 768]) {
    h.result.props.onLayout({ nativeEvent: { layout: { width: viewportWidth } } }); h.render();
    for (let zoom = 0; zoom < 3; zoom++) {
      if (zoom) { h.all((node) => node.type?.name === 'ZoomButton' && node.props.label === '+')[0].props.onPress(); h.render(); }
      const block = () => h.all((node) => node.type?.name === 'TimedBlock' && node.props.selected)[0];
      const trackWidth = block().props.trackWidth;
      for (const offset of [0, 1, 33, 119, trackWidth / 2, trackWidth / 2 + 7, trackWidth - 33, trackWidth]) {
        const scroll = h.all((node) => node.type === 'ScrollView' && node.props.horizontal)[0];
        scroll.props.onScroll({ nativeEvent: { contentOffset: { x: offset } } }); h.render();
        const b = block();
        const targets = blockTargets(b.props), rails = targets.filter((entry) => entry.rail);
        const originOnScreen = viewportWidth / 2 - offset;
        assert.equal(rails.length, 3);
        for (const rail of rails) {
          assert.ok(rail.left + originOnScreen >= 0, 'left stays visible');
          assert.ok(rail.left + rail.width + originOnScreen <= viewportWidth, 'right stays visible');
          assert.ok(rail.left >= 0 && rail.left + rail.width <= trackWidth);
          assert.ok(rail.width >= 32, 'each operation remains reachable');
          for (const body of targets.filter((entry) => !entry.rail)) assert.equal(intersects(rail, body), false);
        }
      }
    }
  }
  assert.deepEqual(calls.seeks, [], 'positioning controls never seeks'); assert.equal(calls.edits, 0);
});

test('control placement accounts for the actual label/padding origin and current visible bounds', () => {
  for (const viewport of [240, 360, 768]) for (const trackWidth of [278, 960, 144000]) {
    for (const scroll of [0, trackWidth / 2, trackWidth]) {
      const origin = Math.max(82, viewport / 2);
      const bounds = timelineVisibleTrackBounds(scroll, viewport, trackWidth, origin);
      for (const bodyLeft of [0, trackWidth / 2, trackWidth - 1]) {
        const rail = timelineControlRail(bodyLeft, trackWidth, bounds);
        assert.ok(rail.left >= bounds.left && rail.left + rail.width <= bounds.right);
        assert.ok(rail.left + origin - scroll >= 0);
        assert.ok(rail.left + rail.width + origin - scroll <= viewport);
      }
    }
  }
});
