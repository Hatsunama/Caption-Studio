import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHINESE_SIMPLIFIED_TRACK_ID,
  createEnglishChineseCaptionTrack,
  setTranslationCueTiming,
} from '../src/lib/caption-tracks.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { decodeVersionTwoProject } from '../src/lib/project-schema.ts';
import { totalClipDuration } from '../src/lib/video-timeline.ts';

test('translation timing includes gaps after earlier clips and the final clip', () => {
  const project = projectFixture(6_500, 7_500);
  const clip = project.clips[0];
  project.clips = [
    { ...clip, gapBeforeMs: 500, gapAfterMs: 3_000, playbackRate: 2 },
    { ...clip, id: 'second-clip', gapBeforeMs: 250, gapAfterMs: 1_000, playbackRate: 2 },
  ];
  assert.equal(totalClipDuration(project.clips), 8_750);

  const extended = edit(project, 'end', 6_500, 8_500);
  assert.deepEqual(bounds(extended), [6_500, 8_500]);
  assert.deepEqual(bounds(edit(project, 'start', 6_000, 7_500)), [6_000, 7_500]);
  assert.deepEqual(bounds(edit(project, 'move', 8_000, 9_000)), [7_750, 8_750]);
  assert.deepEqual(bounds(edit(project, 'end', 6_500, 20_000)), [6_500, 8_750]);
  assert.deepEqual(bounds(decodeVersionTwoProject(JSON.parse(JSON.stringify(extended)))), [6_500, 8_500]);
});

test('explicit translation timing respects normalized footage and deliberate gaps', () => {
  const cases = [
    [{ gapBeforeMs: -500, gapAfterMs: 750, playbackRate: 8 }, 1_750],
    [{ gapBeforeMs: Number.NaN, gapAfterMs: Number.NaN, playbackRate: Number.NaN }, 4_000],
    [{ gapBeforeMs: 500, gapAfterMs: 750, playbackRate: 0 }, 17_250],
    [{ gapBeforeMs: 250, gapAfterMs: undefined, playbackRate: 2 }, 2_250],
  ];
  for (const [overrides, expectedEnd] of cases) {
    const project = projectFixture();
    project.clips = project.clips.map((clip) => ({ ...clip, ...overrides }));
    assert.equal(totalClipDuration(project.clips), expectedEnd);
    assert.deepEqual(bounds(edit(project, 'end', 500, 50_000)), [500, expectedEnd]);
  }
});

test('valid edge edits retain the opposite edge and moves retain duration', () => {
  const project = projectFixture();
  for (const [edge, start, end, expected] of [
    ['start', -500, 0, [0, 1_900]],
    ['start', 3_000, 0, [1_820, 1_900]],
    ['end', 0, 100, [500, 580]],
    ['end', 0, 8_000, [500, 4_000]],
    ['move', -500, 0, [0, 1_400]],
    ['move', 3_500, 0, [2_600, 4_000]],
  ]) {
    assert.deepEqual(bounds(edit(project, edge, start, end)), expected);
  }
});

test('all timing edits canonicalize stale or invalid cue bounds without inverted intervals', () => {
  const ranges = [
    [5_000, 6_000], [3_990, 4_500], [500, 100], [-500, -100],
    [0, 8_000], [500, 500], [Number.NaN, Number.NaN],
    [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
  ];
  const requestedTimes = [-10_000, 0, 2_000, 10_000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const [start, end] of ranges) {
    const project = projectFixture(start, end);
    for (const edge of ['start', 'end', 'move']) {
      for (const time of requestedTimes) {
        const [actualStart, actualEnd] = bounds(edit(project, edge, time, time));
        assert.ok(Number.isFinite(actualStart) && Number.isFinite(actualEnd));
        assert.ok(actualStart >= 0);
        assert.ok(actualEnd - actualStart >= 80, `${edge}: ${actualStart}..${actualEnd}`);
        assert.ok(actualEnd <= 4_000);
      }
    }
  }
  assert.deepEqual(bounds(edit(projectFixture(5_000, 6_000), 'end', 5_000, 6_000)), [3_920, 4_000]);
  assert.deepEqual(bounds(edit(projectFixture(3_900, 4_400), 'move', 1_000, 1_500)), [1_000, 1_100]);
  assert.deepEqual(bounds(edit(projectFixture(0, 8_000), 'move', 2_000, 10_000)), [0, 4_000]);
});

test('canvas edits can grow while short video timelines preserve their minimum', () => {
  for (const durationMs of [0, 40, 80]) {
    const project = projectFixture();
    project.clips = durationMs === 0 ? [] : project.clips.map((clip) => ({ ...clip, sourceEndMs: durationMs }));
    if (durationMs === 0) {
      assert.deepEqual(bounds(edit(project, 'end', 500, 6_000)), [500, 6_000]);
      assert.deepEqual(bounds(edit(project, 'move', 5_000, 6_000)), [5_000, 6_400]);
    } else if (durationMs < 80) {
      assert.deepEqual(bounds(edit(project, 'end', 500, 6_000)), [500, 1_900]);
    } else {
      assert.deepEqual(bounds(edit(project, 'end', 500, 6_000)), [0, 80]);
    }
  }
});

test('legacy inherited timing edits preserve cue identity, metadata and other tracks', () => {
  const project = projectFixture();
  const track = project.captionTracks.translations[0];
  delete track.cues[0].startMs;
  delete track.cues[0].endMs;
  track.cues[0].timelineVisible = false;
  project.captionTracks.translations.push({ ...track, id: 'translation-es', languageTag: 'es' });
  const before = structuredClone(project);
  const updated = edit(project, 'end', 0, 3_000);
  assert.deepEqual(bounds(updated), [500, 3_000]);
  assert.deepEqual(updated.captionTracks.translations[0].cues[0], {
    ...before.captionTracks.translations[0].cues[0],
    startMs: 500,
    endMs: 3_000,
    timelineVisible: true,
  });
  assert.deepEqual(updated.captionTracks.translations[0].cues[1], before.captionTracks.translations[0].cues[1]);
  assert.deepEqual(updated.captionTracks.translations[1], before.captionTracks.translations[1]);
  assert.deepEqual(updated.captions, before.captions);
  assert.equal(updated.updatedAt, '2026-09-13T12:00:00.000Z');
  assert.deepEqual(project, before);
});

function edit(project, edge, startMs, endMs) {
  return setTranslationCueTiming(project, CHINESE_SIMPLIFIED_TRACK_ID, 'c1', edge, startMs, endMs, '2026-09-13T12:00:00.000Z');
}

function bounds(project) {
  const cue = project.captionTracks.translations[0].cues[0];
  return [cue.startMs, cue.endMs];
}

function projectFixture(startMs = 500, endMs = 1_900) {
  const project = createCaptionProject({
    id: 'project-cue-timing',
    name: 'Translation timing',
    sources: [{
      id: 'source-1',
      uri: 'content://media/video/1',
      storageMode: 'linked',
      displayName: 'speaker.mp4',
      durationMs: 4_000,
      width: 1080,
      height: 1920,
      rotation: 0,
    }],
  });
  return createEnglishChineseCaptionTrack({
    ...project,
    transcription: { ...project.transcription, language: 'en' },
    captions: [
      { id: 'c1', text: 'First caption', startMs, endMs, wordIds: [], textMode: 'manual', timingMode: 'timeline', timelineVisible: true },
      { id: 'c2', text: 'Second caption', startMs: 2_000, endMs: 3_000, wordIds: [], textMode: 'manual', timingMode: 'timeline', timelineVisible: true },
    ],
  });
}
