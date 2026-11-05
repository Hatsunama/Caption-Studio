import assert from 'node:assert/strict';
import test from 'node:test';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { addVideoLayer, deleteVideoClip, duplicateVisualLayer, setLayerTiming, setVideoLayer, setVideoLayerPlaybackRate, splitVisualLayer, trimVideoClip, setVideoClipGap } from '../src/lib/project-editor.ts';
import { decodePersistedProject } from '../src/lib/project-codec.ts';
import { buildTimelineRenderPlan } from '../src/lib/export-render-plan.ts';
import { buildTimelineAudioRenderPlan } from '../src/lib/timeline-audio-render-plan.ts';
import { overlayPlaybackState } from '../src/lib/video-overlay-playback.ts';
import { setClipPlaybackRate } from '../src/lib/video-timeline.ts';
import { assertExportSourcesAvailable } from '../src/lib/export-source-availability.ts';
import { collectProjectOwnedUris } from '../src/lib/media-lifecycle.ts';
import { visualTimelineTrackId } from '../src/lib/timeline-tracks.ts';

function emptyCanvas(id) {
  const project = createCaptionProject({ id, name: 'Overlay', sources: [{ id: 'base', uri: 'file:///base.mp4',
    storageMode: 'copied', displayName: 'base.mp4', durationMs: 5000, width: 720, height: 1280, rotation: 0 }] });
  project.clips = [];
  return project;
}

test('video overlay keeps geometry, source timing and media through edit, split, save and export', async () => {
  const base = emptyCanvas('overlay-project');
  const added = addVideoLayer(base, { id: 'overlay', name: 'Overlay', uri: 'file:///overlay.mp4', currentMs: 1000,
    durationMs: 4000, sourceStartMs: 500, sourceDurationMs: 7000, playbackRate: 2, includeAudio: true });
  assert.equal(added.layer.kind, 'video');
  const edited = setVideoLayer(added.project, 'overlay', { opacity: 0.6, position: { x: 0.2, y: 0.3 } });
  const duplicated = duplicateVisualLayer(edited, 'overlay', 'copy');
  assert.equal(duplicated.layer.sourceStartMs, 500);
  assert.equal(setVideoLayerPlaybackRate(edited, 'overlay', 4).layers.find((layer) => layer.id === 'overlay').endMs, 2500);
  const split = splitVisualLayer(edited, 'overlay', 2000, 'left', 'right');
  assert.equal(split.right.sourceStartMs, 2500);
  const restored = decodePersistedProject(JSON.stringify(split.project));
  const right = restored.layers.find((layer) => layer.id === 'right');
  assert.equal(right.kind, 'video');
  assert.equal(right.playbackRate, 2);
  assert.equal(right.includeAudio, true);
  assert.deepEqual(right.position, { x: 0.2, y: 0.3 });
  assert.equal(visualTimelineTrackId(right), 'videos');
  assert.ok(collectProjectOwnedUris(restored).includes('file:///overlay.mp4'));
  const plan = buildTimelineRenderPlan(restored);
  assert.deepEqual(plan.audioClips.map((clip) => [clip.startMs, clip.sourceStartMs, clip.sourceEndMs, clip.playbackRate]),
    [[1000, 500, 2500, 2], [2000, 2500, 6500, 2]]);
  assert.deepEqual(plan.layers.filter((layer) => layer.kind === 'video').map((layer) =>
    [layer.id, layer.startMs, layer.endMs, layer.sourceStartMs, layer.playbackRate, layer.opacity]),
    [['left', 1000, 2000, 500, 2], ['right', 2000, 4000, 2500, 2]].map((row) => [...row.slice(0, 5), 0.6]));
  await assertExportSourcesAvailable(plan, {
    image: async () => { throw new Error('video must use media probe'); },
    media: async () => ({ hasVideo: true, hasAudio: true, durationMs: 7000 }),
  });
  await assert.rejects(assertExportSourcesAvailable(plan, {
    image: async () => { throw new Error('video must use media probe'); },
    media: async () => ({ hasVideo: true, hasAudio: true, durationMs: 3000 }),
  }), /trim outside its source duration/);
  await assert.rejects(assertExportSourcesAvailable(plan, {
    image: async () => { throw new Error('video must use media probe'); },
    media: async () => ({ hasVideo: true, hasAudio: false, durationMs: 7000 }),
  }), /audio source/);
});

