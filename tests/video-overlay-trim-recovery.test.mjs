import assert from 'node:assert/strict';
import test from 'node:test';
import { createCaptionProject, createVideoClip } from '../src/lib/project-factory.ts';
import { addVideoLayer, setVideoLayer, splitVideoClip, reorderVideoClip, setLayerTiming, splitVisualLayer, duplicateVisualLayer, setVideoClipGap, trimVideoClip, setVideoLayerPlaybackRate, deleteVideoClip, addImageLayer, createTextLayer } from '../src/lib/project-editor.ts';
import { setClipPlaybackRate } from '../src/lib/video-timeline.ts';
import { videoOverlaySegments } from '../src/lib/video-overlay-segments.ts';
import { overlayPlaybackState } from '../src/lib/video-overlay-playback.ts';
import { buildTimelineRenderPlan } from '../src/lib/export-render-plan.ts';
import { buildTimelineAudioRenderPlan } from '../src/lib/timeline-audio-render-plan.ts';
import { decodePersistedProject } from '../src/lib/project-codec.ts';
import { serializeProjectSnapshot, decodeVersionTwoProject } from '../src/lib/project-schema.ts';
import { applyPreviewSceneGeometry } from '../src/lib/preview-scene-project.ts';
import { resolveLayerGeometry } from '../src/lib/layer-geometry.ts';

function fixture({ currentMs = 1000, sourceStartMs = 500, rate = 1, owners = 1, playbackRate = 1 } = {}) {
  let project = createCaptionProject({ id: 'trim-recovery', name: 'Recovery', sources: Array.from({ length: owners }, (_, i) => ({
    id: `main${i}`, uri: `file:///main${i}.mp4`, storageMode: 'copied', displayName: 'main.mp4',
    durationMs: 8000 / owners, width: 360, height: 640, rotation: 0,
  })) });
  if (rate !== 1) project = setClipPlaybackRate(project, project.clips[0].id, rate);
  return addVideoLayer(project, { id: 'pip', name: 'PiP', uri: 'file:///cs-horizontal-samsung.mp4',
    currentMs, durationMs: 8000 / rate, sourceStartMs, sourceDurationMs: 8000, playbackRate, includeAudio: true }).project;
}
const layer = (p, id = 'pip') => p.layers.find(l => l.id === id);
const segments = (p, id = 'pip') => videoOverlaySegments(layer(p, id), p.clips, Infinity)
  .map(s => [s.startMs, s.endMs, s.sourceStartMs, s.sourceEndMs]);
const saved = p => decodePersistedProject(JSON.stringify(p));

function strictSaved(p) {
  const snapshot = serializeProjectSnapshot(p);
  const strict = decodeVersionTwoProject(JSON.parse(snapshot));
  assert.deepEqual(layer(strict), layer(saved(p)));
  return decodePersistedProject(snapshot);
}

function selectionOnA() {
  let p = fixture({ currentMs: 3000, sourceStartMs: 500, owners: 2 });
  p = strictSaved(setLayerTiming(p, 'pip', 'end', 3000, 4000));
  assert.deepEqual(layer(p).sourceAnchors.map(a => a.clipId), [p.clips[0].id]);
  assert.deepEqual(layer(p).sourceMapping.map(a => a.clipId), p.clips.map(c => c.id));
  return p;
}

function checkHidden(p, id = 'pip') {
  assert.equal(layer(p, id).timelineVisible, false);
  if (p.clips.length) checkChain(p, [], id);
  else {
    assert.deepEqual(segments(p, id), []);
    assert.throws(() => buildTimelineRenderPlan(p), /^Error: Add timed content before exporting\.$/);
    assert.deepEqual(buildTimelineAudioRenderPlan(p).audioClips, []);
  }
  for (const ms of [0, 500, 1500, 3000, 3999, 5000, 7999]) {
    const state = overlayPlaybackState(layer(p, id), ms, true, p.clips);
    assert.equal(state.visible, false);
    assert.equal(state.playing, false);
  }
}

test('empty selection retains hidden B mapping through split and strict serialization', () => {
  let p = selectionOnA();
  const [a, b] = p.clips.map(c => c.id);
  p = strictSaved(deleteVideoClip(p, a).project);
  assert.deepEqual(layer(p).sourceAnchors, []);
  assert.deepEqual(layer(p).sourceMapping.map(m => m.clipId), [b]);
  checkHidden(p);
  p = splitVideoClip(p, b, 1000, 'hidden-left', 'hidden-right').project;
  p = strictSaved(p);
  assert.deepEqual(layer(p).sourceMapping, [
    { clipId: 'hidden-left', sourceStartMs: 0, sourceEndMs: 1000, mediaStartMs: 1500, ownerRate: 1 },
    { clipId: 'hidden-right', sourceStartMs: 1000, sourceEndMs: 2000, mediaStartMs: 2500, ownerRate: 1 },
  ]);
  assert.deepEqual(layer(p).sourceAnchors, []);
  checkHidden(p);
});

test('hidden B deletion shortcut removes retained mapping after deleting A', () => {
  let p = selectionOnA();
  const b = p.clips[1].id;
  p = strictSaved(deleteVideoClip(p, p.clips[0].id).project);
  p = deleteVideoClip(p, b).project;
  p = strictSaved(p);
  assert.deepEqual(layer(p).sourceMapping, []);
  assert.deepEqual(layer(p).sourceAnchors, []);
  checkHidden(p);
});

