import assert from 'node:assert/strict';
import test from 'node:test';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { createEnglishChineseCaptionTrack, remapTranslationTrackTimings, resolveCaptionPairs } from '../src/lib/caption-tracks.ts';
import { deleteVideoClip, reorderVideoClip, setVideoClipGap, splitVideoClip, trimVideoClip } from '../src/lib/project-editor.ts';
import { rippleTimedContent, setClipPlaybackRate, translationSpliceMapping } from '../src/lib/video-timeline.ts';
import { decodeVersionTwoProject } from '../src/lib/project-schema.ts';
import { exportCaptionPairs } from '../src/lib/export-caption-pairs.ts';
import { serializeSrt } from '../src/lib/subtitle-export.ts';

function fixture(startMs = 3_300, endMs = 3_700) {
  let project = createCaptionProject({ id: 'operation-remap', name: 'Operation remap', sources: [{
    id: 'source', uri: 'content://media/video/1', storageMode: 'linked', displayName: 'video.mp4',
    durationMs: 4_000, width: 1080, height: 1920, rotation: 0,
  }] });
  project.clips = [{ ...project.clips[0], id: 'a' }, { ...project.clips[0], id: 'b' }];
  project.transcription.language = 'en';
  project.captions = [
    { id: 'c1', text: 'First', startMs: 3_200, endMs: 3_800, wordIds: [], textMode: 'manual',
      timingMode: 'source', timelineVisible: true,
      sourceAnchor: { clipId: 'a', sourceStartMs: 3_200, sourceEndMs: 3_800, wordIds: [] } },
    { id: 'c2', text: 'Second', startMs: 4_500, endMs: 5_500, wordIds: [], textMode: 'manual',
      timingMode: 'source', timelineVisible: true,
      sourceAnchor: { clipId: 'b', sourceStartMs: 500, sourceEndMs: 1_500, wordIds: [] } },
  ];
  project = createEnglishChineseCaptionTrack(project, { c1: 'Independent first', c2: 'Independent second' });
  Object.assign(cue(project), { startMs, endMs, status: 'reviewed', reviewed: true });
  return project;
}

function cue(project, id = 'c1') {
  return project.captionTracks.translations[0].cues.find((item) => item.sourceCaptionId === id);
}
function bounds(project, id = 'c1') {
  const item = cue(project, id);
  return [item.startMs, item.endMs];
}
function reload(project) {
  return decodeVersionTwoProject(JSON.parse(JSON.stringify(project)));
}
function metadata(item) {
  const { startMs, endMs, timelineVisible, ...rest } = item;
  return JSON.parse(JSON.stringify(rest));
}

test('head and tail trims preserve independent intervals, including fully hidden primary captions', () => {
  for (const [edge, target] of [['start', 3_500], ['end', 3_500], ['end', 2_000]]) {
    const original = fixture();
    const next = trimVideoClip(original, 'a', edge, target).project;
    assert.deepEqual(bounds(next), bounds(original));
    assert.deepEqual(metadata(cue(next)), metadata(cue(original)));
    assert.equal(cue(next).timelineVisible, true);
    assert.deepEqual(bounds(reload(next)), bounds(original));
    const restored = trimVideoClip(reload(next), 'a', edge, edge === 'start' ? 0 : 4_000).project;
    assert.deepEqual(bounds(restored), bounds(original));
  }
});

test('identical primary endpoint changes have different trim and speed semantics', () => {
  const project = fixture(1_000, 3_000);
  Object.assign(project.captions[0], { startMs: 0, endMs: 4_000,
    sourceAnchor: { clipId: 'a', sourceStartMs: 0, sourceEndMs: 4_000, wordIds: [] } });
  const trimmed = trimVideoClip(project, 'a', 'end', 2_000).project;
  const sped = setClipPlaybackRate(project, 'a', 2);
  assert.deepEqual(trimmed.captions[0], sped.captions[0]);
  assert.deepEqual(bounds(trimmed), [1_000, 3_000]);
  assert.deepEqual(bounds(sped), [500, 1_500]);
});

test('speed maps each independent endpoint inside, outside and across the edited clip', () => {
  for (const [start, end, expected] of [
    [500, 1_500, [250, 750]], [3_000, 5_000, [1_500, 3_000]],
    [4_500, 5_500, [2_500, 3_500]], [0, 4_000, [0, 2_000]],
    [0, 0, [0, 0]],
  ]) {
    const original = fixture(start, end);
    const next = setClipPlaybackRate(original, 'a', 2);
    assert.deepEqual(bounds(next), expected);
    assert.deepEqual(metadata(cue(next)), metadata(cue(original)));
    assert.deepEqual(bounds(reload(next)), expected);
    assert.deepEqual(bounds(setClipPlaybackRate(next, 'a', 1)), [start, end]);
  }
  assert.deepEqual(bounds(setClipPlaybackRate(fixture(3_000, 5_000), 'b', 2)), [3_000, 4_500]);
});

