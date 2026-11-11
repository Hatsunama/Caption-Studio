import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreviewSceneController } from '../src/lib/preview-scene-controller.ts';
import { applyPreviewSceneGeometry } from '../src/lib/preview-scene-project.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { setVideoClipTransform } from '../src/lib/project-editor.ts';
import { decodeVersionTwoProject } from '../src/lib/project-schema.ts';
import { layerExtent, resolveLayerGeometry } from '../src/lib/layer-geometry.ts';
import { previewInteractionAtPoint } from '../src/lib/preview-object-hit-test.ts';
import { createTranslationCaptionTrack, resolveCaptionPairs } from '../src/lib/caption-tracks.ts';
import { resolveCaptionStyle } from '../src/lib/style-resolver.ts';
import * as video from '../src/lib/video-transform.ts';

const origin = { pageX: 71, pageY: 129 };
const near = (a, b, label = '') => assert.ok(Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(b)), `${label}: ${a} != ${b}`);
function same(actual, expected) {
  for (const key of ['scale', 'scaleX', 'scaleY', 'rotation']) near(actual[key], expected[key], key);
  for (const key of ['x', 'y']) near(actual.position[key], expected.position[key], key);
  assert.deepEqual(actual.box, expected.box);
}
const reopen = (project) => decodeVersionTwoProject(JSON.parse(JSON.stringify(project)));
function fixture(sourceSize, canvasSize, patch = {}) {
  let p = createCaptionProject({ id: 'roundtrip', name: 'Roundtrip', sources: [{ id: 'source', uri: 'file:///source.mp4',
    storageMode: 'copied', displayName: 'Source', durationMs: 5000, width: sourceSize[0], height: sourceSize[1], rotation: 0 }] });
  p.canvas = { ...p.canvas, aspectWidth: canvasSize[0], aspectHeight: canvasSize[1] };
  p = setVideoClipTransform(p, p.clips[0].id, patch);
  return reopen(p); // Establish that each baseline is a valid persisted model.
}
function harness(initial, size, suppliedTarget, readGeometry, peers = []) {
  let project = initial;
  const clip = project.clips[0];
  const read = readGeometry ?? ((p) => video.videoClipPreviewGeometry(p, clip.id));
  const target = suppliedTarget ?? { key: `video:${clip.id}`, selection: { kind: 'video', id: clip.id },
    geometry: read(project), order: -1, yieldToForeground: true, limits: video.VIDEO_TRANSFORM_GESTURE_LIMITS };
  const controller = createPreviewSceneController();
  const calls = { commits: 0, starts: 0, ends: 0 };
  const before = JSON.stringify(initial);
  controller.layout(size);
  controller.configure({ targets: [target, ...peers], selectedKey: target.key, enabled: true,
    onSelect() {}, onClearSelection() { assert.fail('gesture must hit its target'); }, onDelete() { assert.fail('not delete'); },
    onInteractionStart() { calls.starts++; }, onInteractionEnd() { calls.ends++; },
    onChange(t, geometry) { calls.commits++; project = applyPreviewSceneGeometry(project, t, geometry); },
  });
  const point = (id, x, y) => ({ id, x: x + origin.pageX, y: y + origin.pageY });
  const draft = () => controller.geometryFor(target.key, target.geometry);
  function finish(expected = draft(), commits = 1) {
    assert.equal(JSON.stringify(initial), before, 'draft must not mutate project');
    assert.equal(calls.commits, 0);
    controller.release(); controller.release();
    assert.equal(calls.commits, commits); assert.equal(calls.starts, 1); assert.equal(calls.ends, 1);
    const committed = read(project), restored = read(reopen(project));
    same(committed, expected); same(restored, expected);
    assert.equal(project.layers, initial.layers, 'main-video edits preserve foreground identity');
    return project;
  }
  return { controller, point, draft, finish, target, calls, read, project: () => project };
}
function pinch(h, size, ratio, translate = 0) {
  const x = size.width / 2, y = size.height / 2;
  // First contact is at the center to avoid tiny-object edge chrome.
  h.controller.grant([h.point(7, x, y), h.point(2, x + 100, y)], origin);
  h.controller.move([h.point(2, x + 50 + 50 * ratio + translate, y), h.point(7, x + 50 - 50 * ratio + translate, y)]);
}
function handle(h, size, mode, ratio) {
  const g = h.target.geometry, extent = layerExtent(g);
  const x = g.position.x * size.width, y = g.position.y * size.height;
  const dx = ['right', 'left', 'corner'].includes(mode) ? extent.width * size.width / 2 * (mode === 'left' ? -1 : 1) : 0;
  const dy = ['top', 'bottom', 'corner'].includes(mode) ? extent.height * size.height / 2 * (mode === 'top' ? -1 : 1) : 0;
  const start = h.point(7, x + dx, y + dy);
  assert.equal(previewInteractionAtPoint([h.target], h.target.key, { x: x + dx, y: y + dy }, size)?.mode, mode);
  h.controller.grant([start], origin);
  // Edges resize around the opposite edge; corners scale about the center.
  const factor = mode === 'corner' ? ratio : 2 * ratio - 1;
  h.controller.move([h.point(7, x + dx * factor, y + dy * factor)]);
}