test('hidden split survivors retain frame offsets through deletion, rates, duplication and geometry', () => {
  let p = selectionOnA();
  const [a, b] = p.clips.map(c => c.id);
  p = strictSaved(deleteVideoClip(p, a).project);
  p = strictSaved(splitVideoClip(p, b, 1000, 'hidden-left', 'hidden-right').project);
  p = strictSaved(deleteVideoClip(p, 'hidden-left').project);
  const survivor = [{ clipId: 'hidden-right', sourceStartMs: 1000, sourceEndMs: 2000,
    mediaStartMs: 2500, ownerRate: 1 }];
  assert.deepEqual(layer(p).sourceMapping, survivor);
  const before = structuredClone(p);
  p = strictSaved(setClipPlaybackRate(p, 'hidden-right', 2));
  assert.deepEqual(layer(p).sourceMapping, [{ ...survivor[0], ownerRate: 2 }]);
  checkHidden(p);
  p = strictSaved(setClipPlaybackRate(p, 'hidden-right', 1));
  assert.deepEqual(layer(p), layer(before));
  assert.equal(setVideoLayerPlaybackRate(p, 'pip', 2), p, 'empty selection cannot be reattached by speed');
  assert.equal(setLayerTiming(p, 'pip', 'end', 0, 8000), p);
  assert.equal(splitVisualLayer(p, 'pip', 3500, 'visual-left', 'visual-right'), null);
  p = strictSaved(duplicateVisualLayer(p, 'pip', 'copy').project);
  assert.notEqual(layer(p, 'copy').sourceMapping, layer(p).sourceMapping);
  assert.notEqual(layer(p, 'copy').sourceMapping[0], layer(p).sourceMapping[0]);
  const copied = structuredClone(layer(p, 'copy'));
  p = strictSaved(setVideoLayer(p, 'pip', { rotation: 25, position: { x: 0.3, y: 0.4 } }));
  assert.deepEqual(layer(p).sourceMapping, survivor);
  assert.deepEqual(layer(p, 'copy'), copied);
  p = strictSaved(trimVideoClip(p, 'hidden-right', 'end', 1500).project);
  p = strictSaved(trimVideoClip(p, 'hidden-right', 'end', 4000).project);
  checkHidden(p);
  checkHidden(p, 'copy');
  p = strictSaved(deleteVideoClip(p, 'hidden-right').project);
  for (const id of ['pip', 'copy']) {
    assert.deepEqual(layer(p, id).sourceMapping, []);
    assert.deepEqual(layer(p, id).sourceAnchors, []);
    checkHidden(p, id);
  }
  assert.deepEqual(before.sources, p.sources);
  assert.deepEqual(before.audioClips, p.audioClips);
});

test('hidden B split and partial deletion keep surviving selected A recoverable at exact media offsets', () => {
  let p = selectionOnA();
  const a = p.clips[0].id;
  p = strictSaved(splitVideoClip(p, p.clips[1].id, 5000, 'b-left', 'b-right').project);
  checkChain(p, [[3000, 4000, 500, 1500]]);
  p = strictSaved(deleteVideoClip(p, 'b-left').project);
  assert.deepEqual(layer(p).sourceMapping.map(m => [m.clipId, m.mediaStartMs]), [[a, 500], ['b-right', 2500]]);
  p = strictSaved(setLayerTiming(p, 'pip', 'end', 3000, 7000));
  checkChain(p, [[3000, 4000, 500, 1500], [4000, 7000, 2500, 5500]]);
  const recovered = structuredClone(p);
  p = strictSaved(trimVideoClip(p, 'b-right', 'start', 3500).project);
  p = strictSaved(trimVideoClip(p, 'b-right', 'start', 1000).project);
  checkChain(p, segments(recovered));
  assert.deepEqual(layer(p).sourceMapping, layer(recovered).sourceMapping);
});

test('deleting hidden B while A remains selected drops only B and does not change A frames', () => {
  let p = selectionOnA();
  const a = p.clips[0].id;
  const before = segments(p);
  p = strictSaved(deleteVideoClip(p, p.clips[1].id).project);
  assert.deepEqual(layer(p).sourceMapping, [{ clipId: a, sourceStartMs: 3000, sourceEndMs: 4000,
    mediaStartMs: 500, ownerRate: 1 }]);
  checkChain(p, before);
});

for (const legacy of [false, true]) test(`deleted selection stays detached from replacement footage, legacy ${legacy}`, () => {
  let p = strictSaved(deleteVideoClip(selectionOnA(), 'clip-main0-0').project);
  if (legacy) delete layer(p).sourceMapping;
  p = strictSaved(p);
  const replacement = createVideoClip(p.sources[0], 99);
  // Match appendVideosToProject's clip insertion, reusing even the retired media.
  p = strictSaved({ ...p, clips: [...p.clips, replacement] });
  p = strictSaved(reorderVideoClip(p, replacement.id, 0).project);
  p = strictSaved(setClipPlaybackRate(p, replacement.id, 2));
  p = strictSaved(splitVideoClip(p, replacement.id, 1000, 'replacement-left', 'replacement-right').project);
  p = strictSaved(setVideoLayer(p, 'pip', { opacity: 0.6 }));
  assert.equal(setVideoLayerPlaybackRate(p, 'pip', 2), p);
  assert.deepEqual(layer(p).sourceAnchors, []);
  assert.deepEqual(layer(p).sourceMapping?.map(m => m.clipId), legacy ? undefined : ['clip-main1-1']);
  checkHidden(p);
  p = strictSaved(deleteVideoClip(p, 'clip-main1-1').project);
  assert.deepEqual(layer(p).sourceMapping, legacy ? undefined : []);
  checkHidden(p);
});

test('legacy VIDEO without retained mapping keeps selected frames through main split and deletion', () => {
  let p = fixture({ currentMs: 3000, sourceStartMs: 500, owners: 2 });
  assert.equal(layer(p).sourceMapping, undefined);
  const a = p.clips[0].id;
  p = strictSaved(splitVideoClip(p, p.clips[1].id, 5000, 'legacy-left', 'legacy-right').project);
  checkChain(p, [[3000, 4000, 500, 1500], [4000, 5000, 1500, 2500], [5000, 6000, 2500, 3500]]);
  assert.equal(layer(p).sourceMapping, undefined);
  p = strictSaved(deleteVideoClip(p, 'legacy-left').project);
  assert.deepEqual(layer(p).sourceAnchors.map(m => m.clipId), [a, 'legacy-right']);
  checkChain(p, [[3000, 4000, 500, 1500], [4000, 5000, 2500, 3500]]);
});

test('multiple retained hidden owners update rate offsets and split IDs independently of empty selection', () => {
  let p = strictSaved(setLayerTiming(threeOwners(), 'pip', 'end', 3000, 6000));
  const [a, b, c] = p.clips.map(clip => clip.id);
  p = strictSaved(deleteVideoClip(p, a).project);
  const before = structuredClone(layer(p).sourceMapping);
  assert.deepEqual(before.map(m => [m.clipId, m.mediaStartMs]), [[b, 4000], [c, 10000]]);
  p = strictSaved(setClipPlaybackRate(p, b, 2));
  assert.deepEqual(layer(p).sourceMapping.map(m => [m.clipId, m.mediaStartMs, m.ownerRate]),
    [[b, 4000, 2], [c, 7000, 1]]);
  checkHidden(p);
  p = strictSaved(setClipPlaybackRate(p, b, 1));
  assert.deepEqual(layer(p).sourceMapping, before);
  p = strictSaved(splitVideoClip(p, b, 2000, 'b-left', 'b-right').project);
  p = strictSaved(deleteVideoClip(p, 'b-left').project);
  assert.deepEqual(layer(p).sourceMapping.map(m => [m.clipId, m.mediaStartMs]),
    [['b-right', 6000], [c, 10000]]);
  assert.deepEqual(layer(p).sourceAnchors, []);
  checkHidden(p);
});

