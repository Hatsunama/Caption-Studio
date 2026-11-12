import assert from 'node:assert/strict';
import test from 'node:test';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { addImageLayer, addVideoLayer, createTextLayer, createWatermarkLayer, setLayerTiming, setVideoClipGap, trimVideoClip } from '../src/lib/project-editor.ts';
import { setClipPlaybackRate } from '../src/lib/video-timeline.ts';
import { buildTimelineAudioRenderPlan } from '../src/lib/timeline-audio-render-plan.ts';
import { addAudioSourceToProject, audioClipEnd } from '../src/lib/audio-timeline.ts';
import { createEnglishChineseCaptionTrack, resolveCaptionPairs } from '../src/lib/caption-tracks.ts';
import { applyTimelineItemTiming } from '../src/lib/timeline-item-editor.ts';
import { decodePersistedProject } from '../src/lib/project-codec.ts';
import { serializeProjectSnapshot } from '../src/lib/project-schema.ts';
import { buildTimelineRenderPlan } from '../src/lib/export-render-plan.ts';
import { overlayPlaybackState } from '../src/lib/video-overlay-playback.ts';

// Footage 0..3000, deliberate canvas gap 3000..5000, footage 5000..8000.
function fixture() {
  const project = createCaptionProject({ id: 'movement-cascade', name: 'Movement', sources: ['a', 'b'].map(id => ({
    id, uri: `file:///${id}.mp4`, storageMode: 'copied', displayName: `${id}.mp4`,
    durationMs: 3000, width: 720, height: 1280, rotation: 0,
  })) });
  project.clips[1].gapBeforeMs = 2000;
  project.transcription.language = 'en';
  project.captions = [{ id: 'c1', text: 'Hello', startMs: 500, endMs: 1500, wordIds: [], timingMode: 'timeline' }];
  return project;
}

function pipFixture() {
  let project = fixture();
  for (const id of ['pip-a', 'pip-b', 'pip-c']) {
    project = addVideoLayer(project, { id, name: id, uri: `file:///${id}.mp4`, currentMs: 500,
      durationMs: 1500, sourceStartMs: 500, sourceDurationMs: 6000, playbackRate: 2, includeAudio: true }).project;
  }
  return project;
}

function move(project, item, startMs) {
  return applyTimelineItemTiming(project, item, 'move', startMs, startMs + 1000, 8000);
}

function pipEvidence(project, previewMs) {
  const restored = decodePersistedProject(serializeProjectSnapshot(project));
  const layer = restored.layers.find(layer => layer.id === 'pip-b');
  const plan = buildTimelineRenderPlan(restored);
  return {
    stored: [layer.startMs, layer.endMs, layer.sourceStartMs],
    picture: plan.layers.filter(layer => layer.id === 'pip-b')
      .map(layer => [layer.startMs, layer.endMs, layer.sourceStartMs, layer.playbackRate]),
    audio: plan.audioClips.filter(clip => clip.id === 'overlay-audio:pip-b')
      .map(clip => [clip.startMs, clip.sourceStartMs, clip.sourceEndMs, clip.playbackRate]),
    visible: overlayPlaybackState(layer, previewMs, true, restored.clips).visible,
  };
}

function expectedPip(startMs) {
  return { stored: [startMs, startMs + 1000, 500],
    picture: [[startMs, startMs + 1000, 500, 2]], audio: [[startMs, 500, 2500, 2]], visible: true };
}