test('speed maps the retained interval after trimming and reloading, including gap portions', () => {
  const trimmed = reload(trimVideoClip(fixture(3_000, 5_000), 'a', 'end', 3_500).project);
  assert.deepEqual(bounds(setClipPlaybackRate(trimmed, 'a', 2)), [1_500, 3_250]);
  const head = reload(trimVideoClip(fixture(500, 2_000), 'a', 'start', 1_000).project);
  assert.deepEqual(bounds(setClipPlaybackRate(head, 'a', 2)), [500, 1_500]);
});

test('legacy inherited and partially inherited timings materialize from the before caption', () => {
  for (const field of ['startMs', 'endMs', 'both']) {
    const project = fixture();
    if (field !== 'endMs') delete cue(project).startMs;
    if (field !== 'startMs') delete cue(project).endMs;
    const expected = [(cue(project).startMs ?? 3_200) / 2, (cue(project).endMs ?? 3_800) / 2];
    assert.deepEqual(bounds(setClipPlaybackRate(project, 'a', 2)), expected);
  }
});

test('deleting a clip drops its linked cues and ripples surviving independent intervals', () => {
  const project = fixture();
  Object.assign(cue(project, 'c2'), { startMs: 3_500, endMs: 5_000 });
  const next = deleteVideoClip(project, 'a').project;
  assert.equal(cue(next), undefined);
  assert.deepEqual(bounds(next, 'c2'), [0, 1_000]);
  assert.deepEqual(bounds(reload(next), 'c2'), [0, 1_000]);
});

test('a cut wholly removing an independent interval hides it without erasing its text', () => {
  const project = fixture();
  Object.assign(cue(project, 'c2'), { startMs: 1_000, endMs: 2_000 });
  const next = deleteVideoClip(project, 'a').project;
  assert.deepEqual(bounds(next, 'c2'), [0, 0]);
  assert.equal(cue(next, 'c2').timelineVisible, false);
  assert.deepEqual(metadata(cue(next, 'c2')), metadata(cue(project, 'c2')));
  assert.equal(exportCaptionPairs(reload(next)).length, 0);
});

test('ripple cuts map translation intervals directly rather than primary endpoint changes', () => {
  const project = fixture(500, 2_500);
  const next = rippleTimedContent(project, 1_000, 2_000);
  assert.deepEqual(bounds(next), [500, 1_500]);
  assert.deepEqual(metadata(cue(next)), metadata(cue(project)));
});

test('reorder follows the translation interval even when it is outside its primary clip', () => {
  assert.deepEqual(bounds(reorderVideoClip(fixture(), 'b', 0).project), [7_300, 7_700]);
  assert.deepEqual(bounds(reorderVideoClip(fixture(4_500, 5_000), 'b', 0).project), [500, 1_000]);
  const spanning = reorderVideoClip(fixture(3_500, 4_500), 'b', 0).project;
  assert.deepEqual(bounds(spanning), [7_500, 8_000]);
  assert.deepEqual(bounds(reload(spanning)), [7_500, 8_000]);
});

test('split preserves timing and subsequent edits use the resulting clip intervals', () => {
  const project = fixture(1_500, 2_500);
  const split = splitVideoClip(project, 'a', 2_000, 'left', 'right').project;
  assert.deepEqual(bounds(split), [1_500, 2_500]);
  assert.deepEqual(bounds(setClipPlaybackRate(reload(split), 'right', 2)), [1_500, 2_250]);
  assert.deepEqual(bounds(reorderVideoClip(split, 'right', 0).project), [0, 500]);
});

test('reorder chooses maximum overlap, with primary anchor then prior order breaking ties', () => {
  for (const [start, end, anchor, expected] of [
    [3_500, 4_500, 'a', [7_500, 8_000]],
    [3_500, 4_500, 'b', [0, 500]],
    [3_500, 4_500, undefined, [7_500, 8_000]],
    [3_000, 4_500, 'b', [7_000, 8_000]],
    [3_500, 5_000, 'a', [0, 1_000]],
    [4_500, 5_000, 'a', [500, 1_000]],
  ]) {
    const original = fixture(start, end);
    original.captions[0].sourceAnchor = anchor
      ? { ...original.captions[0].sourceAnchor, clipId: anchor } : undefined;
    const next = reorderVideoClip(original, 'b', 0).project;
    assert.deepEqual(bounds(next), expected);
    assert.ok(cue(next).endMs - cue(next).startMs <= end - start);
    assert.equal(cue(next).timelineVisible, true);
    assert.deepEqual(metadata(cue(next)), metadata(cue(original)));
  }
});

test('gap-only and zero-overlap ranges keep absolute timing and hide only when empty', () => {
  for (const [start, end, expected, visible] of [
    [4_200, 4_800, [4_200, 4_800], true],
    [4_000, 5_000, [4_000, 5_000], true],
    [4_500, 4_500, [4_500, 4_500], false],
    [9_500, 10_000, [9_000, 9_000], false],
    [3_500, 4_900, [7_500, 8_900], true],
    [4_100, 5_500, [0, 500], true],
  ]) {
    const project = fixture(start, end);
    project.clips[0].gapAfterMs = 1_000;
    project.captions[1].startMs += 1_000;
    project.captions[1].endMs += 1_000;
    const next = reorderVideoClip(project, 'b', 0).project;
    assert.deepEqual(bounds(next), expected);
    assert.equal(cue(next).timelineVisible, visible);
    assert.deepEqual(bounds(reload(next)), expected);
  }
});