function samsungReorderedRecovery() {
  let p = fixture({ currentMs: 0, sourceStartMs: 0 });
  p = setLayerTiming(p, 'pip', 'end', 0, 4000);
  p = setLayerTiming(p, 'pip', 'move', 2000, 6000);
  p = splitVideoClip(p, p.clips[0].id, 4000, 'main-left', 'main-right').project;
  p = reorderVideoClip(p, 'main-right', 0).project;
  p = saved(setLayerTiming(p, 'pip', 'start', 1000, 8000));
  return saved(setLayerTiming(p, 'pip', 'start', 0, 8000));
}

test('Samsung reordered PiP position edit retains the restored 0..8s sparse projection', () => {
  const p = samsungReorderedRecovery();
  const expected = [[6000, 8000, 0, 2000], [0, 2000, 2000, 4000]];
  checkChain(p, expected);
  assert.equal(layer(p).sourceStartMs, 2000);
  const moved = setVideoLayer(p, 'pip', { position: { x: 0.3, y: 0.4 } });
  assert.equal(layer(moved).endMs, 8000);
  assert.equal(layer(moved).startMs, 0);
  assert.deepEqual(layer(moved).sourceAnchors, layer(p).sourceAnchors);
  assert.deepEqual(layer(moved).sourceMapping, layer(p).sourceMapping);
  checkChain(saved(moved), expected);
});

for (const patch of [
  { position: { x: 0.2, y: 0.3 } }, { box: { width: 0.4, height: 0.2 } },
  { rotation: 35 }, { scale: 1.4, scaleX: 0.8, scaleY: 1.2 },
  { opacity: 0.4 }, { visible: false }, { includeAudio: false }, { name: 'Moved PiP' },
]) test(`restored sparse PiP ${Object.keys(patch)} patch preserves timing and selected frames`, () => {
  const p = samsungReorderedRecovery();
  const before = JSON.stringify(p);
  const edited = setVideoLayer(p, 'pip', patch);
  const restored = saved(edited);
  for (const key of ['startMs', 'endMs', 'sourceStartMs', 'sourceStartAtAnchorMs', 'sourceDurationMs',
    'playbackRate', 'sourceMapping', 'sourceAnchors', 'mediaEndMs', 'timingMode', 'timelineVisible']) {
    assert.deepEqual(layer(edited)[key], layer(p)[key], key);
    assert.deepEqual(layer(restored)[key], layer(p)[key], `saved ${key}`);
  }
  for (const [key, value] of Object.entries(patch)) assert.deepEqual(layer(restored)[key], value);
  assert.deepEqual(segments(restored), segments(p));
  const plan = buildTimelineRenderPlan(restored);
  const picture = plan.layers.filter(l => l.id === 'pip');
  const audio = plan.audioClips.filter(c => c.id.startsWith('overlay-audio:pip'));
  assert.deepEqual(picture.map(l => [l.startMs, l.endMs, l.sourceStartMs]),
    patch.visible === false ? [] : segments(p).map(s => s.slice(0, 3)));
  assert.deepEqual(audio.map(c => [c.startMs, c.sourceStartMs, c.sourceEndMs]),
    patch.visible === false || patch.includeAudio === false ? [] : segments(p).map(s => [s[0], s[2], s[3]]));
  assert.equal(JSON.stringify(p), before, 'editing must not mutate the original ownership');
});

test('preview gesture commit uses the current source projection, including a stale cached envelope', () => {
  const p = samsungReorderedRecovery();
  const geometry = resolveLayerGeometry(layer(p));
  // Ownership remains authoritative even if an older edit left a shortened cache.
  layer(p).endMs = 6000;
  const edited = applyPreviewSceneGeometry(p, {
    key: 'video-overlay:pip', order: 0, deletable: true,
    selection: { kind: 'video-overlay', id: 'pip' }, geometry,
  }, { ...geometry, position: { x: 0.25, y: 0.35 } });
  assert.equal(layer(edited).endMs, 8000);
  assert.deepEqual(layer(edited).position, { x: 0.25, y: 0.35 });
  checkChain(saved(edited), [[6000, 8000, 0, 2000], [0, 2000, 2000, 4000]]);
});

for (const legacy of [false, true]) for (const rate of [0.5, 1.5, 2])
  test(`geometry preserves sparse recovery at owner rate ${rate}, legacy mapping ${legacy}`, () => {
    let p = fixture({ currentMs: 3000, sourceStartMs: 500, owners: 2 });
    p = setVideoClipGap(p, p.clips[1].id, 1000).project;
    if (legacy) delete layer(p).sourceMapping;
    p = setClipPlaybackRate(p, p.clips[0].id, rate);
    const before = segments(p);
    const anchors = structuredClone(layer(p).sourceAnchors);
    p = saved(setVideoLayer(p, 'pip', { rotation: 20 }));
    assert.deepEqual(layer(p).sourceAnchors, anchors);
    checkChain(p, before);
    p = saved(setVideoLayerPlaybackRate(p, 'pip', 1.5));
    const capped = segments(p);
    p = saved(setVideoLayer(p, 'pip', { position: { x: 0.4, y: 0.6 } }));
    checkChain(p, capped);
    p = saved(setVideoLayerPlaybackRate(p, 'pip', 1));
    checkChain(p, before);
  });

test('geometry preserves a capped selection and hidden owner associations until recovery', () => {
  let p = samsungReorderedRecovery();
  p = saved(setLayerTiming(p, 'pip', 'end', 0, 7000));
  const bound = layer(p).mediaEndMs;
  const before = segments(p);
  p = trimVideoClip(p, 'main-left', 'end', 1000).project;
  const hidden = structuredClone(layer(p).sourceAnchors);
  assert.equal(segments(p).length, 1);
  p = saved(setVideoLayer(p, 'pip', { box: { width: 0.5, height: 0.3 } }));
  assert.deepEqual(layer(p).sourceAnchors, hidden);
  assert.equal(layer(p).mediaEndMs, bound);
  p = saved(trimVideoClip(p, 'main-left', 'end', 4000).project);
  checkChain(p, before);
});

test('fully hidden and deleted owner selections remain hidden through geometry edits', () => {
  let p = fixture();
  const owner = p.clips[0].id;
  const before = segments(p);
  p = trimVideoClip(p, owner, 'start', 5000).project;
  const anchors = structuredClone(layer(p).sourceAnchors);
  assert.equal(layer(p).timelineVisible, false);
  p = saved(setVideoLayer(p, 'pip', { position: { x: 0.2, y: 0.7 } }));
  assert.equal(layer(p).timelineVisible, false);
  assert.deepEqual(layer(p).sourceAnchors, anchors);
  p = saved(trimVideoClip(p, owner, 'start', 0).project);
  checkChain(p, before);
  p = deleteVideoClip(p, owner).project;
  const tombstone = structuredClone(layer(p));
  p = setVideoLayer(p, 'pip', { rotation: 10 });
  assert.equal(layer(p).timelineVisible, false);
  assert.deepEqual(layer(p).sourceAnchors, tombstone.sourceAnchors);
  assert.deepEqual(segments(p), []);
});

