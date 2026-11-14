import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { decodeVersionTwoProject, serializeProjectSnapshot } from '../src/lib/project-schema.ts';
import { moveVisualLayer } from '../src/lib/project-editor.ts';
import { DEFAULT_CAPTION_STYLE } from '../src/types/project.ts';
import { buildTimelineRenderPlan } from '../src/lib/export-render-plan.ts';
import { orderedTimelineTrackIds, moveTimelineTrack, setTimelineTrackOrder, applyTimelineStackOrder, visualTimelineRowIds } from '../src/lib/timeline-tracks.ts';

const requireLocal = createRequire(import.meta.url);

function project() {
  return createCaptionProject({ id: 'track-test', name: 'Track test', sources: [{
    id: 'source', uri: 'file:///video.mp4', storageMode: 'copied', displayName: 'Video',
    durationMs: 120_000, width: 1920, height: 1080, rotation: 0, frameRate: 30,
  }] });
}

function image(id, startMs, endMs, extra = {}) {
  return { id, kind: 'image', name: id, visible: true, uri: `file:///${id}.png`,
    startMs, endMs, position: { x: 0.5, y: 0.5 }, box: { width: 0.3, height: 0.3 },
    rotation: 0, opacity: 1, ...extra };
}

function harness() {
  const haptics = [];
  const effects = [];
  const refs = [];
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const react = {
    Fragment: 'Fragment', createContext: (value) => ({ value, Provider: 'Provider' }),
    useContext: (context) => context.value, useMemo: (factory) => factory(),
    useCallback: (callback) => callback, useEffect: (effect) => effects.push(effect),
    useRef: (value) => { const ref = { current: value }; refs.push(ref); return ref; },
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  };
  const source = readFileSync(new URL('../src/components/editor/layer-timeline.tsx', import.meta.url), 'utf8');
  const output = ts.transpileModule(source + '\nexports.useTimelineTimingPanHandlers = useTimelineTimingPanHandlers; exports.VideoMoveGrip = VideoMoveGrip; exports.VideoTrimGrip = VideoTrimGrip; exports.TimedBlock = TimedBlock;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  runInNewContext(output, { exports, setTimeout, clearTimeout, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === 'react-native-reanimated') return { useSharedValue: (value) => react.useRef({ value }).current };
      if (name === '@/components/spring-scroll-view') return {
        SpringScrollView: 'ScrollView', SpringScrollGestureContext: { value: [] },
      };
      if (name === 'react-native') return { View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView',
        Platform: { OS: 'android' },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        PixelRatio: { get: () => 1, roundToNearestPixel: Math.round }, PanResponder: { create: (panHandlers) => ({ panHandlers }) } };
      if (name === 'expo-image') return { Image: 'Image' };
      if (name === './timeline-linked-scroll') return requireLocal('../src/components/editor/timeline-linked-scroll.ts');
      if (name === './timeline-native-gesture') return {
        createTimelineNativeScrollGestures: () => [], TimelineNativeGestureContext: { Provider: 'Provider' },
        TimelineNativeGeometryContext: react.createContext(undefined),
        TimelineNativeGestureView: 'View', TimelineNativeScrollView: 'ScrollView',
      };
      if (name === '@/services/timeline-haptics') return { timelineHaptic: (kind) => haptics.push(kind) };
      if (name.startsWith('@/services/')) return {};
      if (name.startsWith('@/lib/')) return requireLocal('../src/lib/' + name.slice(6) + '.ts');
      throw new Error(name);
    },
  });
  function all(node, predicate, found = []) {
    if (Array.isArray(node)) node.forEach((child) => all(child, predicate, found));
    else if (node && typeof node === 'object') {
      if (predicate(node)) found.push(node);
      all(node.props?.children, predicate, found);
    }
    return found;
  }
  function render(p, overrides = {}) {
    const props = { projectId: p.id, durationMs: 120_000, clips: p.clips, sources: p.sources,
      layers: p.layers.filter((layer) => layer.timelineVisible !== false), captions: [], translationTracks: [],
      currentMs: 0, audioSources: [], audioClips: [], trackOrder: p.timelineTrackOrder,
      onSeek() {}, onScrubStart() {}, onClearSelection() {}, onSelectLayer() {}, onSelectCaption() {},
      onSelectTranslationCaption() {}, onSelectClip() {}, onTrimClip() {}, onSetClipGap() {},
      onSetClipLeadingGap() {}, onReorderClip() {}, onItemTimingChange() {}, onTimingChangeStart() {},
      onTimingChangeEnd() {}, onMoveLayer() {}, onDeleteLayer() {}, onAddVideos() {}, onSelectAudioClip() {}, onReorderTrack() {}, ...overrides,
    };
    return exports.LayerTimeline(props);
  }
  return { exports, all, render, refs, effects, haptics };
}

