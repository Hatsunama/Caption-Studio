import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldTranscribeAudibleTimeline } from '../src/lib/caption-audio-route.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { addVideoLayer, setVideoLayer } from '../src/lib/project-editor.ts';
import { buildTimelineAudioRenderPlan } from '../src/lib/timeline-audio-render-plan.ts';
import { buildTimelineRenderPlan } from '../src/lib/export-render-plan.ts';

test('one unchanged clip reuses source transcription', () => {
  assert.equal(shouldTranscribeAudibleTimeline({ clips: [{ muted: false, volume: 1 }], audioClips: [] }), false);
});

test('muted or volume-adjusted video transcribes the audible timeline', () => {
  assert.equal(shouldTranscribeAudibleTimeline({ clips: [{ muted: true, volume: 1 }], audioClips: [] }), true);
  assert.equal(shouldTranscribeAudibleTimeline({ clips: [{ muted: false, volume: 0 }], audioClips: [] }), true);
  assert.equal(shouldTranscribeAudibleTimeline({ clips: [{ muted: false, volume: 0.5 }], audioClips: [] }), true);
});

test('multiple clips and audible added audio use the timeline render', () => {
  assert.equal(shouldTranscribeAudibleTimeline({ clips: [{ muted: false, volume: 1 }, { muted: false, volume: 1 }], audioClips: [] }), true);
  assert.equal(shouldTranscribeAudibleTimeline({ clips: [{ muted: false, volume: 1 }], audioClips: [{ muted: false, volume: 1 }] }), true);
});


test('consented overlay audio joins caption composition and matches export source timing', () => {
  const base = createCaptionProject({ id: 'overlay-transcription', name: 'Overlay transcription', sources: [{
    id: 'base', uri: 'file:///base.mp4', storageMode: 'copied', displayName: 'base.mp4',
    durationMs: 5000, width: 720, height: 1280, rotation: 0,
  }] });
  const added = addVideoLayer(base, { id: 'pip', name: 'PiP', uri: 'file:///pip.mp4',
    currentMs: 1000, durationMs: 5000, sourceStartMs: 500, sourceDurationMs: 6500,
    playbackRate: 2, includeAudio: true });
  assert.equal(shouldTranscribeAudibleTimeline(base), false);
  assert.equal(shouldTranscribeAudibleTimeline(added.project), true);
  const captionAudio = buildTimelineAudioRenderPlan(added.project).audioClips.find((clip) => clip.id === 'overlay-audio:pip');
  const exportAudio = buildTimelineRenderPlan(added.project).audioClips.find((clip) => clip.id === 'overlay-audio:pip');
  assert.ok(captionAudio);
  assert.deepEqual([captionAudio.timelineStartMs, captionAudio.timelineEndMs, captionAudio.sourceStartMs,
    captionAudio.sourceEndMs, captionAudio.playbackRate], [exportAudio.startMs, exportAudio.startMs
    + (exportAudio.sourceEndMs - exportAudio.sourceStartMs) / exportAudio.playbackRate,
    exportAudio.sourceStartMs, exportAudio.sourceEndMs, exportAudio.playbackRate]);
  const videoOnly = setVideoLayer(added.project, 'pip', { includeAudio: false });
  assert.equal(shouldTranscribeAudibleTimeline(videoOnly), false);
  assert.equal(buildTimelineAudioRenderPlan(videoOnly).audioClips.length, 0);
});

test('transparent overlay retains consented audio; hidden overlay is silent in caption and export', () => {
  const base = createCaptionProject({ id: 'transparent-overlay', name: 'Transparent overlay', sources: [{
    id: 'base', uri: 'file:///base.mp4', storageMode: 'copied', displayName: 'base.mp4',
    durationMs: 5000, width: 720, height: 1280, rotation: 0,
  }] });
  const added = addVideoLayer(base, { id: 'pip', name: 'PiP', uri: 'file:///pip.mp4',
    currentMs: 0, durationMs: 5000, sourceDurationMs: 5000, includeAudio: true });
  const transparent = setVideoLayer(added.project, 'pip', { opacity: 0 });
  assert.equal(buildTimelineRenderPlan(transparent).audioClips.some((clip) => clip.id === 'overlay-audio:pip'), true);
  assert.equal(buildTimelineAudioRenderPlan(transparent).audioClips.some((clip) => clip.id === 'overlay-audio:pip'), true);
  const hidden = setVideoLayer(transparent, 'pip', { visible: false });
  assert.equal(shouldTranscribeAudibleTimeline(hidden), false);
  assert.equal(buildTimelineRenderPlan(hidden).audioClips.some((clip) => clip.id === 'overlay-audio:pip'), false);
  assert.equal(buildTimelineAudioRenderPlan(hidden).audioClips.some((clip) => clip.id === 'overlay-audio:pip'), false);
});
