import assert from 'node:assert/strict';
import test from 'node:test';

import { addAudioSourceToProject, moveAudioClip, trimAudioClip } from '../src/lib/audio-timeline.ts';
import { reorderVideoClip, setVideoClipLeadingGap, splitVideoClip, trimVideoClip } from '../src/lib/project-editor.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { buildTimelineRenderPlan } from '../src/lib/export-render-plan.ts';
import { buildTimelineAudioRenderPlan } from '../src/lib/timeline-audio-render-plan.ts';
import { setClipPlaybackRate } from '../src/lib/video-timeline.ts';
import { decodeVersionTwoProject, serializeProjectSnapshot } from '../src/lib/project-schema.ts';

function projectWithTwoClips() {
  const project = createCaptionProject({
    id: 'attached-audio-test',
    name: 'Attached audio',
    sources: ['first', 'second'].map((id) => ({
      id,
      uri: `file:///${id}.mp4`,
      storageMode: 'copied',
      displayName: id,
      durationMs: 10_000,
      width: 1920,
      height: 1080,
      rotation: 0,
      frameRate: 30,
    })),
  });
  project.clips = project.clips.map((clip) => ({
    ...clip,
    sourceEndMs: 4_000,
    availableSourceEndMs: 10_000,
  }));
  return project;
}

function extractedSource() {
  return {
    id: 'extracted',
    uri: 'file:///extracted.m4a',
    storageMode: 'copied',
    displayName: 'Extracted audio',
    durationMs: 10_000,
    origin: 'video-audio',
  };
}

test('extracted audio is explicitly attached at matching video source time and survives reorder and reopen', () => {
  const project = projectWithTwoClips();
  const ownerId = project.clips[1].id;
  const added = addAudioSourceToProject(project, extractedSource(), 'audio', 5_000, 8_000, { videoClipId: ownerId });
  assert.ok(added);
  assert.equal(added.clip.anchor, 'video');
  assert.equal(added.clip.videoClipId, ownerId);
  assert.equal(added.clip.sourceStartMs, 1_000);
  assert.equal(added.clip.startMs, 5_000);

  const reordered = reorderVideoClip(added.project, ownerId, 0);
  assert.ok(reordered);
  assert.equal(reordered.project.audioClips[0].startMs, 1_000);
  const reopened = decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(reordered.project)));
  assert.equal(reopened.audioClips[0].anchor, 'video');
  assert.equal(reopened.audioClips[0].videoClipId, ownerId);
  assert.equal(reopened.audioClips[0].startMs, 1_000);
});

test('an attached audio clip follows the surviving video range without changing independent music', () => {
  const project = projectWithTwoClips();
  const ownerId = project.clips[1].id;
  const added = addAudioSourceToProject(project, extractedSource(), 'audio', 5_000, 8_000, { videoClipId: ownerId });
  assert.ok(added);
  const music = { ...added.clip, id: 'music', anchor: 'timeline', videoClipId: undefined, sourceId: 'music' };
  const withMusic = {
    ...added.project,
    audioSources: [...added.project.audioSources, { ...extractedSource(), id: 'music', origin: 'audio-file' }],
    audioClips: [...added.project.audioClips, music],
  };
  const trimmed = trimVideoClip(withMusic, ownerId, 'end', 2_000);
  assert.ok(trimmed);
  assert.equal(trimmed.project.audioClips[0].sourceEndMs, 2_000);
  assert.deepEqual(trimmed.project.audioClips[1], music);
  const moved = moveAudioClip(trimmed.project, 'audio', 500, 8_000);
  assert.deepEqual(moved.clips, trimmed.project.clips);
  assert.equal(moved.audioClips[0].startMs, 500);
});

test('long music and voice-over remain timeline-owned while a video clip slides', () => {
  const project = projectWithTwoClips();
  project.audioSources = ['music', 'voiceover'].map((id) => ({
    id, uri: `file:///${id}.m4a`, storageMode: 'copied', displayName: id,
    durationMs: 10_000, origin: id === 'music' ? 'audio-file' : 'voiceover',
  }));
  project.audioClips = project.audioSources.map((source, index) => ({
    id: source.id,
    sourceId: source.id,
    anchor: 'timeline',
    startMs: 4_500 + index * 500,
    sourceStartMs: 0,
    sourceEndMs: 5_000,
    volume: 1,
    muted: false,
    fadeInMs: 0,
    fadeOutMs: 0,
  }));
  const slid = setVideoClipLeadingGap(project, project.clips[1].id, 1_000);
  assert.ok(slid);
  assert.deepEqual(slid.project.audioClips, project.audioClips);
});

test('splitting a video assigns each surviving audio section to its new clip', () => {
  const project = projectWithTwoClips();
  const ownerId = project.clips[1].id;
  const added = addAudioSourceToProject(project, extractedSource(), 'audio', 4_000, 8_000, { videoClipId: ownerId });
  assert.ok(added);
  const split = splitVideoClip(added.project, ownerId, 6_000, 'left', 'right');
  assert.ok(split);
  assert.deepEqual(split.project.audioClips.map((clip) => [
    clip.videoClipId, clip.startMs, clip.sourceStartMs, clip.sourceEndMs,
  ]), [['left', 4_000, 0, 2_000], ['right', 6_000, 2_000, 4_000]]);
});