test('the blank trailing area belongs to the existing vertical lane scroll surface', () => {
  const h = harness();
  const tree = h.render(project());
  const horizontal = h.all(tree, (node) => node.type === 'ScrollView' && node.props.horizontal)[0];
  const surface = horizontal.props.children;
  assert.equal(surface.props.style.width + surface.props.style.marginLeft, horizontal.props.contentContainerStyle.width,
    'the full trailing blank space must be inside the vertical scroll viewport');
  const vertical = h.all(surface, (node) => node.type === 'ScrollView' && !node.props.horizontal)[0];
  assert.equal(vertical.props.scrollEnabled, true);
  assert.equal(vertical.props.nestedScrollEnabled, true);
  assert.ok(h.all(vertical, (node) => node.type?.name === 'TimelineRow').length >= 2);
});

test('timeline taps give one selection pulse for video, audio, image, text and primary captions', () => {
  const p = project();
  p.layers.push(image('one', 0, 1000), { id: 'title', kind: 'text', name: 'Title', visible: true,
    text: 'Hi', startMs: 0, endMs: 1000, style: DEFAULT_CAPTION_STYLE });
  const h = harness();
  const selected = [];
  const tree = h.render(p, { captions: [{ id: 'cue', text: 'Caption', startMs: 0, endMs: 1000, words: [] }],
    audioClips: [{ id: 'sound', sourceId: 'sound-source', startMs: 0, sourceStartMs: 0, sourceEndMs: 1000, playbackRate: 1 }],
    onSelectLayer: (id) => selected.push(id), onSelectCaption: () => selected.push('cue'),
    onSelectClip: () => selected.push('video'), onSelectAudioClip: () => selected.push('audio') });
  const blocks = h.all(tree, (node) => node.type?.name === 'VideoClipBlock' || node.type?.name === 'TimedBlock');
  assert.equal(blocks.length, 5);
  for (const block of blocks) block.props.onPress();
  assert.equal(selected.length, 5);
  assert.deepEqual(h.haptics, Array(5).fill('selection'));
});

test('boundary feedback waits for applied timing, ignores scrolling and resets on cancellation', () => {
  const h = harness();
  let last;
  const owner = { startMs: 1000, endMs: 2000, durationMs: 5000, trackWidth: 1000,
    getFeedbackBoundaries: () => [2500], onPress() {}, onChangeStart() {}, onEnd() {},
    onChange(edge, startMs, endMs) { last = { edge, startMs, endMs }; return { startMs, endMs }; } };
  const handlers = h.exports.useTimelineTimingPanHandlers(owner, 'end');
  handlers.onStartShouldSetPanResponderCapture();
  handlers.onMoveShouldSetPanResponder({ nativeEvent: { touches: [{}] } }, { dx: 0, dy: 20 });
  assert.deepEqual(h.haptics, []);
  handlers.onPanResponderGrant();
  handlers.onPanResponderMove({ nativeEvent: { touches: [{}] } }, { dx: 110, dy: 0 });
  assert.equal(last.endMs, 2550, 'feedback must not introduce new snapping');
  assert.deepEqual(h.haptics, ['boundary']);
  handlers.onPanResponderTerminate();
  handlers.onPanResponderMove({ nativeEvent: { touches: [{}] } }, { dx: 80, dy: 0 });
  assert.deepEqual(h.haptics, ['boundary']);
});

test('live feedback follows accepted domain timing, not rejected pointer positions', () => {
  const h = harness();
  const owner = { startMs: 1000, endMs: 2000, durationMs: 5000, trackWidth: 1000,
    getFeedbackBoundaries: () => [2500, 3000], onPress() {}, onChangeStart() {}, onEnd() {},
    onChange(_edge, _startMs, endMs) { owner.endMs = Math.min(2500, endMs); } };
  const handlers = h.exports.useTimelineTimingPanHandlers(owner, 'end');
  handlers.onPanResponderGrant();
  handlers.onPanResponderMove({ nativeEvent: { touches: [{}] } }, { dx: 110, dy: 0 });
  assert.deepEqual(h.haptics, [], 'wait until accepted state renders');
  for (const effect of h.effects) effect();
  assert.deepEqual(h.haptics, ['boundary']);
  handlers.onPanResponderMove({ nativeEvent: { touches: [{}] } }, { dx: 300, dy: 0 });
  for (const effect of h.effects) effect();
  assert.deepEqual(h.haptics, ['boundary'], 'a clamp must not signal unreachable boundaries');
  handlers.onPanResponderTerminate();
  owner.endMs = 3000;
  for (const effect of h.effects) effect();
  assert.deepEqual(h.haptics, ['boundary'], 'later unrelated edits must not buzz');
});

test('boundary snapshots include all artifact kinds, exclude the active object and preserve translation identity', () => {
  const p = project();
  p.layers.push(image('one', 4100, 4700), image('hidden', 8100, 8300, { timelineVisible: false }));
  const source = { id: 'cue', text: 'Hello', startMs: 1100, endMs: 1600, words: [] };
  const pair = { source, translation: { id: 'translated', status: 'translated' }, startMs: 2100, endMs: 2600,
    timelineVisible: true, displayText: 'Hallo' };
  const h = harness();
  const selections = [];
  const tree = h.render(p, { currentMs: 3500, captions: [source], translationTracks: [{ id: 'german', name: 'German', visible: true, pairs: [pair] }],
    audioClips: [{ id: 'sound', sourceId: 'sound-source', startMs: 5100, sourceStartMs: 0, sourceEndMs: 1000, playbackRate: 1 }],
    onSelectTranslationCaption: (id) => selections.push(id) });
  const translated = h.all(tree, (node) => node.type?.name === 'TimedBlock' && node.props.label === 'Hallo')[0];
  const times = Array.from(translated.props.getFeedbackBoundaries());
  for (const time of [0, 120000, 3500, 1100, 1600, 4100, 4700, 5100, 6100]) assert.ok(times.includes(time), String(time));
  for (const time of [2100, 2600, 8100, 8300]) assert.ok(!times.includes(time), String(time));
  translated.props.onPress();
  assert.deepEqual(selections, ['german']);
  assert.deepEqual(h.haptics, ['selection']);
});

