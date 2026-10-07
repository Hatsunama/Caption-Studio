import assert from 'node:assert/strict';
import test from 'node:test';

import { createEnglishChineseCaptionTrack } from '../src/lib/caption-tracks.ts';
import { exportCaptionPairs } from '../src/lib/export-caption-pairs.ts';
import { buildTimelineRenderPlan, toNativeRenderPlan } from '../src/lib/export-render-plan.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { serializeAss, serializeSrt, visibleCaptions } from '../src/lib/subtitle-export.ts';
import { setClipPlaybackRate } from '../src/lib/video-timeline.ts';

function fixture(startMs = 1000.6, endMs = 2000.4) {
  const project = createCaptionProject({
    id: 'fractional-export', name: 'Fractional export',
    sources: [{ id: 'video', uri: 'file:///video.mp4', storageMode: 'linked',
      displayName: 'video.mp4', durationMs: 4000, width: 1080, height: 1920, rotation: 0 }],
  });
  project.captions = [{ id: 'c1', text: 'Primary', startMs, endMs, wordIds: [],
    timingMode: 'timeline', textMode: 'manual', timelineVisible: true }];
  return createEnglishChineseCaptionTrack(project, { c1: 'Secondary' });
}

function cues(project) {
  return serializeSrt(project).trimEnd().split('\n\n').map((block) => {
    const [, timing, ...text] = block.split('\n');
    return { timing, text: text.join('\n') };
  });
}

function assTimes(project) {
  return serializeAss(project).split('\n').filter((line) => line.startsWith('Dialogue:'))
    .map((line) => line.split(',').slice(1, 3));
}

function planTimes(project) {
  return toNativeRenderPlan(buildTimelineRenderPlan(project)).captions
    .map(({ startMs, endMs }) => [startMs, endMs]);
}

test('identical fractional dual timing produces one SRT event without changing the project', () => {
  const project = fixture();
  const before = structuredClone(project);
  assert.deepEqual(cues(project), [
    { timing: '00:00:01,001 --> 00:00:02,000', text: 'Primary\nSecondary' },
  ]);
  assert.deepEqual(project, before);
});

test('export projections preserve fractional precision until format quantization', () => {
  const project = fixture();
  assert.deepEqual(exportCaptionPairs(project).map(({ startMs, endMs }) => [startMs, endMs]),
    [[1000.6, 2000.4]]);
  assert.deepEqual(visibleCaptions(project).map(({ startMs, endMs }) => [startMs, endMs]),
    [[1000.6, 2000.4]]);
});

test('independent fractional timing stays as two SRT events', () => {
  const project = fixture();
  Object.assign(project.captionTracks.translations[0].cues[0], { startMs: 1100.6, endMs: 1900.4 });
  assert.deepEqual(cues(project), [
    { timing: '00:00:01,001 --> 00:00:02,000', text: 'Primary' },
    { timing: '00:00:01,101 --> 00:00:01,900', text: 'Secondary' },
  ]);
  assert.deepEqual(planTimes(project), [[1001, 2000], [1101, 1900]]);
  assert.deepEqual(assTimes(project), [['0:00:01.00', '0:00:02.00'], ['0:00:01.10', '0:00:01.90']]);
});

test('independent timings in the same millisecond bin remain separate events', () => {
  const project = fixture();
  Object.assign(project.captionTracks.translations[0].cues[0], { startMs: 1000.7, endMs: 2000.3 });
  assert.deepEqual(cues(project), [
    { timing: '00:00:01,001 --> 00:00:02,000', text: 'Primary' },
    { timing: '00:00:01,001 --> 00:00:02,000', text: 'Secondary' },
  ]);
});

test('clipping retains fractions and applies identical zero and duration bounds', () => {
  for (const [startMs, endMs, clipped, srt, ass, plan] of [
    [-10.6, 2000.4, [0, 2000.4], '00:00:00,000 --> 00:00:02,000',
      ['0:00:00.00', '0:00:02.00'], [0, 2000]],
    [1000.6, 4000.4, [1000.6, 4000], '00:00:01,001 --> 00:00:04,000',
      ['0:00:01.00', '0:00:04.00'], [1001, 4000]],
  ]) {
    const project = fixture(startMs, endMs);
    const before = structuredClone(project);
    assert.deepEqual(exportCaptionPairs(project).map((pair) => [pair.startMs, pair.endMs]), [clipped]);
    assert.deepEqual(cues(project), [{ timing: srt, text: 'Primary\nSecondary' }]);
    assert.deepEqual(assTimes(project), [ass, ass]);
    assert.deepEqual(planTimes(project), [plan, plan]);
    assert.deepEqual(project, before);
  }
});

test('fully out of bounds and nonfinite secondary intervals are omitted', () => {
  for (const [startMs, endMs] of [[-10.6, -0.4], [4000.1, 4100.4], [NaN, 2000.4],
    [1000.6, Infinity], [2000.4, 1000.6]]) {
    const project = fixture();
    Object.assign(project.captionTracks.translations[0].cues[0], { startMs, endMs });
    assert.deepEqual(exportCaptionPairs(project), []);
    assert.equal(cues(project).length, 1);
    assert.equal(assTimes(project).length, 1);
    assert.equal(planTimes(project).length, 1);
  }
});

test('ASS quantizes original fractional timing directly and MP4 rounds both tracks equally', () => {
  const project = fixture(1004.6, 2004.4);
  assert.deepEqual(assTimes(project), [
    ['0:00:01.00', '0:00:02.00'], ['0:00:01.00', '0:00:02.00'],
  ]);
  assert.deepEqual(planTimes(project), [[1005, 2004], [1005, 2004]]);
  assert.deepEqual(cues(project), [
    { timing: '00:00:01,005 --> 00:00:02,004', text: 'Primary\nSecondary' },
  ]);
});

test('playback speed derived fractions remain aligned across SRT, ASS, and MP4', () => {
  const original = fixture(1001, 2002);
  const project = setClipPlaybackRate(original, original.clips[0].id, 1.5);
  const caption = project.captions[0];
  assert.ok(!Number.isInteger(caption.startMs));
  assert.deepEqual(exportCaptionPairs(project).map((pair) => [pair.startMs, pair.endMs]),
    [[caption.startMs, caption.endMs]]);
  assert.deepEqual(cues(project), [
    { timing: '00:00:00,667 --> 00:00:01,335', text: 'Primary\nSecondary' },
  ]);
  assert.deepEqual(assTimes(project), [
    ['0:00:00.67', '0:00:01.33'], ['0:00:00.67', '0:00:01.33'],
  ]);
  assert.deepEqual(planTimes(project), [[667, 1335], [667, 1335]]);
});