test('timeline ownership and explicit time/source changes retain contiguous availability limits', () => {
  const p = samsungReorderedRecovery();
  const independent = setVideoLayer(p, 'pip', { timingMode: 'timeline', sourceAnchors: undefined, sourceMapping: undefined });
  assert.equal(layer(independent).endMs, 6000);
  assert.deepEqual(segments(independent), [[0, 6000, 2000, 8000]]);
  const moved = saved(setVideoLayer(independent, 'pip', { position: { x: 0.2, y: 0.3 } }));
  assert.deepEqual(segments(moved), segments(independent));
  for (const patch of [{ endMs: 20000 }, { sourceStartMs: 7000, endMs: 8000 },
    { sourceDurationMs: 5000 }, { playbackRate: 2 }]) {
    const edited = setVideoLayer(p, 'pip', patch);
    const l = layer(edited);
    assert.ok(l.endMs <= l.startMs + (l.sourceDurationMs - l.sourceStartMs) / l.playbackRate);
    assert.equal(l.sourceMapping, undefined);
    for (const s of segments(saved(edited))) assert.ok(s[3] <= l.sourceDurationMs);
  }
});

test('owner-aware geometry still rejects invalid media scalars, timing and geometry', () => {
  const p = samsungReorderedRecovery();
  for (const patch of [{ sourceDurationMs: NaN }, { sourceDurationMs: 3000 }, { sourceStartMs: Infinity }, { playbackRate: 0 },
    { mediaEndMs: Infinity }, { mediaEndMs: 8001 }, { startMs: NaN }, { endMs: Infinity },
    { startMs: 100, endMs: 110 }, { position: { x: NaN, y: 0.5 } },
    { box: { width: 0, height: 0.2 } }, { rotation: Infinity }, { scaleX: -1 }]) {
    assert.throws(() => setVideoLayer(p, 'pip', { position: { x: 0.2, y: 0.3 }, ...patch }));
  }
  // A cosmetic patch must validate the existing media metadata too.
  const invalid = structuredClone(p);
  layer(invalid).playbackRate = NaN;
  assert.throws(() => setVideoLayer(invalid, 'pip', { opacity: 0.5 }));
});

function checkChain(p, expected, id = 'pip') {
  assert.deepEqual(segments(p, id), expected);
  const plan = buildTimelineRenderPlan(p);
  assert.deepEqual(plan.layers.filter(l => l.id === id).map(l => [l.startMs, l.endMs, l.sourceStartMs]),
    expected.map(s => s.slice(0, 3)));
  assert.deepEqual(plan.audioClips.filter(c => c.id.startsWith(`overlay-audio:${id}`))
    .map(c => [c.startMs, c.sourceStartMs, c.sourceEndMs]), expected.map(s => [s[0], s[2], s[3]]));
  assert.deepEqual(buildTimelineAudioRenderPlan(p).audioClips.filter(c => c.id === `overlay-audio:${id}`)
    .map(c => [c.timelineStartMs, c.timelineEndMs, c.sourceStartMs, c.sourceEndMs]), expected);
  for (const [start, end, source] of expected) {
    const ms = (start + end) / 2;
    const state = overlayPlaybackState(layer(p, id), ms, true, p.clips);
    assert.equal(state.visible, true);
    assert.ok(Math.abs(state.seconds * 1000 - (source + (ms - start) * layer(p, id).playbackRate)) < 1e-6);
  }
  assert.equal(layer(p, id).timingMode, 'source');
}

test('native 8s end-add, move left 3000, right extension restores available media through preview/export', () => {
  const initial = fixture({ currentMs: 8000, sourceStartMs: 0 });
  assert.deepEqual(segments(initial), [[7920, 8000, 0, 80]]);
  const moved = setLayerTiming(initial, 'pip', 'move', 4920, 5000);
  assert.deepEqual(segments(moved), [[4920, 5000, 0, 80]]);
  const extended = setLayerTiming(moved, 'pip', 'end', 4920, 8000);
  checkChain(saved(extended), [[4920, 8000, 0, 3080]]);
  checkChain(setLayerTiming(extended, 'pip', 'start', 0, 8000), [[4920, 8000, 0, 3080]]);
});

for (const rate of [0.5, 1, 1.5, 2]) test(`trim/restore both edges, move and persisted clone with owner rate ${rate}`, () => {
  const original = fixture({ rate });
  const end = layer(original).endMs;
  let p = setLayerTiming(original, 'pip', 'start', 1250, end);
  p = saved(setLayerTiming(p, 'pip', 'end', 1250, end - 250));
  p = setLayerTiming(p, 'pip', 'start', 1000, end - 250);
  p = saved(setLayerTiming(p, 'pip', 'end', 1000, end));
  checkChain(p, [[1000, end, 500, 500 + end - 1000]]);
  const copy = duplicateVisualLayer(p, 'pip', 'clone').project;
  const moved = setLayerTiming(copy, 'clone', 'move', 500, end - 500);
  checkChain(moved, [[500, end - 500, 500, 500 + end - 1000]], 'clone');
  assert.deepEqual(layer(moved), layer(p));
  for (const key of ['clips', 'sources', 'captions', 'captionTracks', 'audioClips']) assert.deepEqual(p[key], saved(original)[key]);
  assert.deepEqual(p.layers.map(l => l.id), original.layers.map(l => l.id));
  for (const key of ['position', 'box', 'opacity', 'rotation', 'uri', 'playbackRate']) assert.deepEqual(layer(p)[key], layer(original)[key]);
});

test('available source duration bounds explicit extension; previous selection can grow repeatedly', () => {
  let p = fixture({ sourceStartMs: 7000 });
  checkChain(setLayerTiming(p, 'pip', 'end', 1000, 8000), [[1000, 2000, 7000, 8000]]);
  p = fixture();
  layer(p).mediaEndMs = 2000;
  for (let i = 0; i < 3; i++) {
    p = setLayerTiming(p, 'pip', 'end', 1000, 1500);
    p = saved(setLayerTiming(p, 'pip', 'end', 1000, 8000));
    checkChain(p, [[1000, 8000, 500, 7500]]);
    assert.equal(layer(p).mediaEndMs, 7500);
  }
});

