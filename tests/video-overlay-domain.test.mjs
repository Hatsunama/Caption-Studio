import assert from 'node:assert/strict';
import test from 'node:test';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { addVideoLayer, duplicateVisualLayer, setLayerTiming, setVideoLayer, setVideoLayerPlaybackRate, splitVisualLayer } from '../src/lib/project-editor.ts';
import { decodePersistedProject } from '../src/lib/project-codec.ts';
import { buildTimelineRenderPlan } from '../src/lib/export-render-plan.ts';
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