for (const source of [[1080, 1920], [1920, 1080]]) for (const canvas of [[300, 500], [500, 300]]) {
  const size = { width: canvas[0], height: canvas[1] };
  const label = `${source.join('x')} source / ${canvas.join('x')} canvas`;
  for (const scale of [1, 0.05]) test(`${label}: near-collapsed anisotropic pinch from ${scale} respects .05 before pivot and roundtrips`, () => {
    const h = harness(fixture(source, canvas, { scale, scaleX: 2, scaleY: 0.5 }), size);
    pinch(h, size, 0.000001);
    const draft = h.draft();
    h.finish(draft, scale === 0.05 ? 0 : 1);
    near(draft.scale, 0.05);
    near(draft.scaleX, 2); near(draft.scaleY, 0.5);
    near(draft.position.x, 0.5 + 50 * (1 - 0.05 / scale) / size.width, 'bounded pivot');
  });
  test(`${label}: pinch stops at model scale 20, preserving anisotropy`, () => {
    const h = harness(fixture(source, canvas, { scale: 19, scaleX: 2, scaleY: 0.5 }), size);
    pinch(h, size, 2);
    near(h.draft().scale, 20); near(h.draft().scaleX, 2); near(h.draft().scaleY, 0.5);
    h.finish();
  });
  for (const action of ['tap', 'pinch-no-op', 'pinch-translate', 'move', 'shrink']) test(`${label}: valid maximum shape survives ${action}`, () => {
    const h = harness(fixture(source, canvas, { scale: 20, scaleX: 200, scaleY: 0.001 }), size);
    const initial = h.target.geometry;
    if (action.startsWith('pinch') || action === 'shrink') pinch(h, size, action === 'shrink' ? 0.5 : 1, action === 'pinch-translate' ? 10 : 0);
    else {
      h.controller.grant([h.point(7, size.width / 2, size.height / 2)], origin);
      if (action === 'move') h.controller.move([h.point(7, size.width / 2 + 10, size.height / 2)]);
    }
    near(h.draft().scale, action === 'shrink' ? 10 : 20);
    near(h.draft().scaleX, initial.scaleX); near(h.draft().scaleY, initial.scaleY);
    h.finish(h.draft(), ['tap', 'pinch-no-op'].includes(action) ? 0 : 1);
  });
}