test('explicitly resizing a split selects more media without changing its sibling', () => {
  const split = splitVisualLayer(fixture(), 'pip', 2000, 'left', 'right');
  assert.ok(split);
  let p = setLayerTiming(split.project, 'left', 'end', 1000, 1500);
  p = saved(setLayerTiming(p, 'left', 'end', 1000, 8000));
  checkChain(p, [[1000, 8000, 500, 7500]], 'left');
  assert.deepEqual(layer(p, 'right'), layer(saved(split.project), 'right'));
});

test('fragmented PiP recovers within boundary owners without consuming their gap', () => {
  let p = fixture({ currentMs: 3000, sourceStartMs: 500, owners: 2 });
  p = setVideoClipGap(p, p.clips[1].id, 1000).project;
  const before = segments(p);
  p = setLayerTiming(p, 'pip', 'start', 3250, layer(p).endMs);
  p = setLayerTiming(p, 'pip', 'end', 3250, layer(p).endMs - 250);
  p = saved(setLayerTiming(p, 'pip', 'start', 3000, layer(p).endMs));
  p = saved(setLayerTiming(p, 'pip', 'end', 3000, before.at(-1)[1]));
  checkChain(p, before);
  assert.equal(overlayPlaybackState(layer(p), 4500, true, p.clips).visible, false);
  assert.deepEqual(layer(p).sourceAnchors.map(a => a.clipId), p.clips.map(c => c.id));
  const ownerTrim = trimVideoClip(p, p.clips[0].id, 'start', 200).project;
  checkChain(trimVideoClip(ownerTrim, p.clips[0].id, 'start', 0).project, before);
});

test('invalid/no-op timing and minimum interval preserve valid source ownership', () => {
  const p = fixture();
  assert.equal(setLayerTiming(p, 'missing', 'end', 0, 8000), p);
  assert.equal(setLayerTiming(p, 'pip', 'end', NaN, NaN), p);
  assert.equal(setLayerTiming(p, 'pip', 'start', 1000, 4000), p);
  const short = setLayerTiming(p, 'pip', 'end', 1000, -Infinity);
  assert.equal(short, p);
  checkChain(setLayerTiming(p, 'pip', 'end', 1000, -100), [[1000, 1080, 500, 580]]);
});


test('split selects its last frame; manual extension preserves earlier fragments and sibling', () => {
  let p = fixture({ currentMs: 3000, sourceStartMs: 500, owners: 2 });
  p = setVideoClipGap(p, p.clips[1].id, 1000).project;
  const split = splitVisualLayer(p, 'pip', 6000, 'left', 'right');
  assert.ok(split);
  checkChain(saved(split.project), [[3000, 4000, 500, 1500], [5000, 6000, 1500, 2500]], 'left');
  assert.equal(split.left.mediaEndMs, 2500);
  const shrunk = setLayerTiming(split.project, 'left', 'end', 3000, 5500);
  checkChain(setLayerTiming(shrunk, 'left', 'end', 3000, 9000),
    [[3000, 4000, 500, 1500], [5000, 9000, 1500, 5500]], 'left');
  assert.deepEqual(layer(shrunk, 'right'), layer(split.project, 'right'));
});

test('PiP trim leaves independent images, text, captions, audio and primary footage intact', () => {
  let p = fixture();
  p = addImageLayer(p, { id: 'image', name: 'Image', uri: 'file:///image.png', currentMs: 0, durationMs: 8000 }).project;
  p = createTextLayer(p, 'text', 0, 8000).project;
  p.layers.find(l => l.id === 'image').timingMode = 'timeline';
  p.layers.find(l => l.id === 'text').timingMode = 'timeline';
  p.captions = [{ id: 'cue', text: 'Existing caption', startMs: 0, endMs: 1000, timingMode: 'timeline', wordIds: [] }];
  p.audioClips = [{ id: 'wav', sourceId: 'wav-source', sourceStartMs: 0, sourceEndMs: 8000, startMs: 0, playbackRate: 1, volume: 1 }];
  const before = structuredClone(p);
  const edited = setLayerTiming(setLayerTiming(p, 'pip', 'start', 1250, 4000), 'pip', 'end', 1250, 7000);
  for (const key of Object.keys(before).filter(k => !['layers', 'updatedAt'].includes(k))) assert.deepEqual(edited[key], before[key]);
  assert.deepEqual(edited.layers.filter(l => l.id !== 'pip'), before.layers.filter(l => l.id !== 'pip'));
  assert.deepEqual(edited.layers.map(l => l.id), before.layers.map(l => l.id));
});


for (const playbackRate of [0.5, 1.5, 2]) test(`overlay rate ${playbackRate} recovers original frames after both edge trims`, () => {
  const original = fixture({ rate: 1.5, playbackRate });
  let p = setLayerTiming(original, 'pip', 'start', 1250, 4000);
  p = setLayerTiming(p, 'pip', 'end', 1250, 3750);
  p = saved(setLayerTiming(p, 'pip', 'start', 1000, 3750));
  p = saved(setLayerTiming(p, 'pip', 'end', 1000, 4000));
  checkChain(p, segments(original));
});

test('explicit end extension reacquires current footage without filling the owner gap', () => {
  let p = fixture({ currentMs: 3000, owners: 2 });
  p = setVideoClipGap(p, p.clips[1].id, 1000).project;
  p = saved(setLayerTiming(p, 'pip', 'end', 3000, 4500));
  const currentOwners = p.clips.map(c => c.id);
  p = setLayerTiming(p, 'pip', 'end', 3000, 9000);
  assert.deepEqual(layer(p).sourceAnchors.map(a => a.clipId), currentOwners);
  checkChain(p, [[3000, 4000, 500, 1500], [5000, 9000, 1500, 5500]]);
});

// Explicit range changes select available media; automatic remapping retains selection.
test('explicit end restore reacquires the still-present original owner across a gap', () => {
  let p = fixture({ currentMs: 3000, sourceStartMs: 0, owners: 2 });
  p = setVideoClipGap(p, p.clips[1].id, 1000).project;
  p = saved(setLayerTiming(p, 'pip', 'end', 3000, 7000));
  const original = segments(p);
  p = saved(setLayerTiming(p, 'pip', 'end', 3000, 4500));
  checkChain(p, [[3000, 4000, 0, 1000]]);
  checkChain(saved(setLayerTiming(p, 'pip', 'end', 3000, 7000)), original);
});

test('explicit end extension selects beyond a prior speed selection', () => {
  let p = setVideoLayerPlaybackRate(fixture({ sourceStartMs: 0 }), 'pip', 2);
  const start = layer(p).startMs;
  p = saved(setLayerTiming(p, 'pip', 'end', start, 5000));
  checkChain(p, [[1000, 5000, 0, 8000]]);
  assert.equal(layer(p).mediaEndMs, 8000);
});