test('video overlay add, trim and speed stay inside its source', () => {
  const base = emptyCanvas('bounds-project');
  const added = addVideoLayer(base, { id: 'short', name: 'Short', uri: 'file:///short.mp4',
    currentMs: 1000, durationMs: 5000, sourceStartMs: 500, sourceDurationMs: 1500 });
  assert.equal(added.layer.endMs, 2000);
  assert.equal(added.layer.includeAudio, false);
  assert.deepEqual(buildTimelineRenderPlan(added.project).audioClips, []);
  assert.equal(setVideoLayer(added.project, 'short', { endMs: 8000 }).layers.find((layer) => layer.id === 'short').endMs, 2000);
  assert.equal(setVideoLayerPlaybackRate(added.project, 'short', 0.5).layers.find((layer) => layer.id === 'short').endMs, 3000);
  const trimmed = setLayerTiming(added.project, 'short', 'start', 1500, 2000).layers.find((layer) => layer.id === 'short');
  assert.deepEqual([trimmed.startMs, trimmed.sourceStartMs, trimmed.endMs], [1500, 1000, 2000]);
  const overExtended = setLayerTiming(added.project, 'short', 'end', 1000, 5000).layers.find((layer) => layer.id === 'short');
  assert.equal(overExtended.endMs, 2000);
  assert.throws(() => addVideoLayer(base, { id: 'unknown', name: 'Unknown', uri: 'file:///unknown.mp4',
    currentMs: 0, durationMs: 5000 }), /source duration/);
});

test('slowing an overlay cannot place its end beyond the main video timeline', () => {
  const project = createCaptionProject({ id: 'bounded', name: 'Bounded', sources: [{ id: 'base',
    uri: 'file:///base.mp4', storageMode: 'copied', displayName: 'base.mp4',
    durationMs: 5000, width: 720, height: 1280, rotation: 0 }] });
  const added = addVideoLayer(project, { id: 'pip', name: 'PiP', uri: 'file:///pip.mp4',
    currentMs: 4000, durationMs: 5000, sourceDurationMs: 5000 });
  const slowed = setVideoLayerPlaybackRate(added.project, 'pip', 0.25);
  assert.equal(slowed.layers.find((layer) => layer.id === 'pip').endMs, 5000);
});

test('main video head trim and restore keep source-anchored overlay video and audio aligned', () => {
  const base = createCaptionProject({ id: 'owner-trim', name: 'Owner trim', sources: [{ id: 'base',
    uri: 'file:///base.mp4', storageMode: 'copied', displayName: 'base.mp4',
    durationMs: 5000, width: 720, height: 1280, rotation: 0 }] });
  const added = addVideoLayer(base, { id: 'pip', name: 'PiP', uri: 'file:///pip.mp4',
    currentMs: 0, durationMs: 5000, sourceStartMs: 500, sourceDurationMs: 7000,
    playbackRate: 2, includeAudio: true });
  const clipId = base.clips[0].id;
  const trimmed = decodePersistedProject(JSON.stringify(trimVideoClip(added.project, clipId, 'start', 1000).project));
  const trimmedPlan = buildTimelineRenderPlan(trimmed);
  const picture = trimmedPlan.layers.find((layer) => layer.id === 'pip');
  const sound = trimmedPlan.audioClips.find((clip) => clip.id === 'overlay-audio:pip');
  assert.deepEqual([picture.startMs, picture.endMs, picture.sourceStartMs], [0, 2000, 2500]);
  assert.deepEqual([sound.startMs, sound.sourceStartMs, sound.sourceEndMs], [0, 2500, 6500]);

  const restored = decodePersistedProject(JSON.stringify(trimVideoClip(trimmed, clipId, 'start', 0).project));
  const restoredPlan = buildTimelineRenderPlan(restored);
  const restoredPicture = restoredPlan.layers.find((layer) => layer.id === 'pip');
  const restoredSound = restoredPlan.audioClips.find((clip) => clip.id === 'overlay-audio:pip');
  assert.deepEqual([restoredPicture.startMs, restoredPicture.endMs, restoredPicture.sourceStartMs], [0, 3000, 500]);
  assert.deepEqual([restoredSound.startMs, restoredSound.sourceStartMs, restoredSound.sourceEndMs], [0, 500, 6500]);
});


test('fully hidden source-linked overlay restores its original media position', () => {
  const base = createCaptionProject({ id: 'hidden-owner', name: 'Hidden', sources: [{ id: 'base',
    uri: 'file:///base.mp4', storageMode: 'copied', displayName: 'base.mp4',
    durationMs: 5000, width: 720, height: 1280, rotation: 0 }] });
  const added = addVideoLayer(base, { id: 'pip', name: 'PiP', uri: 'file:///pip.mp4',
    currentMs: 0, durationMs: 5000, sourceStartMs: 500, sourceDurationMs: 7000,
    playbackRate: 2, includeAudio: true });
  const owner = base.clips[0].id;
  const partial = trimVideoClip(added.project, owner, 'start', 1000).project;
  assert.equal(partial.layers.find((layer) => layer.id === 'pip').sourceStartMs, 2500);
  const hidden = decodePersistedProject(JSON.stringify(trimVideoClip(partial, owner, 'start', 3500).project));
  assert.equal(hidden.layers.find((layer) => layer.id === 'pip').timelineVisible, false);
  const shown = trimVideoClip(hidden, owner, 'start', 1000).project;
  assert.equal(shown.layers.find((layer) => layer.id === 'pip').sourceStartMs, 2500);
  const restored = trimVideoClip(shown, owner, 'start', 0).project;
  assert.equal(restored.layers.find((layer) => layer.id === 'pip').sourceStartMs, 500);
});