test('video gap movement observes boundaries and cancellation stops further feedback', () => {
  const h = harness();
  const node = h.exports.VideoMoveGrip({ startMs: 1000, endMs: 2000, leadingGapMs: 0, clipIndex: 1, clipCount: 2,
    bodyLeft: 0, bodyWidth: 100, trackWidth: 1000, durationMs: 5000, label: 'clip', getFeedbackBoundaries: () => [2500],
    onPress() {}, onGestureLock() {}, onGapPreview() {}, onGestureCancel() {}, onGapCommit() {} });
  node.props.panHandlers.onPanResponderGrant({}, { dx: 110, dy: 0 });
  assert.deepEqual(h.haptics, ['boundary']);
  node.props.panHandlers.onPanResponderTerminate();
  node.props.panHandlers.onPanResponderMove({}, { dx: 10, dy: 0 });
  assert.deepEqual(h.haptics, ['boundary']);
});

test('native timing callbacks use the same domain edit and cancellation boundary', () => {
  const h = harness();
  const calls = [];
  const native = h.exports.useTimelineTimingPanHandlers({
    startMs: 1000, endMs: 2000, durationMs: 5000, trackWidth: 1000,
    onPress: () => calls.push('select'), onChangeStart: () => calls.push('begin'),
    onChange: (edge, startMs, endMs) => calls.push([edge, startMs, endMs]),
    onEnd: () => calls.push('commit'), onCancel: () => calls.push('cancel'),
  }, 'end').nativeCallbacks;
  native.begin(20, 0);
  native.move(40, 0, 1);
  native.move(60, 0, 2);
  native.move(80, 0, 1);
  native.finish();
  assert.deepEqual(calls, ['select', 'begin', ['end', 1000, 2100], ['end', 1000, 2200], 'cancel']);
});

test('native video hold still selects reorder rather than inserting a gap', () => {
  const h = harness();
  const calls = [];
  const node = h.exports.VideoMoveGrip({ startMs: 0, endMs: 1000, leadingGapMs: 0,
    clipIndex: 0, clipCount: 2, bodyLeft: 0, bodyWidth: 100, trackWidth: 1000, durationMs: 5000,
    onPress() {}, onGestureLock() {}, onGestureCancel() {},
    onGapPreview: () => calls.push('gap'), onReorderPreview: (index) => calls.push(['preview', index]),
    onReorderCommit: (index) => calls.push(['commit', index]),
  });
  const native = node.props.nativeCallbacks;
  native.prepare();
  assert.equal(native.holdMilliseconds, 350);
  native.begin(0, 1, true);
  native.move(100, 1, 1);
  native.finish();
  assert.deepEqual(calls, [['preview', 0], ['preview', 1], ['commit', 1]]);
});

test('video trim feedback cannot signal positions beyond the available source', () => {
  const h = harness();
  const previews = [];
  const node = h.exports.VideoTrimGrip({ startMs: 1000, endMs: 2000, side: 'end', gripLeft: 100,
    trackWidth: 1000, durationMs: 5000, label: 'clip',
    clip: { sourceStartMs: 0, sourceEndMs: 1000, availableSourceStartMs: 0, availableSourceEndMs: 1500, playbackRate: 1 },
    getFeedbackBoundaries: () => [2500, 3000], onPress() {}, onGestureLock() {},
    onTrimPreview: (_edge, ms) => previews.push(ms), onTrimCommit() {}, onGestureCancel() {} });
    node.props.panHandlers.onPanResponderGrant();
    node.props.panHandlers.onPanResponderMove({ nativeEvent: { touches: [{}] } }, { dx: 110, dy: 0 });
  assert.equal(previews.at(-1), 1500);
  assert.deepEqual(h.haptics, ['boundary']);
    node.props.panHandlers.onPanResponderMove({ nativeEvent: { touches: [{}] } }, { dx: 300, dy: 0 });
  assert.equal(previews.at(-1), 1500);
  assert.deepEqual(h.haptics, ['boundary']);
});