test('spanning and split/reorder intervals never widen, including repeated reorders', () => {
  for (const splitFirst of [false, true]) {
    for (const [start, end] of [[0, 0], [0, 8_000], [1_500, 2_500], [3_500, 4_500], [2_500, 6_500]]) {
      let project = fixture(start, end);
      if (splitFirst) project = splitVideoClip(project, 'a', 2_000, 'left', 'right').project;
      for (const [clipId, index] of splitFirst
        ? [['right', 0], ['b', 0], ['left', 0], ['right', 1]]
        : [['b', 0], ['a', 0], ['b', 0]]) {
        const width = cue(project).endMs - cue(project).startMs;
        project = reload(reorderVideoClip(project, clipId, index).project);
        const item = cue(project);
        assert.ok(item.endMs - item.startMs <= width);
        assert.ok(item.startMs >= 0 && item.endMs <= 8_000);
        assert.ok(item.endMs >= item.startMs);
      }
    }
  }
  // With room on both sides, the whole interval shifts without losing duration.
  const original = fixture(3_500, 4_500);
  original.clips.push({ ...original.clips[0], id: 'c' });
  assert.deepEqual(bounds(reorderVideoClip(original, 'b', 0).project), [7_500, 8_500]);
});

test('gap insertion/removal uses independent interval edges with left boundary affinity', () => {
  const project = fixture(3_000, 4_000);
  const inserted = setVideoClipGap(project, 'a', 1_000, 'after').project;
  assert.deepEqual(bounds(inserted), [3_000, 4_000]);
  assert.deepEqual(bounds(inserted, 'c2'), [5_500, 6_500]);
  assert.deepEqual(bounds(setVideoClipGap(inserted, 'a', 0, 'after').project, 'c2'), [4_500, 5_500]);
});

test('preview, export and SRT consume the same persisted independent interval', () => {
  for (const project of [
    trimVideoClip(fixture(), 'a', 'end', 2_000).project,
    setClipPlaybackRate(fixture(), 'a', 2),
    reorderVideoClip(fixture(), 'b', 0).project,
    reorderVideoClip(fixture(3_500, 4_500), 'b', 0).project,
    reorderVideoClip(fixture(4_500, 5_000), 'b', 0).project,
    reorderVideoClip(splitVideoClip(fixture(1_500, 2_500), 'a', 2_000, 'left', 'right').project, 'right', 0).project,
  ]) {
    const saved = reload(project);
    const trackId = saved.captionTracks.translations[0].id;
    const preview = resolveCaptionPairs(saved, trackId).find((pair) => pair.source.id === 'c1');
    const exported = exportCaptionPairs(saved).find((pair) => pair.source.id === 'c1');
    assert.deepEqual([preview.startMs, preview.endMs], bounds(saved));
    assert.deepEqual([exported.startMs, exported.endMs], [preview.startMs, preview.endMs]);
    const time = (ms) => `00:00:${String(Math.floor(ms / 1_000)).padStart(2, '0')},${String(ms % 1_000).padStart(3, '0')}`;
    assert.ok(serializeSrt(saved).includes(`${time(preview.startMs)} --> ${time(preview.endMs)}\nIndependent first`));
  }
});

test('schema rejects inverted explicit and mixed inherited bounds', () => {
  for (const range of [{ startMs: 3_000, endMs: 2_000 }, { startMs: 4_000, endMs: undefined },
    { startMs: undefined, endMs: 2_000 }]) {
    const project = fixture();
    Object.assign(cue(project), range);
    assert.throws(() => reload(project), /inverted timing/);
  }
});

test('invalid mappings fail explicitly and timing operations preserve hidden/skipped states', () => {
  const project = fixture();
  for (const result of [{ startMs: NaN, endMs: 1 }, { startMs: 2, endMs: 1 }]) {
    assert.throws(() => remapTranslationTrackTimings(project.captionTracks, project.captions,
      { operation: 'speed', durationMs: 4_000, mapRange: () => result }), /invalid timing/);
  }
  Object.assign(cue(project), { timelineVisible: false, translationSkipped: true });
  const next = setClipPlaybackRate(project, 'a', 2);
  assert.equal(cue(next).timelineVisible, false);
  assert.equal(cue(next).translationSkipped, true);
  assert.deepEqual(metadata(cue(next)), metadata(cue(project)));
});

test('zero-length cues at insertion boundaries remain finite and ordered', () => {
  const project = fixture(4_000, 4_000);
  const tracks = remapTranslationTrackTimings(project.captionTracks, project.captions,
    translationSpliceMapping({ atMs: 4_000, removeMs: 0, insertMs: 500 }, 8_500));
  const item = tracks.translations[0].cues[0];
  assert.ok(item.startMs >= 0 && item.endMs >= item.startMs);
});