test('older saved video overlays derive anchor media origin before further owner trims', () => {
  const base = createCaptionProject({ id: 'legacy-owner', name: 'Legacy', sources: [{ id: 'base',
    uri: 'file:///base.mp4', storageMode: 'copied', displayName: 'base.mp4',
    durationMs: 5000, width: 720, height: 1280, rotation: 0 }] });
  const added = addVideoLayer(base, { id: 'pip', name: 'PiP', uri: 'file:///pip.mp4',
    currentMs: 0, durationMs: 5000, sourceStartMs: 500, sourceDurationMs: 7000,
    playbackRate: 2, includeAudio: true });
  const owner = base.clips[0].id;
  const legacy = trimVideoClip(added.project, owner, 'start', 1000).project;
  const persisted = JSON.parse(JSON.stringify(legacy));
  const savedLayer = persisted.layers.find((layer) => layer.id === 'pip');
  delete savedLayer.sourceStartAtAnchorMs;
  savedLayer.sourceStartMs = 500; // 1.4.138 retained the pre-trim source start.
  const decoded = decodePersistedProject(JSON.stringify(persisted));
  const retimed = trimVideoClip(decoded, owner, 'start', 1500).project;
  assert.equal(retimed.layers.find((layer) => layer.id === 'pip').sourceStartMs, 3500);
  assert.equal(trimVideoClip(retimed, owner, 'start', 0).project.layers.find((layer) => layer.id === 'pip').sourceStartMs, 500);
});

test('main video speed and overlay reanchor keep frame and audio origins aligned', () => {
  const base = createCaptionProject({ id: 'speed-owner', name: 'Speed', sources: [{ id: 'base',
    uri: 'file:///base.mp4', storageMode: 'copied', displayName: 'base.mp4',
    durationMs: 6000, width: 720, height: 1280, rotation: 0 }] });
  const owner = base.clips[0].id;
  const sped = setClipPlaybackRate(base, owner, 2);
  const added = addVideoLayer(sped, { id: 'pip', name: 'PiP', uri: 'file:///pip.mp4',
    currentMs: 0, durationMs: 3000, sourceStartMs: 500, sourceDurationMs: 6000,
    playbackRate: 1, includeAudio: true });
  const trimmed = trimVideoClip(added.project, owner, 'start', 1000).project;
  assert.equal(trimmed.layers.find((layer) => layer.id === 'pip').sourceStartMs, 1000);
  const shifted = setLayerTiming(trimmed, 'pip', 'start', 500, 2000);
  const moved = shifted.layers.find((layer) => layer.id === 'pip');
  assert.equal(moved.sourceStartMs, 1500);
  const restored = trimVideoClip(shifted, owner, 'start', 0).project;
  const plan = buildTimelineRenderPlan(restored);
  assert.equal(plan.layers.find((layer) => layer.id === 'pip').sourceStartMs, 1500);
  assert.equal(plan.audioClips.find((clip) => clip.id === 'overlay-audio:pip').sourceStartMs, 1500);
});


test('overlay speed edit keeps its selected media bound before later main-video trims', () => {
  const base = createCaptionProject({ id: 'rate-after-trim', name: 'Rate after trim', sources: [{ id: 'base',
    uri: 'file:///base.mp4', storageMode: 'copied', displayName: 'base.mp4',
    durationMs: 5000, width: 720, height: 1280, rotation: 0 }] });
  const owner = base.clips[0].id;
  const added = addVideoLayer(base, { id: 'pip', name: 'PiP', uri: 'file:///pip.mp4',
    currentMs: 0, durationMs: 5000, sourceStartMs: 3000, sourceDurationMs: 9000,
    playbackRate: 1, includeAudio: true });
  const trimmed = trimVideoClip(added.project, owner, 'start', 1000).project;
  const sped = setVideoLayerPlaybackRate(trimmed, 'pip', 2);
  const spedLayer = sped.layers.find((layer) => layer.id === 'pip');
  assert.deepEqual([spedLayer.startMs, spedLayer.endMs, spedLayer.sourceStartMs], [0, 1000, 4000]);
  assert.deepEqual(spedLayer.sourceAnchors.map((anchor) => [anchor.sourceStartMs, anchor.sourceEndMs]), [[1000, 3000]]);
  assert.equal(spedLayer.mediaEndMs, 6000);
  const furtherTrim = trimVideoClip(sped, owner, 'start', 1500).project;
  const plan = buildTimelineRenderPlan(furtherTrim);
  assert.deepEqual(plan.layers.filter((layer) => layer.id === 'pip').map((layer) =>
    [layer.startMs, layer.endMs, layer.sourceStartMs]), [[0, 500, 5000]]);
  assert.deepEqual(plan.audioClips.filter((clip) => clip.id === 'overlay-audio:pip').map((clip) =>
    [clip.sourceStartMs, clip.sourceEndMs]), [[5000, 6000]]);
  const restored = trimVideoClip(furtherTrim, owner, 'start', 0).project.layers.find((layer) => layer.id === 'pip');
  assert.deepEqual([restored.startMs, restored.endMs, restored.sourceStartMs], [1000, 2000, 4000]);
});