test('visual timeline packs separated overlaps into one reusable two-lane image track', () => {
  const p = project();
  p.layers.push(image('first', 0, 1000), image('second', 1000, 2000),
    image('early-a', 30_000, 32_000), image('early-b', 31_000, 33_000),
    image('late-a', 60_000, 62_000), image('late-b', 61_000, 63_000));
  const h = harness();
  const tree = h.render(p);
  const rows = h.all(tree, (node) => node.type?.name === 'TimelineRow');
  const images = rows.filter((row) => row.props.label === 'IMAGES');
  assert.equal(images.length, 1, 'images must share a track rather than each creating a row');
  const blocks = h.all(images[0], (node) => node.type?.name === 'TimedBlock');
  assert.equal(blocks.length, 6);
  assert.equal(Math.max(...blocks.map((node) => node.props.lane)), 1, 'later overlaps must reuse lane two');
  assert.ok(rows.some((row) => row.props.label === 'VIDEO'));
  assert.ok(rows.some((row) => row.props.label === 'AUDIO'));
});

test('track placement survives draft decoding without reordering composited objects', () => {
  const p = project();
  p.layers.push(image('front', 0, 2000), image('back', 1000, 3000));
  p.timelineTrackOrder = ['images', 'video', 'audio', 'captions'];
  const restored = decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(p)));
  assert.deepEqual(restored.timelineTrackOrder, p.timelineTrackOrder);
  assert.deepEqual(restored.layers.map((layer) => layer.id), p.layers.map((layer) => layer.id));
  const h = harness();
  const rows = h.all(h.render(restored), (node) => node.type?.name === 'TimelineRow');
  assert.equal(rows[0].props.label, 'IMAGES');
});

test('moving a visible visual object skips a hidden neighbour', () => {
  const p = project();
  p.layers = [image('a', 0, 1000), image('hidden', 0, 1000, { timelineVisible: false }), image('c', 0, 1000)];
  const next = moveVisualLayer(p, 'c', -1);
  assert.deepEqual(next.layers.filter((layer) => layer.timelineVisible !== false).map((layer) => layer.id), ['c', 'a']);
  assert.ok(next.layers.some((layer) => layer.id === 'hidden'));
});

test('native touch termination cancels staged trim instead of committing it', () => {
  const h = harness();
  const calls = [];
  const handlers = h.exports.useTimelineTimingPanHandlers({ startMs: 1000, endMs: 2000,
    durationMs: 5000, trackWidth: 1000, onPress() {}, onChangeStart() {}, onChange() {},
    onEnd() { calls.push('commit'); }, onCancel() { calls.push('cancel'); },
  }, 'end', () => {});
  handlers.onPanResponderGrant();
  handlers.onPanResponderMove({ nativeEvent: { touches: [{}] } }, { dx: 30, dy: 0 });
  handlers.onPanResponderTerminate();
  handlers.onPanResponderRelease({ nativeEvent: { touches: [] } }, { dx: 30, dy: 0 });
  assert.deepEqual(calls, ['cancel']);
});

test('native touch termination discards staged video gap', () => {
  const h = harness();
  const calls = [];
  const node = h.exports.VideoMoveGrip({ leadingGapMs: 0, clipIndex: 0, clipCount: 2,
    bodyLeft: 0, bodyWidth: 100, trackWidth: 1000, durationMs: 5000, label: 'clip',
    onPress() {}, onGestureLock() {}, onGapPreview() {}, onGapCommit() { calls.push('commit'); },
    onGestureCancel() { calls.push('cancel'); }, onReorderCancel() { calls.push('cancel'); },
  });
  node.props.panHandlers.onPanResponderGrant();
  node.props.panHandlers.onPanResponderMove({}, { dx: 30, dy: 0 });
  node.props.panHandlers.onPanResponderTerminate();
  assert.deepEqual(calls, ['cancel']);
});

test('a track drop commits the final pointer position even before React rerenders', () => {
  const p = project();
  p.layers.push(image('one', 0, 1000));
  const h = harness();
  const drops = [];
  const tree = h.render(p, { onReorderTrack: (order) => drops.push(Array.from(order)) });
  const handle = h.all(tree, (node) => node.type?.name === 'TimelineTrackHandle' && node.props.label === 'IMAGES')[0];
  handle.props.onStart();
  handle.props.onMove(1000);
  handle.props.onFinish(false);
  assert.deepEqual(drops, [['captions', 'video', 'audio', 'images']]);
  assert.equal(p.timelineTrackOrder, undefined, 'preview must not mutate the project');
});

test('a second finger cancels staged trim instead of committing it', () => {
  const h = harness();
  const calls = [];
  const handlers = h.exports.useTimelineTimingPanHandlers({ startMs: 1000, endMs: 2000,
    durationMs: 5000, trackWidth: 1000, onPress() {}, onChangeStart() {}, onChange() {},
    onEnd() { calls.push('commit'); }, onCancel() { calls.push('cancel'); },
  }, 'end', () => {});
  handlers.onPanResponderGrant();
  handlers.onPanResponderMove({ nativeEvent: { touches: [{}] } }, { dx: 30, dy: 0 });
  handlers.onPanResponderMove({ nativeEvent: { touches: [{}, {}] } }, { dx: 30, dy: 0 });
  assert.deepEqual(calls, ['cancel']);
});