for (const kind of ['image', 'text', 'watermark', 'caption', 'translation', 'audio']) {
  test(`${kind} MOVE into a canvas gap preserves duration through persistence and export`, () => {
    let project = fixture();
    let item;
    if (kind === 'caption') item = { kind, captionId: 'c1' };
    else if (kind === 'translation') {
      project = createEnglishChineseCaptionTrack(project, { c1: '\u4f60\u597d' });
      item = { kind, trackId: project.captionTracks.translations[0].id, sourceCaptionId: 'c1' };
    } else if (kind === 'audio') {
      project = addAudioSourceToProject(project, { id: 'sound', uri: 'file:///sound.wav', displayName: 'sound.wav',
        durationMs: 1000, origin: 'audio-file' }, 'audio', 500, 8000).project;
      item = { kind, clipId: 'audio' };
    } else {
      project = kind === 'image' ? addImageLayer(project, { id: kind, name: kind, uri: 'file:///image.png',
        currentMs: 500, durationMs: 1500 }).project
        : kind === 'text' ? createTextLayer(project, kind, 500, 1500).project
          : setLayerTiming(createWatermarkLayer(project, kind, 1500, 'Watermark').project, kind, 'start', 500, 1500);
      item = { kind: 'visual', layerId: kind };
    }
    const before = structuredClone(project);
    const restored = decodePersistedProject(serializeProjectSnapshot(move(project, item, 3500)));
    assert.deepEqual(project, before, 'MOVE must not mutate the input snapshot');
    const plan = buildTimelineRenderPlan(restored);
    const range = kind === 'caption' ? restored.captions[0]
      : kind === 'translation' ? resolveCaptionPairs(restored, item.trackId)[0]
        : kind === 'audio' ? { startMs: restored.audioClips[0].startMs, endMs: audioClipEnd(restored.audioClips[0]) }
          : restored.layers.find(layer => layer.id === kind);
    assert.deepEqual([range.startMs, range.endMs], [3500, 4500]);
    const output = kind === 'caption' ? plan.captions.find(caption => caption.id === 'c1')
      : kind === 'translation' ? plan.captions.find(caption => caption.id === range.translation.id)
        : kind === 'audio' ? plan.audioClips.find(clip => clip.id === 'audio')
          : plan.layers.find(layer => layer.id === kind);
    assert.equal(output.startMs, 3500);
    assert.equal(kind === 'audio' ? output.startMs + (output.sourceEndMs - output.sourceStartMs) / output.playbackRate : output.endMs, 4500);
  });
}

test('three overlapping PiPs: MOVE within footage preserves media, siblings and array order', () => {
  const project = pipFixture();
  const before = structuredClone(project);
  const moved = move(project, { kind: 'visual', layerId: 'pip-b' }, 5500);
  assert.deepEqual(project, before);
  assert.deepEqual(moved.layers.map(layer => layer.id), project.layers.map(layer => layer.id));
  for (const id of ['pip-a', 'pip-c']) {
    assert.deepEqual(moved.layers.find(layer => layer.id === id), project.layers.find(layer => layer.id === id));
  }
  assert.deepEqual(pipEvidence(moved, 6000), expectedPip(5500));
});

test('source-owned PiP MOVE wholly into a canvas gap must reach preview and export', () => {
  const project = pipFixture();
  assert.equal(project.layers.find(layer => layer.id === 'pip-b').timingMode, 'source');
  const moved = move(project, { kind: 'visual', layerId: 'pip-b' }, 3500);
  assert.deepEqual(pipEvidence(moved, 4000), expectedPip(3500));
});

test('source-owned PiP MOVE across a gap boundary must not shorten the next MOVE', () => {
  const project = pipFixture();
  const partial = move(project, { kind: 'visual', layerId: 'pip-b' }, 2500);
  const onward = move(partial, { kind: 'visual', layerId: 'pip-b' }, 5500);
  // The second destination is fully covered by footage: a MOVE must still carry
  // the original 1000 ms / 2000 source-ms selection after crossing the gap edge.
  assert.deepEqual(pipEvidence(onward, 6250), expectedPip(5500));
});

for (const playbackRate of [0.5, 1, 2, 4]) {
  test(`PiP at rate ${playbackRate}: repeated gap/footage moves survive reopen with media and siblings intact`, () => {
    let project = decodePersistedProject(serializeProjectSnapshot(pipFixture()));
    const selected = project.layers.find(layer => layer.id === 'pip-b');
    selected.playbackRate = playbackRate;
    const siblings = project.layers.filter(layer => layer.id !== 'pip-b');
    // Hidden siblings must remain hidden and retain their timing/anchors too.
    siblings.find(layer => layer.id === 'pip-c').timelineVisible = false;
    const originalSiblings = structuredClone(siblings);
    for (const startMs of [2500, 5500, 3500, 500, 4500, 5500, 3500]) {
      const before = serializeProjectSnapshot(project);
      const moved = move(project, { kind: 'visual', layerId: 'pip-b' }, startMs);
      assert.equal(serializeProjectSnapshot(project), before);
      assert.deepEqual(moved.layers.filter(layer => layer.id !== 'pip-b'), originalSiblings);
      project = decodePersistedProject(serializeProjectSnapshot(moved));
      const layer = project.layers.find(layer => layer.id === 'pip-b');
      assert.deepEqual([layer.startMs, layer.endMs, layer.sourceStartMs, layer.sourceDurationMs,
        layer.playbackRate, layer.includeAudio], [startMs, startMs + 1000, 500, 6000, playbackRate, true]);
      assert.equal(layer.timingMode, 'timeline', 'gap fallback ownership remains sticky over footage');
      assert.equal(layer.sourceAnchors, undefined);
      assert.deepEqual(project.layers.filter(layer => layer.id !== 'pip-b'), originalSiblings);
      const evidence = pipEvidence(project, startMs + 750);
      assert.deepEqual(evidence.picture, [[startMs, startMs + 1000, 500, playbackRate]]);
      assert.deepEqual(evidence.audio, [[startMs, 500, 500 + 1000 * playbackRate, playbackRate]]);
      assert.equal(evidence.visible, true);
      assert.deepEqual(buildTimelineAudioRenderPlan(project).audioClips
        .filter(clip => clip.id === 'overlay-audio:pip-b')
        .map(clip => [clip.timelineStartMs, clip.timelineEndMs, clip.sourceStartMs, clip.sourceEndMs]),
      [[startMs, startMs + 1000, 500, 500 + 1000 * playbackRate]]);
      assert.deepEqual(overlayPlaybackState(layer, startMs + 750, true, project.clips),
        { visible: true, seconds: (500 + 750 * playbackRate) / 1000, playing: true });
      assert.equal(overlayPlaybackState(layer, startMs + 1000, true, project.clips).visible, false);
    }
  });
}