test('slowing the owner cannot make overlay picture or audio read beyond its source', () => {
  const base = createCaptionProject({ id: 'slow-owner', name: 'Slow owner', sources: [{ id: 'base',
    uri: 'file:///base.mp4', storageMode: 'copied', displayName: 'base.mp4',
    durationMs: 5000, width: 720, height: 1280, rotation: 0 }] });
  const added = addVideoLayer(base, { id: 'pip', name: 'PiP', uri: 'file:///pip.mp4',
    currentMs: 0, durationMs: 5000, sourceStartMs: 0, sourceDurationMs: 3000,
    playbackRate: 1, includeAudio: true });
  const slowed = setClipPlaybackRate(added.project, base.clips[0].id, 0.5);
  const layer = slowed.layers.find((candidate) => candidate.id === 'pip');
  const plan = buildTimelineRenderPlan(slowed);
  const picture = plan.layers.find((candidate) => candidate.id === 'pip');
  const sound = plan.audioClips.find((candidate) => candidate.id === 'overlay-audio:pip');
  assert.equal(layer.endMs, 3000);
  assert.equal(picture.endMs, 3000);
  assert.equal(sound.sourceEndMs, 3000);
  const restored = setClipPlaybackRate(slowed, base.clips[0].id, 1);
  assert.deepEqual(restored.layers.filter((candidate) => candidate.id === 'pip').map((candidate) =>
    [candidate.startMs, candidate.endMs, candidate.sourceStartMs]), [[0, 3000, 0]]);
});


test('an inserted owner-clip gap cannot make overlay audio read past its source', () => {
  const base = createCaptionProject({ id: 'gapped-owner', name: 'Gapped owner', sources: [
    { id: 'first', uri: 'file:///first.mp4', storageMode: 'copied', displayName: 'first.mp4',
      durationMs: 1000, width: 720, height: 1280, rotation: 0 },
    { id: 'second', uri: 'file:///second.mp4', storageMode: 'copied', displayName: 'second.mp4',
      durationMs: 1000, width: 720, height: 1280, rotation: 0 },
  ] });
  const added = addVideoLayer(base, { id: 'pip', name: 'PiP', uri: 'file:///pip.mp4',
    currentMs: 0, durationMs: 2000, sourceStartMs: 0, sourceDurationMs: 2000,
    playbackRate: 1, includeAudio: true });
  assert.equal(added.layer.sourceAnchors.length, 2);
  const gapped = setVideoClipGap(added.project, base.clips[1].id, 1000);
  assert.ok(gapped);
  const plan = buildTimelineRenderPlan(gapped.project);
  const picture = plan.layers.find((candidate) => candidate.id === 'pip');
  const sound = plan.audioClips.find((candidate) => candidate.id === 'overlay-audio:pip');
  assert.ok(picture.sourceStartMs + (picture.endMs - picture.startMs) * picture.playbackRate <= 2000);
  assert.ok(sound.sourceEndMs <= 2000);
  const restored = setVideoClipGap(gapped.project, base.clips[1].id, 0);
  assert.ok(restored);
  const layer = restored.project.layers.find((candidate) => candidate.id === 'pip');
  assert.deepEqual([layer.startMs, layer.endMs, layer.sourceStartMs], [0, 2000, 0]);
});