test('native timing responder leaves vertical scrolling alone for the entire touch', () => {
  const h = harness();
  const calls = [];
  const event = { nativeEvent: { touches: [{}] } };
  const handlers = h.exports.useTimelineTimingPanHandlers({ startMs: 1000, endMs: 2000,
    durationMs: 5000, trackWidth: 1000, onPress() { calls.push('select'); },
    onChangeStart() {}, onChange() {}, onEnd() {},
  }, 'move', (value) => calls.push(value));
  handlers.onStartShouldSetPanResponderCapture?.(event);
  assert.equal(handlers.onStartShouldSetPanResponder(event), false);
  assert.equal(handlers.onMoveShouldSetPanResponder(event, { dx: 2, dy: 20 }), false);
  assert.equal(handlers.onMoveShouldSetPanResponder(event, { dx: 80, dy: 20 }), false,
    'once scrolling wins, sideways finger movement must not steal the touch');
  assert.deepEqual(calls, [], 'a scroll must not select, lock, or begin an edit');
});

test('text and watermarks pack separately without changing visual or export order', () => {
  const p = project();
  p.layers.push(image('image', 0, 1000),
    { id: 'title', kind: 'text', name: 'Title', visible: true, text: 'Title', startMs: 0, endMs: 1000, style: DEFAULT_CAPTION_STYLE },
    { id: 'mark', kind: 'text', name: 'Mark', watermark: true, visible: true, text: 'Mark', startMs: 0, endMs: 1000, style: DEFAULT_CAPTION_STYLE });
  const beforePlan = buildTimelineRenderPlan(p);
  const next = setTimelineTrackOrder(p, ['watermarks', 'images', 'text', 'captions', 'audio', 'video']);
  assert.equal(next.layers, p.layers);
  assert.deepEqual(buildTimelineRenderPlan(next), beforePlan);
  const h = harness();
  const rows = h.all(h.render(next), (node) => node.type?.name === 'TimelineRow');
  assert.deepEqual(Array.from(rows, (row) => row.props.label), ['WATERMARKS', 'TEXT', 'IMAGES', 'CAPTIONS', 'AUDIO', 'VIDEO']);
});

test('track ordering drops stale tracks and appends new tracks once', () => {
  assert.deepEqual(orderedTimelineTrackIds(['video', 'audio', 'images', 'text'], ['images', 'translation:gone', 'video', 'images']),
    ['images', 'video', 'audio', 'text']);
  assert.deepEqual(moveTimelineTrack(['video', 'audio', 'images'], 'images', -100), ['images', 'video', 'audio']);
  assert.deepEqual(moveTimelineTrack(['video', 'audio', 'images'], 'video', 100), ['audio', 'images', 'video']);
  assert.deepEqual(moveTimelineTrack(['video', 'audio'], 'missing', 0), ['video', 'audio']);
});

test('draft validation rejects malformed ordering instead of silently losing it', () => {
  for (const order of [['images', 'images'], ['not-a-track'], ['translation:'], 'images', [42]]) {
    const p = project();
    p.timelineTrackOrder = order;
    assert.throws(() => serializeProjectSnapshot(p), /track order/i);
  }
});

test('voice-over keeps its dedicated video and recording rows regardless of editor track order', () => {
  const p = project();
  p.layers.push(image('image', 0, 1000));
  p.timelineTrackOrder = ['images', 'captions', 'audio', 'video'];
  const h = harness();
  const rows = h.all(h.render(p, { voiceoverMode: true }), (node) => node.type?.name === 'TimelineRow');
  assert.deepEqual(Array.from(rows, (row) => row.props.label), ['VIDEO', 'VOICE OVER']);
});