const size = { width: 400, height: 300 };
for (const simultaneous of [false, true]) for (const scale of [1, 19]) {
  test(`main video: ${simultaneous ? 'simultaneous' : 'staggered'} second contact over higher peer preserves owner and model limits from scale ${scale}`, () => {
    let initial = fixture([1920, 1080], [400, 300], { scale });
    initial.layers.push({ id: 'peer', kind: 'text', name: 'Peer', text: 'Peer', visible: true,
      startMs: 0, endMs: 5000, style: { ...initial.projectStyle,
        position: { x: .8, y: .5 }, box: { width: .2, height: .2 }, scale: 1,
        scaleX: 1, scaleY: 1, rotation: 0 } });
    initial = reopen(initial);
    const peer = { key: 'peer', selection: { kind: 'text', id: 'peer' }, order: 10,
      geometry: resolveLayerGeometry(initial.layers.find(layer => layer.id === 'peer').style) };
    const original = reopen(initial);
    const h = harness(initial, size, undefined, undefined, [peer]);
    const first = h.point(7, 80, 150), second = h.point(2, 320, 150);
    assert.equal(previewInteractionAtPoint([h.target, peer], h.target.key, { x: 80, y: 150 }, size)?.target.key, h.target.key);
    assert.equal(previewInteractionAtPoint([h.target, peer], h.target.key, { x: 320, y: 150 }, size)?.target.key, peer.key);
    h.controller.grant(simultaneous ? [first, second] : [first], origin);
    if (!simultaneous) h.controller.start([second, first]);
    h.controller.move([h.point(2, 360, 150), h.point(7, 60, 150)]);
    near(h.draft().scale, Math.min(scale * 1.25, 20));
    near(h.draft().position.x, .525);
    near(h.draft().position.y, .5);
    assert.equal(h.controller.selectedKey, h.target.key);
    assert.deepEqual(h.controller.geometryFor(peer.key, peer.geometry), peer.geometry);
    const committed = h.finish();
    for (const value of [committed, reopen(committed)]) {
      for (const key of ['layers', 'sources', 'audioSources', 'audioClips', 'canvas', 'captions', 'captionTracks']) {
        assert.deepEqual(value[key], original[key], key);
      }
    }
    assert.deepEqual(initial, original);
  });
}

test('main fill pinch release and JSON/schema reopen match the final draft at the scale floor', () => {
  const h = harness(fixture([1920, 1080], [400, 300], { fit: 'fill' }), size);
  pinch(h, size, 0.000001);
  const draft = h.draft();
  h.finish(draft);
  near(draft.scale, 0.05);
});
for (const mode of ['left', 'right', 'top', 'bottom', 'corner']) for (const direction of ['collapse', 'expand']) {
  test(`main ${mode} ${direction}: numerical bound applied before anchored position`, () => {
    const corner = mode === 'corner', horizontal = mode === 'left' || mode === 'right';
    const h = harness(fixture([1920, 1080], [400, 300], { fit: 'fill', scale: corner ? (direction === 'collapse' ? 0.1 : 19) : 0.05,
      scaleX: corner ? 2 : (horizontal ? (direction === 'collapse' ? 1 : 199) : 1),
      scaleY: corner ? 0.5 : (!horizontal ? (direction === 'collapse' ? 1 : 199) : 1) }), size);
    const g = h.target.geometry, e = layerExtent(g);
    const ratio = direction === 'collapse' ? 0 : 100;
    handle(h, size, mode, ratio);
    const key = corner ? 'scale' : horizontal ? 'scaleX' : 'scaleY';
    const bound = corner ? (direction === 'collapse' ? 0.05 : 20) : (direction === 'collapse' ? 0.001 : 200);
    near(h.draft()[key], bound);
    const axis = horizontal ? 'x' : 'y';
    const side = mode === 'left' || mode === 'top' ? -1 : 1;
    if (!corner) near(h.draft().position[axis], 0.5 + side * e[horizontal ? 'width' : 'height'] * (bound / g[key] - 1) / 2, 'opposite edge');
    else { near(h.draft().scaleX, 2); near(h.draft().scaleY, 0.5); }
    h.finish();
  });
}

test('cancelled bounded pinch never reaches project setters and balances lifecycle', () => {
  const p = fixture([1080, 1920], [400, 300]);
  const h = harness(p, size); pinch(h, size, 0);
  near(h.draft().scale, 0.05);
  h.controller.cancel(); h.controller.release(); h.controller.cancel();
  assert.equal(h.project(), p); assert.equal(h.calls.commits, 0);
  assert.equal(h.calls.starts, 1); assert.equal(h.calls.ends, 1);
  same(h.draft(), h.target.geometry); same(h.read(reopen(p)), h.target.geometry);
});