test('source-anchored PiP pauses across an owner gap and resumes picture and audio in sync', () => {
  const base = createCaptionProject({ id: 'pip-gap', name: 'PiP gap', sources: [
    { id: 'first', uri: 'file:///first.mp4', storageMode: 'copied', displayName: 'first.mp4', durationMs: 1000, width: 720, height: 1280, rotation: 0 },
    { id: 'second', uri: 'file:///second.mp4', storageMode: 'copied', displayName: 'second.mp4', durationMs: 1000, width: 720, height: 1280, rotation: 0 },
  ] });
  const added = addVideoLayer(base, { id: 'pip', name: 'PiP', uri: 'file:///pip.mp4', currentMs: 0,
    durationMs: 2000, sourceStartMs: 0, sourceDurationMs: 2000, includeAudio: true });
  const gapped = setVideoClipGap(added.project, base.clips[1].id, 1000).project;
  const saved = decodePersistedProject(JSON.stringify(gapped));
  const picture = buildTimelineRenderPlan(saved).layers.filter((layer) => layer.id === 'pip');
  const audio = buildTimelineRenderPlan(saved).audioClips.filter((clip) => clip.id.startsWith('overlay-audio:pip'));
  assert.deepEqual(picture.map((layer) => [layer.startMs, layer.endMs, layer.sourceStartMs]),
    [[0, 1000, 0], [2000, 3000, 1000]]);
  assert.deepEqual(audio.map((clip) => [clip.startMs, clip.sourceStartMs, clip.sourceEndMs]),
    [[0, 0, 1000], [2000, 1000, 2000]]);
  assert.deepEqual(buildTimelineAudioRenderPlan(saved).audioClips.filter((clip) => clip.id.startsWith('overlay-audio:pip'))
    .map((clip) => [clip.timelineStartMs, clip.timelineEndMs, clip.sourceStartMs, clip.sourceEndMs]),
    [[0, 1000, 0, 1000], [2000, 3000, 1000, 2000]]);
  assert.deepEqual([500, 1500, 2500].map((ms) => overlayPlaybackState(saved.layers.find((layer) => layer.id === 'pip'), ms, true, saved.clips)),
    [{ visible: true, seconds: 0.5, playing: true }, { visible: false, seconds: 1, playing: false },
      { visible: true, seconds: 1.5, playing: true }]);
  const independent = setVideoLayer(saved, 'pip', { timingMode: 'timeline', sourceAnchors: undefined });
  assert.deepEqual(buildTimelineRenderPlan(independent).layers.filter((layer) => layer.id === 'pip')
    .map((layer) => [layer.startMs, layer.endMs, layer.sourceStartMs]), [[0, 2000, 0]]);
  assert.deepEqual(buildTimelineRenderPlan(independent).audioClips.filter((clip) => clip.id.startsWith('overlay-audio:pip'))
    .map((clip) => [clip.startMs, clip.sourceStartMs, clip.sourceEndMs]), [[0, 0, 2000]]);
  assert.deepEqual(overlayPlaybackState(independent.layers.find((layer) => layer.id === 'pip'), 1500, true, independent.clips),
    { visible: true, seconds: 1.5, playing: true });
});

test('gapped PiP timeline block spans its last picture and survives trim and owner recovery', () => {
  const base = createCaptionProject({ id: 'pip-gap-edit', name: 'PiP gap edit', sources: [
    { id: 'first', uri: 'file:///first.mp4', storageMode: 'copied', displayName: 'first.mp4', durationMs: 1000, width: 720, height: 1280, rotation: 0 },
    { id: 'second', uri: 'file:///second.mp4', storageMode: 'copied', displayName: 'second.mp4', durationMs: 1000, width: 720, height: 1280, rotation: 0 },
  ] });
  const added = addVideoLayer(base, { id: 'pip', name: 'PiP', uri: 'file:///pip.mp4', currentMs: 0,
    durationMs: 2000, sourceStartMs: 0, sourceDurationMs: 2000, includeAudio: true });
  const gapped = setVideoClipGap(added.project, base.clips[1].id, 1000).project;
  const layer = gapped.layers.find((candidate) => candidate.id === 'pip');
  assert.deepEqual([layer.startMs, layer.endMs, layer.timingMode], [0, 3000, 'source']);
  const gapTrimmed = setLayerTiming(gapped, 'pip', 'end', 0, 1500);
  const gapLayer = gapTrimmed.layers.find((candidate) => candidate.id === 'pip');
  assert.deepEqual([gapLayer.startMs, gapLayer.endMs, gapLayer.timingMode], [0, 1000, 'source']);
  assert.equal(overlayPlaybackState(gapLayer, 1500, true, gapTrimmed.clips).visible, false);
  assert.deepEqual(buildTimelineRenderPlan(gapTrimmed).audioClips.filter((clip) => clip.id === 'overlay-audio:pip')
    .map((clip) => [clip.startMs, clip.sourceStartMs, clip.sourceEndMs]), [[0, 0, 1000]]);
  const sped = setVideoLayerPlaybackRate(gapped, 'pip', 1.5);
  const spedLayer = sped.layers.find((candidate) => candidate.id === 'pip');
  assert.deepEqual([spedLayer.startMs, Math.round(spedLayer.endMs), spedLayer.timingMode], [0, 2333, 'source']);
  assert.deepEqual(buildTimelineRenderPlan(sped).audioClips.filter((clip) => clip.id === 'overlay-audio:pip')
    .map((clip) => [clip.startMs, clip.sourceStartMs, Math.round(clip.sourceEndMs)]),
    [[0, 0, 1500], [2000, 1500, 2000]]);
  const trimmed = setLayerTiming(gapped, 'pip', 'end', 0, 2500);
  const edited = trimmed.layers.find((candidate) => candidate.id === 'pip');
  assert.deepEqual([edited.startMs, edited.endMs, edited.timingMode], [0, 2500, 'source']);
  assert.deepEqual(buildTimelineRenderPlan(trimmed).layers.filter((candidate) => candidate.id === 'pip')
    .map((candidate) => [candidate.startMs, candidate.endMs, candidate.sourceStartMs]),
    [[0, 1000, 0], [2000, 2500, 1000]]);
  assert.deepEqual(buildTimelineRenderPlan(trimmed).audioClips.filter((clip) => clip.id === 'overlay-audio:pip')
    .map((clip) => [clip.startMs, clip.sourceStartMs, clip.sourceEndMs]),
    [[0, 0, 1000], [2000, 1000, 1500]]);
  const recovered = decodePersistedProject(JSON.stringify(trimVideoClip(trimmed, base.clips[0].id, 'start', 200).project));
  assert.equal(recovered.layers.find((candidate) => candidate.id === 'pip').timingMode, 'source');
  assert.deepEqual(buildTimelineRenderPlan(recovered).layers.filter((candidate) => candidate.id === 'pip')
    .map((candidate) => [candidate.startMs, candidate.endMs, candidate.sourceStartMs]),
    [[0, 800, 200], [1800, 2300, 1000]]);
});