for (const edge of ['start', 'end']) test(`editing ${edge} preserves latent ownership at the opposite edge`, () => {
  const original = fixture({ sourceStartMs: 1000 });
  const owner = original.clips[0].id;
  let p = trimVideoClip(original, owner, edge === 'end' ? 'start' : 'end', edge === 'end' ? 1500 : 3000).project;
  p = saved(setLayerTiming(p, 'pip', edge, edge === 'start' ? 1250 : layer(p).startMs,
    edge === 'end' ? layer(p).endMs - 250 : layer(p).endMs));
  p = saved(trimVideoClip(p, owner, edge === 'end' ? 'start' : 'end', edge === 'end' ? 0 : 8000).project);
  checkChain(p, edge === 'end' ? [[1000, 3750, 1000, 3750]] : [[1250, 4000, 1250, 4000]]);
});

for (const timingMode of ['timeline', undefined]) test(`explicit non-source selection replaces stale cap (${timingMode})`, () => {
  let p = fixture({ sourceStartMs: 0 });
  Object.assign(layer(p), { timingMode, sourceAnchors: undefined, mediaEndMs: 1000 });
  p = saved(setLayerTiming(p, 'pip', 'end', 1000, 6000));
  assert.deepEqual(segments(p), [[1000, 6000, 0, 5000]]);
  assert.equal(layer(p).mediaEndMs, 5000);
  assert.equal(layer(p).timingMode, timingMode === 'timeline' ? 'timeline' : 'source');
});

test('a media-zero clamped extension and hidden layer preserve history identity', () => {
  const p = fixture({ sourceStartMs: 0 });
  assert.equal(setLayerTiming(p, 'pip', 'start', 0, 4000), p);
  const hidden = trimVideoClip(p, p.clips[0].id, 'end', 500).project;
  assert.equal(layer(hidden).timelineVisible, false);
  assert.equal(setLayerTiming(hidden, 'pip', 'end', 0, 8000), hidden);
});

for (const edge of ['start', 'end']) test(`editing ${edge} preserves a fully hidden opposite owner`, () => {
  let p = fixture({ currentMs: 3000, sourceStartMs: 500, owners: 2 });
  p = setVideoClipGap(p, p.clips[1].id, 1000).project;
  p = setLayerTiming(p, 'pip', 'end', 3000, 7000);
  const owner = p.clips[edge === 'end' ? 0 : 1].id;
  p = trimVideoClip(p, owner, edge === 'end' ? 'end' : 'start', edge === 'end' ? 2000 : 3000).project;
  p = saved(setLayerTiming(p, 'pip', edge, edge === 'start' ? 3250 : layer(p).startMs,
    edge === 'end' ? layer(p).endMs - 250 : layer(p).endMs));
  p = saved(trimVideoClip(p, owner, edge === 'end' ? 'end' : 'start', edge === 'end' ? 4000 : 0).project);
  checkChain(p, edge === 'end' ? [[3000, 4000, 500, 1500], [5000, 6750, 1500, 3250]]
    : [[3250, 4000, 750, 1500], [5000, 7000, 1500, 3500]]);
});

test('explicit expansion preserves deliberate interior fragment holes', () => {
  let p = fixture({ currentMs: 1000, sourceStartMs: 1000 });
  const owner = p.clips[0].id;
  layer(p).sourceAnchors = [
    { clipId: owner, sourceStartMs: 1000, sourceEndMs: 2000 },
    { clipId: owner, sourceStartMs: 3000, sourceEndMs: 4000 },
  ];
  p = saved(setLayerTiming(p, 'pip', 'end', 1000, 6000));
  checkChain(p, [[1000, 2000, 1000, 2000], [3000, 6000, 2000, 5000]]);
  p = saved(setLayerTiming(p, 'pip', 'start', 500, 6000));
  checkChain(p, [[500, 2000, 500, 2000], [3000, 6000, 2000, 5000]]);
  assert.equal(overlayPlaybackState(layer(p), 2500, true, p.clips).visible, false);
});

for (const rate of [0.5, 1.5, 2]) for (const playbackRate of [0.5, 1.5, 2])
  test(`whole-owner recovery across gaps: owner ${rate}, overlay ${playbackRate}`, () => {
    let p = fixture({ currentMs: 4000 / rate - 1000, sourceStartMs: 0, owners: 2, rate, playbackRate });
    p = setVideoClipGap(p, p.clips[1].id, 1000).project;
    const original = segments(p);
    assert.equal(original.length, 2);
    p = saved(setLayerTiming(p, 'pip', 'end', 0, original[0][1] + 500));
    p = saved(setLayerTiming(p, 'pip', 'end', 0, original.at(-1)[1]));
    checkChain(p, original);
  });

test('deleted owners stay detached through automatic trim/restore and speed remapping', () => {
  let p = fixture({ currentMs: 3000, sourceStartMs: 0, owners: 2 });
  const removed = p.clips[1].id;
  p = deleteVideoClip(p, removed).project;
  const original = segments(p);
  p = trimVideoClip(p, p.clips[0].id, 'start', 500).project;
  p = trimVideoClip(p, p.clips[0].id, 'start', 0).project;
  p = setClipPlaybackRate(setClipPlaybackRate(p, p.clips[0].id, 2), p.clips[0].id, 1);
  checkChain(saved(p), original);
  assert.ok(!layer(p).sourceAnchors.some(a => a.clipId === removed));
});

test('split selection survives automatic owner trim/restore and reversible speed edits', () => {
  const split = splitVisualLayer(fixture(), 'pip', 2000, 'left', 'right');
  let p = split.project;
  const before = segments(p, 'left');
  p = trimVideoClip(p, p.clips[0].id, 'start', 1500).project;
  p = trimVideoClip(p, p.clips[0].id, 'start', 0).project;
  p = setClipPlaybackRate(setClipPlaybackRate(p, p.clips[0].id, 2), p.clips[0].id, 1);
  checkChain(saved(p), before, 'left');
  assert.equal(layer(p, 'left').mediaEndMs, 1500);
  assert.deepEqual(layer(saved(p), 'right'), layer(saved(split.project), 'right'));
});

for (const edge of ['start', 'end']) test(`split explicitly bounds both halves after owner ${edge} trim`, () => {
  let p = fixture({ sourceStartMs: 1000 });
  p = trimVideoClip(p, p.clips[0].id, edge, edge === 'start' ? 1500 : 3000).project;
  const splitMs = (layer(p).startMs + layer(p).endMs) / 2;
  const split = splitVisualLayer(p, 'pip', splitMs, 'left', 'right');
  assert.ok(split);
  const before = ['left', 'right'].map(id => segments(split.project, id));
  p = trimVideoClip(split.project, p.clips[0].id, edge, edge === 'start' ? 0 : 8000).project;
  const offset = edge === 'start' ? 1500 : 0;
  for (const [i, id] of ['left', 'right'].entries()) checkChain(saved(p), before[i].map(s => [s[0] + offset, s[1] + offset, s[2], s[3]]), id);
});