test('watermark timeline colors retain transparency without producing invalid ten-digit colors', () => {
  const h = harness();
  const tree = h.exports.TimedBlock({ label: 'Watermark', color: '#E8579C88', selected: false,
    startMs: 0, endMs: 1000, durationMs: 5000, trackWidth: 1000, lane: 0 });
  const artwork = h.all(tree, (node) => node.props.style?.backgroundColor)[0];
  assert.match(artwork.props.style.backgroundColor, /^#[0-9a-f]{8}$/i);
  assert.equal(artwork.props.style.backgroundColor, '#E8579C88');
  assert.match(artwork.props.style.borderColor, /^#[0-9a-f]{8}$/i);
});

test('initial editor reveal resets the inner lane viewport and fixed labels together', () => {
  const p = project();
  const h = harness();
  const tree = h.render(p);
  const scrolls = h.all(tree, (node) => node.type === 'ScrollView' && !node.props.horizontal && node.props.ref);
  const calls = scrolls.map(() => []);
  scrolls.forEach((node, index) => { node.props.ref.current = { scrollTo: (request) => calls[index].push(request.y) }; });
  scrolls[0].props.onScroll({ nativeEvent: { contentOffset: { y: 400 } } });
  for (const list of calls) list.length = 0;
  for (const effect of h.effects) effect();
  assert.equal(scrolls.length, 2);
  assert.ok(calls.every((list) => list.includes(0)));
  assert.equal(p.timelineTrackOrder, undefined);
});

test('items sharing a row retain individual selection and never seek on tap', () => {
  const p = project();
  p.layers.push(image('one', 0, 1000), image('two', 1000, 2000));
  const h = harness();
  const selected = [], seeks = [];
  const tree = h.render(p, { onSelectLayer: (id) => selected.push(id), onSeek: (time) => seeks.push(time) });
  const rows = h.all(tree, (node) => node.type?.name === 'TimelineRow' && node.props.label === 'IMAGES');
  for (const block of h.all(rows[0], (node) => node.type?.name === 'TimedBlock')) block.props.onPress();
  assert.deepEqual(selected, ['two', 'one']);
  assert.deepEqual(seeks, []);
});

for (const ending of ['release', 'cancel', 'second finger']) test(`native held vertical item reorder uses one isolated lifecycle: ${ending}`, () => {
  const h = harness(), calls = [], locks = [];
  const handlers = h.exports.useTimelineTimingPanHandlers({
    startMs: 1000, endMs: 2000, durationMs: 5000, trackWidth: 1000,
    onPress: () => calls.push('select'), onChangeStart: () => calls.push('timing-start'),
    onChange: () => calls.push('timing-change'), onEnd: () => calls.push('timing-end'),
    onReorderStart: () => calls.push('reorder-start'),
    onReorderMove: dy => calls.push(['reorder-move', dy]),
    onReorderEnd: cancelled => calls.push(['reorder-end', cancelled]),
  }, 'move', locked => locks.push(locked));
  assert.equal(handlers.nativeCallbacks.holdMilliseconds, 350);
  assert.equal(handlers.nativeCallbacks.holdAxis, 'vertical');
  handlers.nativeCallbacks.begin(0, -20, true);
  handlers.nativeCallbacks.move(0, -48, 1);
  if (ending === 'release') handlers.nativeCallbacks.finish();
  else if (ending === 'cancel') handlers.nativeCallbacks.cancel();
  else handlers.nativeCallbacks.move(0, -60, 2);
  handlers.nativeCallbacks.finish(); handlers.nativeCallbacks.cancel();
  assert.deepEqual(calls, ['select', 'reorder-start', ['reorder-move', -20], ['reorder-move', -48],
    ['reorder-end', ending !== 'release']]);
  assert.deepEqual(locks, [true, false]);
});

test('visual move body still edits timing on a normal horizontal gesture', () => {
  const h = harness(), calls = [];
  const handlers = h.exports.useTimelineTimingPanHandlers({ startMs: 1000, endMs: 2000,
    durationMs: 5000, trackWidth: 1000, onPress() {},
    onChangeStart: () => calls.push('timing-start'), onChange: (_edge, start, end) => calls.push([start, end]),
    onEnd: () => calls.push('timing-end'),
    onReorderStart: () => assert.fail('horizontal gesture must not reorder'),
    onReorderMove: () => assert.fail('horizontal gesture must not reorder'),
    onReorderEnd: () => assert.fail('horizontal gesture must not reorder'),
  }, 'move');
  handlers.nativeCallbacks.begin(20, 0, false); handlers.nativeCallbacks.move(40, 0, 1); handlers.nativeCallbacks.finish();
  assert.deepEqual(calls, ['timing-start', [1100, 2100], [1200, 2200], 'timing-end']);
});

for (const kind of ['video', 'image', 'text', 'watermark']) test(`${kind}: item vertical reorder is connected without changing timing`, () => {
  const p = project();
  const layers = ['a', 'b', 'c'].map(id => ({ ...image(id, 0, 1000),
    kind: kind === 'watermark' ? 'text' : kind, text: id, watermark: kind === 'watermark' }));
  p.layers.push(...layers);
  const h = harness(), drops = [];
  const tree = h.render(p, { onReorderVisualLayer: (id, index) => drops.push([id, index]) });
  const block = h.all(tree, node => node.type?.name === 'TimedBlock' && node.props.label === 'b')[0].props;
  assert.equal(typeof block.onReorderStart, 'function', 'the rendered object must expose the real ordering transaction');
  block.onReorderStart(); block.onReorderMove(-1000); block.onReorderEnd(false);
  assert.deepEqual(drops, [['b', 0]]);
  block.onReorderEnd(false);
  assert.equal(drops.length, 1, 'a duplicate release cannot reorder twice');
  block.onReorderStart(); block.onReorderMove(1000); block.onReorderEnd(true);
  assert.equal(drops.length, 1, 'cancelled reorders never commit');
  assert.deepEqual(p.layers.slice(-3), layers, 'preview must not mutate timing or project order');
});

test('primary and dual captions can move their actual shared render container', () => {
  const p = project(); p.layers.push(image('front', 0, 1000));
  const cue = { id: 'cue', text: 'Primary', startMs: 0, endMs: 1000 };
  const h = harness(), drops = [];
  const tree = h.render(p, { captions: [cue], translationTracks: [{ id: 'es', name: 'Spanish', visible: true,
    pairs: [{ source: cue, translation: { id: 'es-cue', status: 'ready' }, displayText: 'Spanish',
      startMs: 0, endMs: 1000, timelineVisible: true }] }],
    onReorderVisualLayer: (id, index) => drops.push([id, index]) });
  for (const label of ['Primary', 'Spanish']) {
    const block = h.all(tree, node => node.type?.name === 'TimedBlock' && node.props.label === label)[0].props;
    assert.equal(typeof block.onReorderStart, 'function');
    block.onReorderStart(); block.onReorderMove(-1000); block.onReorderEnd(false);
  }
  assert.deepEqual(drops, [['captions', 0], ['captions', 0]]);
});

test('caption row grabs and accessibility moves keep primary and translation rows together', () => {
  const p = project(); p.layers.push(image('front', 0, 1000));
  const h = harness(), drops = [];
  const tree = h.render(p, { translationTracks: [{ id: 'es', name: 'Spanish', visible: true, pairs: [] }],
    onReorderTrack: order => drops.push(Array.from(order)) });
  const handle = h.all(tree, node => node.type?.name === 'TimelineTrackHandle' && node.props.label === 'CAPTIONS')[0].props;
  handle.onStart(); handle.onMove(-1000); handle.onFinish(false);
  assert.deepEqual(drops[0], ['translation:es', 'captions', 'images', 'video', 'audio']);
  handle.onAccessibleMove(-1);
  assert.deepEqual(drops[1], drops[0], 'one accessible move crosses a complete visual neighbour');
});

// Exercise the rendered handle itself, then the same domain application and
// serialization used by the editor. A callback-only assertion misses no-op paint.
for (const count of [1, 3]) for (const imagesFirst of [false, true]) {
  const bundle = [...Array(count)].map((_, i) => 'translation:' + ['es', 'fr', 'de'][i]).reverse().concat('captions');
  for (const moving of ['IMAGES', ...bundle.map(id => id === 'captions' ? 'CAPTIONS' : '↳ ' + id.slice(12).toUpperCase())]) {
    for (const input of ['accessibility', 'native', 'fallback']) test(`group bundle: ${count} translations, imagesFirst=${imagesFirst}, ${moving}, ${input}`, () => {
      const p = project(), img = image('picture', 0, 1000);
      p.layers = imagesFirst ? [...p.layers, img] : [img, ...p.layers];
      p.captionTracks.translations = ['es', 'fr', 'de'].slice(0, count).map(id => ({
        id, kind: 'translation', sourceTrackId: 'captions', sourceLanguageTag: 'en', languageTag: id,
        displayName: id, visible: true, origin: 'manual', provider: { id: 'manual' }, cues: [],
      }));
      const h = harness(), drops = [];
      const tree = h.render(p, { translationTracks: p.captionTracks.translations.map(track => ({
        id: track.id, name: track.id, visible: true, pairs: [],
      })), onReorderTrack: order => drops.push(Array.from(order)) });
      const node = h.all(tree, node => node.type?.name === 'TimelineTrackHandle' && node.props.label === moving)[0];
      assert.ok(node, moving);
      const handle = node.type(node.props);
      const direction = (moving === 'IMAGES') === imagesFirst ? 1 : -1;
      if (input === 'accessibility') handle.props.onAccessibilityAction({ nativeEvent: { actionName: direction > 0 ? 'increment' : 'decrement' } });
      else {
        // One image row, or the first adjacent subtitle row midpoint, is enough
        // to cross; dragging a subtitle must move the whole container.
        const dy = direction * (moving === 'IMAGES' ? 46 : (bundle.length * 42 + 46) / 2 + 1);
        if (input === 'native') {
          handle.props.nativeCallbacks.begin(0, dy);
          handle.props.nativeCallbacks.finish();
        } else {
          handle.props.panHandlers.onPanResponderGrant({}, { dy });
          handle.props.panHandlers.onPanResponderRelease();
        }
      }
      const expected = imagesFirst ? [...bundle, 'images', 'video', 'audio'] : ['images', ...bundle, 'video', 'audio'];
      assert.equal(drops.length, 1);
      const changed = applyTimelineStackOrder(p, drops[0]);
      assert.notEqual(changed, p, `emitted ${JSON.stringify(drops[0])} must change the actual paint order`);
      assert.deepEqual(drops[0], expected, 'the destination cannot split primary and translations');
      const saved = setTimelineTrackOrder(changed, drops[0].filter(id => id === 'video' || id === 'audio'));
      const restored = decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(saved)));
      assert.deepEqual(visualTimelineRowIds(restored.layers, p.captionTracks.translations.map(t => t.id)), expected.slice(0, -2));
      assert.deepEqual(buildTimelineRenderPlan(restored).layers.map(layer => layer.id),
        imagesFirst ? ['picture', 'captions'] : ['captions', 'picture']);
      assert.deepEqual(restored.timelineTrackOrder, ['video', 'audio']);
      assert.deepEqual(changed.clips, p.clips);
      assert.equal(changed.captionTracks, p.captionTracks);
      assert.equal(changed.layers.find(layer => layer.id === 'picture'), img);
    });
  }
}