test('legacy persisted PiP anchors without timing mode retain source ownership', () => {
  const base = createCaptionProject({ id: 'pip-legacy-mode', name: 'PiP legacy mode', sources: [
    { id: 'first', uri: 'file:///first.mp4', storageMode: 'copied', displayName: 'first.mp4', durationMs: 1000, width: 720, height: 1280, rotation: 0 },
    { id: 'second', uri: 'file:///second.mp4', storageMode: 'copied', displayName: 'second.mp4', durationMs: 1000, width: 720, height: 1280, rotation: 0 },
  ] });
  const added = addVideoLayer(base, { id: 'pip', name: 'PiP', uri: 'file:///pip.mp4', currentMs: 0,
    durationMs: 2000, sourceStartMs: 0, sourceDurationMs: 2000, includeAudio: true });
  const legacy = structuredClone(added.project);
  delete legacy.layers.find((candidate) => candidate.id === 'pip').timingMode;
  const opened = decodePersistedProject(JSON.stringify(legacy));
  const gapped = setVideoClipGap(opened, base.clips[1].id, 1000).project;
  assert.deepEqual([gapped.layers.find((candidate) => candidate.id === 'pip').timingMode,
    gapped.layers.find((candidate) => candidate.id === 'pip').endMs], ['source', 3000]);
  assert.deepEqual(buildTimelineRenderPlan(gapped).layers.filter((candidate) => candidate.id === 'pip')
    .map((candidate) => [candidate.startMs, candidate.endMs]), [[0, 1000], [2000, 3000]]);
  assert.equal(overlayPlaybackState(gapped.layers.find((candidate) => candidate.id === 'pip'), 1500, true, gapped.clips).visible, false);
});

test('splitting a gapped source-owned PiP within footage preserves both source intervals', () => {
  const base = createCaptionProject({ id: 'split-pip', name: 'Split', sources: [
    { id: 'a', uri: 'file:///a.mp4', storageMode: 'copied', displayName: 'a', durationMs: 1000, width: 720, height: 1280, rotation: 0 },
    { id: 'b', uri: 'file:///b.mp4', storageMode: 'copied', displayName: 'b', durationMs: 1000, width: 720, height: 1280, rotation: 0 },
  ] });
  const added = addVideoLayer(base, { id: 'pip', name: 'PiP', uri: 'file:///pip.mp4', currentMs: 0,
    durationMs: 2000, sourceStartMs: 0, sourceDurationMs: 2000, includeAudio: true });
  const gapped = setVideoClipGap(added.project, base.clips[1].id, 1000).project;
  const split = splitVisualLayer(gapped, 'pip', 500, 'left', 'right');
  assert.deepEqual([split.left.timingMode, split.right.timingMode], ['source', 'source']);
  const saved = decodePersistedProject(JSON.stringify(split.project));
  assert.deepEqual(buildTimelineRenderPlan(saved).layers.filter((layer) => layer.kind === 'video')
    .map((layer) => [layer.id, layer.startMs, layer.endMs, layer.sourceStartMs]),
    [['left', 0, 500, 0], ['right', 500, 1000, 500], ['right', 2000, 3000, 1000]]);
  assert.deepEqual(buildTimelineRenderPlan(saved).audioClips.filter((clip) => clip.id.startsWith('overlay-audio:'))
    .map((clip) => [clip.startMs, clip.sourceStartMs, clip.sourceEndMs]),
    [[0, 0, 500], [500, 500, 1000], [2000, 1000, 2000]]);
  assert.equal(overlayPlaybackState(split.right, 1500, true, saved.clips).visible, false);
});