test('fully covered PiP MOVE retains source ownership across owner trims and restoration', () => {
  const moved = move(pipFixture(), { kind: 'visual', layerId: 'pip-b' }, 5500);
  const layer = moved.layers.find(layer => layer.id === 'pip-b');
  assert.equal(layer.timingMode, 'source');
  assert.deepEqual(layer.sourceAnchors, [{ clipId: moved.clips[1].id, sourceStartMs: 500, sourceEndMs: 1500 }]);
  const trimmed = trimVideoClip(moved, moved.clips[1].id, 'start', 1000).project;
  const picture = buildTimelineRenderPlan(trimmed).layers.find(layer => layer.id === 'pip-b');
  assert.deepEqual([picture.startMs, picture.endMs, picture.sourceStartMs], [6000, 6500, 1500]);
  const restored = trimVideoClip(decodePersistedProject(serializeProjectSnapshot(trimmed)), moved.clips[1].id, 'start', 0).project;
  assert.deepEqual(pipEvidence(restored, 6250), expectedPip(5500));
});

test('fully covered PiP MOVE across adjacent owners respects owner rates and later gaps', () => {
  let project = fixture();
  project = setVideoClipGap(project, project.clips[1].id, 0).project;
  project = setClipPlaybackRate(project, project.clips[0].id, 2);
  project = addVideoLayer(project, { id: 'pip-b', name: 'PiP', uri: 'file:///pip-b.mp4', currentMs: 500,
    durationMs: 1500, sourceStartMs: 500, sourceDurationMs: 6000, playbackRate: 2, includeAudio: true }).project;
  const moved = move(project, { kind: 'visual', layerId: 'pip-b' }, 1000);
  const layer = moved.layers.find(layer => layer.id === 'pip-b');
  assert.equal(layer.timingMode, 'source');
  assert.deepEqual(layer.sourceAnchors, [
    { clipId: project.clips[0].id, sourceStartMs: 2000, sourceEndMs: 3000 },
    { clipId: project.clips[1].id, sourceStartMs: 0, sourceEndMs: 500 },
  ]);
  const gapped = decodePersistedProject(serializeProjectSnapshot(setVideoClipGap(moved, project.clips[1].id, 1000).project));
  assert.deepEqual(buildTimelineRenderPlan(gapped).layers.filter(layer => layer.id === 'pip-b')
    .map(layer => [layer.startMs, layer.endMs, layer.sourceStartMs]), [[1000, 1500, 500], [2500, 3000, 1500]]);
  assert.deepEqual(buildTimelineRenderPlan(gapped).audioClips.filter(clip => clip.id === 'overlay-audio:pip-b')
    .map(clip => [clip.startMs, clip.sourceStartMs, clip.sourceEndMs]), [[1000, 500, 1500], [2500, 1500, 2500]]);
});

test('PiP MOVE rejects hidden/missing selections and leaves unchanged timing alone', () => {
  const project = pipFixture();
  assert.equal(move(project, { kind: 'visual', layerId: 'missing' }, 3500), project);
  assert.equal(move(project, { kind: 'visual', layerId: 'pip-b' }, 500), project);
  project.layers.find(layer => layer.id === 'pip-b').timelineVisible = false;
  const before = structuredClone(project);
  assert.equal(move(project, { kind: 'visual', layerId: 'pip-b' }, 3500), project);
  assert.deepEqual(project, before);
});