for (const ending of ['cancel', 'second finger', 'fallback terminate']) test(`group bundle cancellation: ${ending}`, () => {
  const p = project(); p.layers.unshift(image('picture', 0, 1000));
  const h = harness(), drops = [];
  const node = h.all(h.render(p, { translationTracks: [{ id: 'es', name: 'es', visible: true, pairs: [] }],
    onReorderTrack: order => drops.push(order) }), n => n.type?.name === 'TimelineTrackHandle' && n.props.label === 'IMAGES')[0];
  const handle = node.type(node.props);
  if (ending === 'fallback terminate') {
    handle.props.panHandlers.onPanResponderGrant({}, { dy: -46 });
    handle.props.panHandlers.onPanResponderTerminate();
  } else {
    handle.props.nativeCallbacks.begin(0, -46);
    if (ending === 'cancel') handle.props.nativeCallbacks.cancel();
    else handle.props.nativeCallbacks.move(0, -60, 2);
  }
  handle.props.nativeCallbacks.finish();
  assert.deepEqual(drops, []);
  assert.deepEqual(p.layers.map(layer => layer.id), ['picture', 'captions']);
});

test('group bundle boundaries use only available members and retain single-row ordering', () => {
  for (const order of [[], ['video', 'audio'], ['images', 'captions'], ['images', 'translation:es']]) {
    assert.deepEqual(moveTimelineTrack(order, 'missing', 0), order);
    for (const id of order) assert.deepEqual(moveTimelineTrack(order, id, NaN), order);
  }
  assert.deepEqual(moveTimelineTrack(['images', 'captions', 'audio'], 'images', 1), ['captions', 'images', 'audio']);
  assert.deepEqual(moveTimelineTrack(['images', 'translation:es', 'audio'], 'images', 1), ['translation:es', 'images', 'audio']);
  const order = ['translation:fr', 'translation:es', 'captions', 'images', 'video', 'audio'];
  assert.deepEqual(moveTimelineTrack(order, 'captions', -1), order);
  assert.deepEqual(moveTimelineTrack(order, 'images', 3), order);
  assert.deepEqual(moveTimelineTrack(order, 'audio', 100), order);
  assert.deepEqual(moveTimelineTrack(order, 'video', 5), [...order.slice(0, 4), 'audio', 'video']);
});