test('splitting inside an owner gap keeps each PiP half attached to its owner', () => {
  const base = createCaptionProject({ id: 'split-gap-pip', name: 'Split gap', sources: [
    { id: 'a', uri: 'file:///a.mp4', storageMode: 'copied', displayName: 'a', durationMs: 1000, width: 720, height: 1280, rotation: 0 },
    { id: 'b', uri: 'file:///b.mp4', storageMode: 'copied', displayName: 'b', durationMs: 1000, width: 720, height: 1280, rotation: 0 },
  ] });
  const added = addVideoLayer(base, { id: 'pip', name: 'PiP', uri: 'file:///pip.mp4', currentMs: 0,
    durationMs: 2000, sourceStartMs: 0, sourceDurationMs: 2000, includeAudio: true });
  const gapped = setVideoClipGap(added.project, base.clips[1].id, 1000).project;
  const split = splitVisualLayer(gapped, 'pip', 1500, 'left', 'right');
  assert.deepEqual([split.left.timingMode, split.right.timingMode], ['source', 'source']);
  assert.deepEqual(buildTimelineRenderPlan(split.project).layers.filter((layer) => layer.kind === 'video')
    .map((layer) => [layer.id, layer.startMs, layer.endMs, layer.sourceStartMs]),
    [['left', 0, 1000, 0], ['right', 2000, 3000, 1000]]);
  assert.deepEqual(buildTimelineAudioRenderPlan(split.project).audioClips.filter((clip) => clip.id.startsWith('overlay-audio:'))
    .map((clip) => [clip.timelineStartMs, clip.timelineEndMs, clip.sourceStartMs]),
    [[0, 1000, 0], [2000, 3000, 1000]]);
});

test('moving a trimmed source-owned PiP preserves source ownership and the owner gap', () => {
  const base = createCaptionProject({ id: 'move-gap-pip', name: 'Move gap', sources: [
    { id: 'a', uri: 'file:///a.mp4', storageMode: 'copied', displayName: 'a', durationMs: 1000, width: 720, height: 1280, rotation: 0 },
    { id: 'b', uri: 'file:///b.mp4', storageMode: 'copied', displayName: 'b', durationMs: 1000, width: 720, height: 1280, rotation: 0 },
  ] });
  const added = addVideoLayer(base, { id: 'pip', name: 'PiP', uri: 'file:///pip.mp4', currentMs: 0,
    durationMs: 2000, sourceStartMs: 0, sourceDurationMs: 2000, includeAudio: true });
  const gapped = setVideoClipGap(added.project, base.clips[1].id, 1000).project;
  const trimmed = setLayerTiming(gapped, 'pip', 'end', 0, 2500);
  const moved = setLayerTiming(trimmed, 'pip', 'move', 200, 2700);
  const layer = moved.layers.find((candidate) => candidate.id === 'pip');
  assert.equal(layer.timingMode, 'source');
  const saved = decodePersistedProject(JSON.stringify(moved));
  assert.deepEqual(buildTimelineRenderPlan(saved).layers.filter((candidate) => candidate.id === 'pip')
    .map((candidate) => [candidate.startMs, candidate.endMs, candidate.sourceStartMs]),
    [[200, 1000, 0], [2000, 2700, 800]]);
  assert.deepEqual(buildTimelineRenderPlan(saved).audioClips.filter((clip) => clip.id === 'overlay-audio:pip')
    .map((clip) => [clip.startMs, clip.sourceStartMs, clip.sourceEndMs]),
    [[200, 0, 800], [2000, 800, 1500]]);
  assert.deepEqual([500, 1500, 2200].map((ms) => overlayPlaybackState(layer, ms, true, saved.clips).visible),
    [true, false, true]);
});

test('source-owned PiP speed changes are reversible across owner clips and gaps', () => {
  const base = createCaptionProject({ id: 'rate-roundtrip', name: 'Rate roundtrip', sources: [
    { id: 'a', uri: 'file:///a.mp4', storageMode: 'copied', displayName: 'a', durationMs: 1000, width: 720, height: 1280, rotation: 0 },
    { id: 'b', uri: 'file:///b.mp4', storageMode: 'copied', displayName: 'b', durationMs: 1000, width: 720, height: 1280, rotation: 0 },
  ] });
  const added = addVideoLayer(base, { id: 'pip', name: 'PiP', uri: 'file:///pip.mp4', currentMs: 0,
    durationMs: 2000, sourceStartMs: 0, sourceDurationMs: 2000, includeAudio: true });
  const gapped = setVideoClipGap(added.project, base.clips[1].id, 1000).project;
  const originalAnchors = gapped.layers.find((layer) => layer.id === 'pip').sourceAnchors;
  const fast = setVideoLayerPlaybackRate(gapped, 'pip', 2);
  assert.deepEqual(buildTimelineRenderPlan(fast).layers.filter((layer) => layer.id === 'pip')
    .map((layer) => [layer.startMs, layer.endMs, layer.sourceStartMs]), [[0, 1000, 0]]);
  const restored = decodePersistedProject(JSON.stringify(setVideoLayerPlaybackRate(fast, 'pip', 1)));
  assert.deepEqual(restored.layers.find((layer) => layer.id === 'pip').sourceAnchors, originalAnchors);
  assert.deepEqual(buildTimelineRenderPlan(restored).layers.filter((layer) => layer.id === 'pip')
    .map((layer) => [layer.startMs, layer.endMs, layer.sourceStartMs]),
    [[0, 1000, 0], [2000, 3000, 1000]]);
  assert.deepEqual(buildTimelineRenderPlan(restored).audioClips.filter((clip) => clip.id === 'overlay-audio:pip')
    .map((clip) => [clip.startMs, clip.sourceStartMs, clip.sourceEndMs]),
    [[0, 0, 1000], [2000, 1000, 2000]]);
  assert.equal(overlayPlaybackState(restored.layers.find((layer) => layer.id === 'pip'), 2500, true, restored.clips).visible, true);
});