for (const rate of [0.5, 1.5, 2]) test(`explicit head restore reacquires a removed first owner at rate ${rate}`, () => {
  let p = fixture({ currentMs: 4000 / rate - 1000, sourceStartMs: 0, owners: 2, rate });
  p = setVideoClipGap(p, p.clips[1].id, 1000).project;
  const original = segments(p);
  p = saved(setLayerTiming(p, 'pip', 'start', original[1][0] + 250, layer(p).endMs));
  assert.equal(layer(p).sourceAnchors.length, 1);
  p = saved(setLayerTiming(p, 'pip', 'start', original[0][0], layer(p).endMs));
  checkChain(p, original);
});

test('available-media-end clamped extension preserves history identity', () => {
  const p = fixture({ sourceStartMs: 7000 });
  assert.equal(setLayerTiming(p, 'pip', 'end', layer(p).startMs, 8000), p);
});


test('actual factory reordered owners preserve exact frames through partial and whole head recovery', () => {
  let p = createCaptionProject({ id: 'reordered-root', name: 'Reordered', sources: ['a', 'b'].map(id => ({
    id, uri: `file:///${id}.mp4`, storageMode: 'copied', displayName: `${id}.mp4`,
    durationMs: 4000, width: 360, height: 640, rotation: 0,
  })) });
  p = addVideoLayer(p, { id: 'pip', name: 'PiP', uri: 'file:///pip.mp4', currentMs: 3000,
    durationMs: 8000, sourceStartMs: 0, sourceDurationMs: 8000, playbackRate: 1, includeAudio: true }).project;
  p = reorderVideoClip(p, p.clips[1].id, 0).project;
  const before = [[7000, 8000, 0, 1000], [0, 2000, 1000, 3000]];
  checkChain(p, before);
  for (const start of [1000, 2500]) {
    const trimmed = saved(setLayerTiming(p, 'pip', 'start', start, 8000));
    checkChain(trimmed, start === 1000 ? [[7000, 8000, 0, 1000], [1000, 2000, 2000, 3000]] : [[7000, 8000, 0, 1000]]);
    checkChain(saved(setLayerTiming(trimmed, 'pip', 'start', 0, 8000)), before);
  }
});


function threeOwners(rate = 1) {
  let p = createCaptionProject({ id: 'three', name: 'Three', sources: ['a', 'b', 'c'].map(id => ({
    id, uri: `file:///${id}.mp4`, storageMode: 'copied', displayName: `${id}.mp4`,
    durationMs: 6000, width: 360, height: 640, rotation: 0,
  })) });
  for (const owner of p.clips) p = setClipPlaybackRate(p, owner.id, rate);
  p = addVideoLayer(p, { id: 'pip', name: 'PiP', uri: 'file:///pip.mp4', currentMs: 3000 / rate,
    durationMs: 30000, sourceStartMs: 1000, sourceDurationMs: 30000, includeAudio: true }).project;
  return setLayerTiming(p, 'pip', 'end', 3000 / rate, 15000 / rate);
}
function reorderOwners(p, order) {
  const ids = p.clips.map(c => c.id);
  for (const [index, owner] of order.entries()) p = reorderVideoClip(p, ids[owner], index)?.project ?? p;
  return saved(p);
}
function assertFrames(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) for (let j = 0; j < 4; j++)
    assert.ok(Math.abs(actual[i][j] - expected[i][j]) < 1e-7, `${actual[i]} != ${expected[i]}`);
}
for (const rate of [0.5, 1.5, 2]) for (const order of [[1, 2, 0], [2, 0, 1], [2, 1, 0]])
  for (const edge of ['start', 'end']) for (const whole of [false, true])
    test(`three owners ${order}, rate ${rate}, ${edge}, whole ${whole}: selective frames and recovery`, () => {
      const initial = threeOwners(rate);
      const p = reorderOwners(initial, order);
      const before = segments(p);
      const chronological = [...before].sort((a, b) => a[0] - b[0]);
      const boundary = edge === 'start' ? chronological[0] : chronological.at(-1);
      const cut = edge === 'start' ? (whole ? boundary[1] + 100 : boundary[0] + 200)
        : (whole ? boundary[0] - 100 : boundary[1] - 200);
      const expected = before.flatMap(s => {
        const start = edge === 'start' ? Math.max(s[0], cut) : s[0];
        const end = edge === 'end' ? Math.min(s[1], cut) : s[1];
        return end > start ? [[start, end, s[2] + start - s[0], s[3] - (s[1] - end)]] : [];
      });
      const trimmed = saved(setLayerTiming(p, 'pip', edge, edge === 'start' ? cut : layer(p).startMs,
        edge === 'end' ? cut : layer(p).endMs));
      assertFrames(segments(trimmed), expected);
      checkChain(trimmed, segments(trimmed));
      const restored = saved(setLayerTiming(trimmed, 'pip', edge, layer(p).startMs, layer(p).endMs));
      assertFrames(segments(restored), before);
      checkChain(restored, segments(restored));
      // A different main owner rate changes automatic elapsed consumption and remains reversible.
      const owner = restored.clips[1].id;
      const sped = saved(setClipPlaybackRate(restored, owner, rate === 2 ? 1 : 2));
      const back = saved(setClipPlaybackRate(sped, owner, rate));
      assertFrames(segments(back), before);
    });

test('retained mapping survives main split, deletion and hidden-owner trim restore after reorder', () => {
  let p = reorderOwners(threeOwners(), [2, 0, 1]);
  p = saved(setLayerTiming(p, 'pip', 'start', layer(p).startMs + 200, layer(p).endMs));
  const before = segments(p);
  const owner = p.clips[1].id;
  p = splitVideoClip(p, owner, 10500, 'main-left', 'main-right').project;
  const divided = segments(p);
  assert.equal(divided.length, before.length + 1);
  checkChain(saved(p), divided);
  p = trimVideoClip(p, 'main-right', 'start', 5000).project;
  p = saved(trimVideoClip(p, 'main-right', 'start', 4500).project);
  assertFrames(segments(p), divided);
  const deleted = p.clips[0].id;
  p = saved(deleteVideoClip(p, deleted).project);
  assert.ok(!layer(p).sourceMapping.some(a => a.clipId === deleted));
  assert.ok(!layer(p).sourceAnchors.some(a => a.clipId === deleted));
  const survivors = segments(p);
  p = saved(setClipPlaybackRate(setClipPlaybackRate(p, p.clips[0].id, 2), p.clips[0].id, 1));
  assertFrames(segments(p), survivors);
  checkChain(p, segments(p));
});