test('splitting attached audio does not invent fades at the video cut', () => {
  const project = projectWithTwoClips();
  const ownerId = project.clips[1].id;
  const added = addAudioSourceToProject(project, extractedSource(), 'audio', 4_000, 8_000, { videoClipId: ownerId });
  assert.ok(added);
  added.project.audioClips[0].fadeInMs = 500;
  added.project.audioClips[0].fadeOutMs = 700;
  const split = splitVideoClip(added.project, ownerId, 6_000, 'left', 'right');
  assert.ok(split);
  assert.deepEqual(split.project.audioClips.map(({ fadeInMs, fadeOutMs }) => [fadeInMs, fadeOutMs]),
    [[500, 0], [0, 700]]);
});

test('video trim restoration restores attached audio without changing its source intent', () => {
  const project = projectWithTwoClips();
  const ownerId = project.clips[1].id;
  const added = addAudioSourceToProject(project, extractedSource(), 'audio', 5_000, 8_000, { videoClipId: ownerId });
  assert.ok(added);
  const shortened = trimVideoClip(added.project, ownerId, 'end', 2_000);
  assert.ok(shortened);
  assert.equal(shortened.project.audioClips[0].sourceEndMs, 2_000);
  const restored = trimVideoClip(shortened.project, ownerId, 'end', 4_000);
  assert.ok(restored);
  assert.equal(restored.project.audioClips[0].sourceEndMs, 4_000);
});

test('video speed changes keep attached audio duration and both render plans synchronized', () => {
  const project = projectWithTwoClips();
  const ownerId = project.clips[1].id;
  const added = addAudioSourceToProject(project, extractedSource(), 'audio', 4_000, 8_000, { videoClipId: ownerId });
  assert.ok(added);
  const sped = setClipPlaybackRate(added.project, ownerId, 2);
  assert.equal(sped.audioClips[0].playbackRate, 2);
  assert.equal(sped.audioClips[0].startMs, 4_000);
  const exportAudio = buildTimelineRenderPlan(sped).audioClips[0];
  const previewAudio = buildTimelineAudioRenderPlan(sped).audioClips[0];
  assert.deepEqual([exportAudio.sourceStartMs, exportAudio.sourceEndMs, exportAudio.playbackRate], [0, 4_000, 2]);
  assert.deepEqual([previewAudio.timelineStartMs, previewAudio.timelineEndMs, previewAudio.playbackRate], [4_000, 6_000, 2]);
});

test('moving audio outside its video makes it independent without moving the video', () => {
  const project = projectWithTwoClips();
  const ownerId = project.clips[1].id;
  const added = addAudioSourceToProject(project, extractedSource(), 'audio', 5_000, 8_000, { videoClipId: ownerId });
  assert.ok(added);
  const moved = moveAudioClip(added.project, 'audio', 500, 8_000);
  assert.equal(moved.audioClips[0].anchor, 'timeline');
  assert.deepEqual(moved.clips, added.project.clips);
  const reordered = reorderVideoClip(moved, ownerId, 0);
  assert.ok(reordered);
  assert.equal(reordered.project.audioClips[0].startMs, 500);
});

test('start trimming speed-adjusted audio never seeks before the source begins', () => {
  const project = projectWithTwoClips();
  const ownerId = project.clips[1].id;
  const added = addAudioSourceToProject(project, extractedSource(), 'audio', 5_000, 8_000, { videoClipId: ownerId });
  assert.ok(added);
  const sped = setClipPlaybackRate(added.project, ownerId, 2);
  const trimmed = trimAudioClip(sped, 'audio', 'start', 3_500, 8_000);
  assert.ok(trimmed);
  assert.equal(trimmed.audioClips[0].startMs, 4_000);
  assert.equal(trimmed.audioClips[0].sourceStartMs, 0);
});

test('video split retains an attached audio section whose timeline duration meets the minimum', () => {
  const project = projectWithTwoClips();
  const ownerId = project.clips[1].id;
  const slowed = setClipPlaybackRate(project, ownerId, 0.25);
  const added = addAudioSourceToProject(slowed, extractedSource(), 'audio', 4_000, 20_000, { videoClipId: ownerId });
  assert.ok(added);
  const split = splitVideoClip(added.project, ownerId, 4_200, 'left', 'right');
  assert.ok(split);
  assert.equal(split.project.audioClips.length, 2);
  assert.equal(split.project.audioClips[0].videoClipId, 'left');
  assert.equal(split.project.audioClips[0].sourceEndMs, 50);
  assert.equal(split.project.audioClips[1].videoClipId, 'right');
  const reopened = decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(split.project)));
  assert.equal(reopened.audioClips.length, 2);
});

test('extending extracted audio beyond its video makes the full audio clip independent', () => {
  const project = projectWithTwoClips();
  const ownerId = project.clips[0].id;
  const added = addAudioSourceToProject(project, extractedSource(), 'audio', 0, 8_000, { videoClipId: ownerId });
  assert.ok(added);
  const extended = trimAudioClip(added.project, 'audio', 'end', 5_000, 8_000);
  assert.ok(extended);
  assert.equal(extended.audioClips[0].anchor, 'timeline');
  const reordered = reorderVideoClip(extended, ownerId, 1);
  assert.ok(reordered);
  assert.equal(reordered.project.audioClips[0].startMs, 0);
  assert.equal(reordered.project.audioClips[0].sourceEndMs, 5_000);
});