test('a speed-limited PiP remains saveable when deleting owners hides its selected media', () => {
  const base = createCaptionProject({ id: 'rate-delete', name: 'Rate delete', sources: ['a', 'b', 'c'].map((id) => ({
    id, uri: `file:///${id}.mp4`, storageMode: 'copied', displayName: id,
    durationMs: 1000, width: 720, height: 1280, rotation: 0,
  })) });
  const added = addVideoLayer(base, { id: 'pip', name: 'PiP', uri: 'file:///pip.mp4', currentMs: 0,
    durationMs: 3000, sourceStartMs: 0, sourceDurationMs: 5000, includeAudio: true });
  const sped = setVideoLayerPlaybackRate(added.project, 'pip', 2);
  const withoutA = deleteVideoClip(sped, base.clips[0].id).project;
  const withoutAB = deleteVideoClip(withoutA, base.clips[1].id).project;
  const restored = decodePersistedProject(JSON.stringify(withoutAB));
  const layer = restored.layers.find((candidate) => candidate.id === 'pip');
  assert.equal(layer.timelineVisible, false);
  assert.deepEqual(buildTimelineRenderPlan(restored).layers.filter((candidate) => candidate.id === 'pip'), []);
});


test('owner speed after head trim updates overlay seek position and remains reversible', () => {
  const base = createCaptionProject({ id: 'trim-speed-owner', name: 'Trim and speed', sources: [{ id: 'base',
    uri: 'file:///base.mp4', storageMode: 'copied', displayName: 'base.mp4',
    durationMs: 5000, width: 720, height: 1280, rotation: 0 }] });
  const owner = base.clips[0].id;
  const added = addVideoLayer(base, { id: 'pip', name: 'PiP', uri: 'file:///pip.mp4',
    currentMs: 0, durationMs: 5000, sourceStartMs: 500, sourceDurationMs: 6000,
    playbackRate: 1, includeAudio: true });
  const trimmed = trimVideoClip(added.project, owner, 'start', 1000).project;
  const sped = setClipPlaybackRate(trimmed, owner, 2);
  const plan = buildTimelineRenderPlan(sped);
  const picture = plan.layers.find((candidate) => candidate.id === 'pip');
  const sound = plan.audioClips.find((candidate) => candidate.id === 'overlay-audio:pip');
  assert.deepEqual([picture.startMs, picture.endMs, picture.sourceStartMs], [0, 1000, 1000]);
  assert.deepEqual([sound.sourceStartMs, sound.sourceEndMs], [1000, 2000]);
  const restoredRate = setClipPlaybackRate(sped, owner, 1);
  assert.deepEqual(restoredRate.layers.filter((candidate) => candidate.id === 'pip').map((candidate) =>
    [candidate.startMs, candidate.endMs, candidate.sourceStartMs]), [[0, 2000, 1500]]);
  const restoredTrim = trimVideoClip(restoredRate, owner, 'start', 0).project;
  assert.deepEqual(restoredTrim.layers.filter((candidate) => candidate.id === 'pip').map((candidate) =>
    [candidate.startMs, candidate.endMs, candidate.sourceStartMs]), [[0, 3000, 500]]);
});


test('timeline-owned video overlay stays at its independent time during owner speed edits', () => {
  const base = createCaptionProject({ id: 'independent-speed', name: 'Independent speed', sources: [{ id: 'base',
    uri: 'file:///base.mp4', storageMode: 'copied', displayName: 'base.mp4',
    durationMs: 5000, width: 720, height: 1280, rotation: 0 }] });
  const added = addVideoLayer(base, { id: 'pip', name: 'PiP', uri: 'file:///pip.mp4',
    currentMs: 0, durationMs: 5000, sourceStartMs: 0, sourceDurationMs: 3000,
    playbackRate: 1, includeAudio: true });
  const independent = setVideoLayer(added.project, 'pip', { timingMode: 'timeline', sourceAnchors: undefined });
  const sped = setClipPlaybackRate(independent, base.clips[0].id, 0.5);
  const overlay = sped.layers.find((candidate) => candidate.id === 'pip');
  assert.deepEqual([overlay.startMs, overlay.endMs, overlay.sourceStartMs], [0, 3000, 0]);
  const restored = setClipPlaybackRate(sped, base.clips[0].id, 1);
  assert.deepEqual(restored.layers.filter((candidate) => candidate.id === 'pip').map((candidate) =>
    [candidate.startMs, candidate.endMs, candidate.sourceStartMs]), [[0, 3000, 0]]);
});