test('reordered sparse selection overlay speed is saveable and reversible without expanding selected bound', () => {
  let p = reorderOwners(threeOwners(), [2, 0, 1]);
  p = saved(setLayerTiming(p, 'pip', 'start', 1000, layer(p).endMs));
  const before = segments(p), bound = layer(p).mediaEndMs;
  const sped = saved(setVideoLayerPlaybackRate(p, 'pip', 2));
  assert.equal(layer(sped).mediaEndMs, bound);
  const back = saved(setVideoLayerPlaybackRate(sped, 'pip', 1));
  assertFrames(segments(back), before);
});

test('new association basis remains independent when a duplicate is edited', () => {
  const p = setLayerTiming(threeOwners(), 'pip', 'start', 3500, 15000);
  const before = structuredClone(p);
  const copy = duplicateVisualLayer(p, 'pip', 'copy').project;
  assert.notEqual(layer(copy, 'copy').sourceMapping, layer(p).sourceMapping);
  assert.notEqual(layer(copy, 'copy').sourceMapping[0], layer(p).sourceMapping[0]);
  const edited = setLayerTiming(copy, 'copy', 'end', 3500, 10000);
  assert.deepEqual(p, before);
  assert.deepEqual(layer(edited), layer(p));
});


for (const edge of ['start', 'end']) test(`reordered association with a gap and interior hole preserves ${edge} survivors`, () => {
  let p = threeOwners();
  p = setVideoClipGap(p, p.clips[1].id, 1000).project;
  // Author a sparse legacy association to exercise conversion without invented frames.
  delete layer(p).sourceMapping;
  layer(p).sourceAnchors = [
    { clipId: p.clips[0].id, sourceStartMs: 3000, sourceEndMs: 4000 },
    { clipId: p.clips[0].id, sourceStartMs: 5000, sourceEndMs: 6000 },
    { clipId: p.clips[1].id, sourceStartMs: 0, sourceEndMs: 4000 },
    { clipId: p.clips[2].id, sourceStartMs: 0, sourceEndMs: 3000 },
  ];
  p = reorderOwners(p, [1, 2, 0]);
  const before = segments(p);
  const start = layer(p).startMs, end = layer(p).endMs;
  const trimmed = saved(setLayerTiming(p, 'pip', edge, edge === 'start' ? start + 250 : start,
    edge === 'end' ? end - 250 : end));
  const expected = before.map(s => edge === 'start' && s[0] === start ? [s[0] + 250, s[1], s[2] + 250, s[3]]
    : edge === 'end' && s[1] === end ? [s[0], s[1] - 250, s[2], s[3] - 250] : s);
  assertFrames(segments(trimmed), expected);
  const restored = saved(setLayerTiming(trimmed, 'pip', edge, start, end));
  assertFrames(segments(restored), before);
  checkChain(restored, segments(restored));
});

for (const edge of ['start', 'end']) test(`reordered edit preserves a fully main-hidden opposite owner while editing ${edge}`, () => {
  let p = reorderOwners(threeOwners(), [2, 1, 0]);
  const hiddenOwner = p.clips[edge === 'end' ? 0 : 2].id;
  const before = segments(p);
  const originalBoundary = edge === 'start' ? layer(p).startMs : layer(p).endMs;
  p = trimVideoClip(p, hiddenOwner, edge === 'end' ? 'start' : 'end', edge === 'end' ? 5000 : 2000).project;
  assert.equal(segments(p).length, before.length - 1);
  p = saved(setLayerTiming(p, 'pip', edge, edge === 'start' ? layer(p).startMs + 250 : layer(p).startMs,
    edge === 'end' ? layer(p).endMs - 250 : layer(p).endMs));
  p = saved(trimVideoClip(p, hiddenOwner, edge === 'end' ? 'start' : 'end', edge === 'end' ? 0 : 6000).project);
  const expected = before.map(s => edge === 'start' && s[0] === originalBoundary ? [s[0] + 250, s[1], s[2] + 250, s[3]]
    : edge === 'end' && s[1] === originalBoundary ? [s[0], s[1] - 250, s[2], s[3] - 250] : s);
  assertFrames(segments(p), expected);
  checkChain(p, segments(p));
});

for (const edge of ['start', 'end', 'move', 'both']) test(`source mapping timing rejects nonfinite ${edge} and preserves the 80ms minimum`, () => {
  const p = setLayerTiming(threeOwners(), 'pip', 'start', 3500, 15000);
  assert.equal(setLayerTiming(p, 'pip', edge, NaN, Infinity), p);
  assert.equal(setLayerTiming(p, 'pip', edge, -Infinity, NaN), p);
  const shortened = setLayerTiming(p, 'pip', 'end', layer(p).startMs, layer(p).startMs + 1);
  assert.equal(layer(shortened).endMs - layer(shortened).startMs, 80);
});


test('explicit source patch and moving a mapped PiP discard the old association basis', () => {
  const p = setLayerTiming(threeOwners(), 'pip', 'start', 3500, 15000);
  const patched = saved(setVideoLayer(p, 'pip', { startMs: 1000, endMs: 2000, sourceStartMs: 300 }));
  checkChain(patched, [[1000, 2000, 300, 1300]]);
  assert.equal(layer(patched).sourceMapping, undefined);
  const moved = saved(setLayerTiming(p, 'pip', 'move', 1000, 12500));
  assert.equal(layer(moved).sourceMapping, undefined);
  checkChain(moved, [[1000, 6000, 1500, 6500], [6000, 12000, 6500, 12500], [12000, 12500, 12500, 13000]]);
});


test('visual split of reordered mapping preserves exact frame selections and independent recovery', () => {
  const p = reorderOwners(threeOwners(), [2, 0, 1]);
  const split = splitVisualLayer(p, 'pip', 10000, 'left', 'right');
  assert.ok(split);
  const expectedLeft = [[9000, 10000, 1000, 2000], [0, 3000, 10000, 13000]];
  const expectedRight = [[10000, 12000, 2000, 4000], [12000, 18000, 4000, 10000]];
  checkChain(saved(split.project), expectedLeft, 'left');
  checkChain(saved(split.project), expectedRight, 'right');
  const owner = split.project.clips[1].id;
  let restored = trimVideoClip(split.project, owner, 'end', 4000).project;
  restored = saved(trimVideoClip(restored, owner, 'end', 6000).project);
  checkChain(restored, expectedLeft, 'left');
  checkChain(restored, expectedRight, 'right');
  const edited = saved(setLayerTiming(restored, 'left', 'end', 0, 9500));
  assert.deepEqual(layer(edited, 'right'), layer(saved(restored), 'right'));
});
