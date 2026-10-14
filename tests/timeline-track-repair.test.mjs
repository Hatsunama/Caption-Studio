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
import { orderedTimelineTrackIds, moveTimelineTrack, setTimelineTrackOrder } from '../src/lib/timeline-tracks.ts';

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
  const output = ts.transpileModule(source + '\nexports.useTimelineTimingPanHandlers = useTimelineTimingPanHandlers; exports.VideoMoveGrip = VideoMoveGrip; exports.TimedBlock = TimedBlock;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  runInNewContext(output, { exports, setTimeout, clearTimeout, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === 'react-native') return { View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView', PanResponder: { create: (panHandlers) => ({ panHandlers }) } };
      if (name === 'expo-image') return { Image: 'Image' };
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
  return { exports, all, render, refs, effects };
}

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
  handlers.onPanResponderRelease();
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
  node.props.onPanResponderGrant();
  node.props.onPanResponderMove({}, { dx: 30, dy: 0 });
  node.props.onPanResponderTerminate();
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
  handle.props.onMove(-1000);
  handle.props.onFinish(false);
  assert.deepEqual(drops, [['images', 'video', 'audio', 'captions']]);
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
  assert.deepEqual(Array.from(rows, (row) => row.props.label), ['WATERMARKS', 'IMAGES', 'TEXT', 'CAPTIONS', 'AUDIO', 'VIDEO']);
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