for (const mode of ['left', 'right', 'top', 'bottom']) for (const direction of ['collapse', 'expand']) {
  test(`fitted main ${mode} ${direction}: axis model bounds are independent of rendered extent`, () => {
    const horizontal = mode === 'left' || mode === 'right';
    const h = harness(fixture(horizontal ? [1080, 1920] : [1920, 1080], [400, 300], {
      scale: direction === 'collapse' ? 20 : 0.05,
      scaleX: horizontal ? (direction === 'collapse' ? 0.01 : 199) : 0.01,
      scaleY: !horizontal ? (direction === 'collapse' ? 0.01 : 199) : 0.01,
    }), size);
    const g = h.target.geometry, e = layerExtent(g), key = horizontal ? 'scaleX' : 'scaleY';
    handle(h, size, mode, direction === 'collapse' ? 0 : 2);
    const bound = direction === 'collapse' ? 0.001 : 200;
    near(h.draft()[key], bound);
    near(h.draft()[horizontal ? 'scaleY' : 'scaleX'], g[horizontal ? 'scaleY' : 'scaleX']);
    near(h.draft().position[horizontal ? 'x' : 'y'], 0.5 + (mode === 'left' || mode === 'top' ? -1 : 1)
      * e[horizontal ? 'width' : 'height'] * (bound / g[key] - 1) / 2);
    h.finish();
  });
}

for (const kind of ['text', 'image', 'video-overlay', 'captions', 'translation']) test(`${kind}: foreground default extent domain roundtrips through actual setter`, () => {
  let p = fixture([1920, 1080], [400, 300]);
  const g = { position: { x: 0.5, y: 0.5 }, box: { width: 0.4, height: 0.3 }, scale: 1, scaleX: 2, scaleY: 0.5, rotation: 0 };
  p.captions = [{ id: 'cue', text: 'Cue', startMs: 0, endMs: 2000, wordIds: [] }];
  p.projectStyle = { ...p.projectStyle, ...g };
  if (kind === 'translation') p = createTranslationCaptionTrack(p, { id: 'fr', languageTag: 'fr', displayName: 'French', styleOverride: g, translations: { cue: 'Bonjour' } });
  if (['text', 'image', 'video-overlay'].includes(kind)) p.layers.push({ id: 'layer', kind: kind === 'video-overlay' ? 'video' : kind,
    name: 'Layer', visible: true, startMs: 0, endMs: 5000, ...(kind === 'text' ? { text: 'Text', style: { ...p.projectStyle, ...g } }
      : { ...g, uri: 'file:///layer.mp4', opacity: 1, ...(kind === 'video-overlay' ? { sourceDurationMs: 5000, sourceStartMs: 0, playbackRate: 1, includeAudio: false } : {}) }) });
  p = reopen(p);
  const selection = kind === 'captions' ? { kind, captionId: 'cue' } : kind === 'translation' ? { kind, id: 'fr', captionId: 'cue' } : { kind, id: 'layer' };
  const read = (p) => resolveLayerGeometry(kind === 'captions' ? resolveCaptionStyle(p.projectStyle, p.captions[0])
    : kind === 'translation' ? resolveCaptionPairs(p, 'fr')[0].style : kind === 'text' ? p.layers.find((l) => l.id === 'layer').style : p.layers.find((l) => l.id === 'layer'));
  const target = { key: kind, selection, order: 1, geometry: read(p) };
  const h = harness(p, size, target, read);
  pinch(h, size, 0);
  near(Math.min(...Object.values(layerExtent(h.draft()))), 0.001);
  const draft = h.draft(); h.controller.release(); h.controller.release();
  assert.equal(h.calls.commits, 1); same(read(h.project()), draft); same(read(reopen(h.project())), draft);
  assert.equal(h.project().clips, p.clips);
});