test('group bundle handles respect missing caption containers, disabled callbacks and voice-over', () => {
  const p = project(); p.layers = [image('picture', 0, 1000)];
  const h = harness();
  const tree = h.render(p, { translationTracks: [{ id: 'es', name: 'es', visible: true, pairs: [] }], onReorderTrack: undefined });
  const nodes = h.all(tree, n => n.type?.name === 'TimelineTrackHandle');
  assert.deepEqual(nodes.map(n => n.props.label), ['IMAGES', 'VIDEO', 'AUDIO']);
  for (const node of nodes) {
    const handle = node.type(node.props);
    assert.equal(handle.props.nativeDisabled, true);
    handle.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } });
    handle.props.nativeCallbacks.begin(0, 100);
    handle.props.nativeCallbacks.finish();
  }
  assert.equal(h.all(h.render(p, { voiceoverMode: true }), n => n.type?.name === 'TimelineTrackHandle').length, 0);
});

for (const returnToOrigin of [false, true]) test(`group bundle drag reentry accounts for scroll offset, return=${returnToOrigin}`, () => {
  const p = project(); p.layers.unshift(image('picture', 0, 1000));
  const h = harness(), drops = [];
  const tree = h.render(p, { translationTracks: [{ id: 'es', name: 'es', visible: true, pairs: [] }],
    onReorderTrack: order => drops.push(Array.from(order)) });
  const labels = h.all(tree, n => n.props.testID === 'timeline-track-labels')[0];
  const scroll = y => labels.props.onScrollBeginDrag({ nativeEvent: { contentOffset: { y } } });
  scroll(60);
  const node = h.all(tree, n => n.type?.name === 'TimelineTrackHandle' && n.props.label === 'IMAGES')[0];
  const handle = node.type(node.props);
  handle.props.nativeCallbacks.begin(0, 0);
  scroll(14);
  handle.props.nativeCallbacks.move(0, 0, 1);
  handle.props.nativeCallbacks.move(0, 0, 1);
  if (returnToOrigin) {
    scroll(60);
    handle.props.nativeCallbacks.move(0, 0, 1);
  }
  handle.props.nativeCallbacks.finish(); handle.props.nativeCallbacks.finish();
  assert.deepEqual(drops, returnToOrigin ? [] : [['images', 'translation:es', 'captions', 'video', 'audio']]);
  assert.equal(h.haptics.filter(kind => kind === 'boundary').length, returnToOrigin ? 2 : 1);
});

for (const [moving, dy, destination] of [['B', -20, 0], ['B', 20, 2], ['A', 20, 1], ['C', -20, 1]]) {
  test(`compressed row ranks 0,1,0: ${moving} drag ${dy}px follows stack direction`, () => {
    const p = project();
    p.layers = [image('C', 4000, 5000), image('B', 500, 1500), image('A', 0, 1000)];
    const h = harness(), drops = [];
    const tree = h.render(p, { onReorderVisualLayer: (id, index) => drops.push([id, index]) });
    const block = h.all(tree, node => node.type?.name === 'TimedBlock' && node.props.label === moving)[0].props;
    block.onReorderStart(); block.onReorderMove(dy); block.onReorderEnd(false);
    assert.deepEqual(drops, [[moving, destination]], 'screen-row reuse must not reverse front/back intent');
    assert.deepEqual(p.layers.map(item => item.id), ['C', 'B', 'A']);
  });
}
