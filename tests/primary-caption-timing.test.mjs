import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_GROUPING_OPTIONS, groupTimelineWordsByClip, groupWordsIntoCaptions } from '../src/lib/caption-grouping.ts';
import { canonicalizeSourceWords, normalizeProjectedPrimaryWords } from '../src/lib/primary-caption-timing.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { setVideoClipLeadingGap } from '../src/lib/project-editor.ts';
import { anchorCaptionsToClips, mapSourceWordsToTimeline, remapCaptionsToTimeline, rippleTimedContent, setClipPlaybackRate } from '../src/lib/video-timeline.ts';

function projectFixture() {
  return createCaptionProject({ id: 'primary-timing', name: 'Primary timing', sources: [{
    id: 'source', uri: 'content://video', storageMode: 'linked', displayName: 'clip.mp4',
    durationMs: 1_000, width: 1080, height: 1920, rotation: 0,
  }] });
}

test('canonical source words survive checkpoint projection and a clip edit without moving acoustic starts', () => {
  const project = projectFixture();
  const sourceId = project.clips[0].sourceId;
  const canonical = canonicalizeSourceWords([
    { id: 'first', text: 'First.', startMs: 100, endMs: 500 },
    { id: 'second', text: 'Second.', startMs: 150, endMs: 600 },
  ], 1_000);
  assert.deepEqual(canonical.map(({ startMs, endMs }) => [startMs, endMs]), [[100, 150], [150, 600]]);
  project.transcription.sourceResults[sourceId] = {
    language: 'en', modelId: 'balanced', generatedAt: '2026-09-24T00:00:00.000Z', words: canonical,
  };
  project.transcription.words = mapSourceWordsToTimeline(project.clips, { [sourceId]: canonical });
  const edited = setVideoClipLeadingGap(project, project.clips[0].id, 100).project;
  assert.deepEqual(edited.transcription.words.map(({ startMs, endMs }) => [startMs, endMs]), [[200, 250], [250, 700]]);
  assert.deepEqual(edited.transcription.sourceResults[sourceId].words, canonical);
});

test('new primary groups remain sequential without squeezing a cue to one millisecond', () => {
  const project = projectFixture();
  const projected = mapSourceWordsToTimeline(project.clips, { [project.clips[0].sourceId]: [
    { id: 'a', text: 'First.', startMs: 0, endMs: 300 },
    { id: 'b', text: 'Second.', startMs: 100, endMs: 350 },
    { id: 'c', text: 'Third.', startMs: 120, endMs: 370 },
  ] });
  const words = normalizeProjectedPrimaryWords(projected, project.clips[0].id, 0, 1_000);
  const captions = groupWordsIntoCaptions(words);
  assert.deepEqual(captions.map(({ text, wordIds }) => [text, wordIds]), [
    ['First.', [words[0].id]], ['Second. Third.', [words[1].id, words[2].id]],
  ]);
  assert.ok(captions.every((caption, index) => caption.endMs - caption.startMs >= 80
    && (index === 0 || caption.startMs >= captions[index - 1].endMs)));
  assert.deepEqual(captions.map(({ startMs, endMs }) => [startMs, endMs]), [[0, 100], [100, 370]]);
});

test('clip projection preserves source word timing for legacy recovery and edits', () => {
  const project = projectFixture();
  const clipId = project.clips[0].id;
  const words = mapSourceWordsToTimeline(project.clips, { [project.clips[0].sourceId]: [
    { id: 'first', text: 'First', startMs: 100, endMs: 400 },
    { id: 'second', text: 'Second', startMs: 250, endMs: 500 },
  ] });
  assert.deepEqual(words.map(({ id, startMs, endMs }) => [id, startMs, endMs]), [
    [`${clipId}-first`, 100, 400], [`${clipId}-second`, 250, 500],
  ]);
});

test('an isolated unrepresentably short word reports a timing quality failure', () => {
  assert.throws(() => groupWordsIntoCaptions([
    { id: 'tiny', text: 'Tiny.', startMs: 995, endMs: 1_000 },
  ]), /Primary caption timing quality failure for caption-1, words tiny: isolated short word interval/);
});

test('a short group cannot merge into a caption beyond the configured text budget', () => {
  const words = [
    { id: 'short', text: 'A.', startMs: 0, endMs: 40 },
    { id: 'neighbor', text: 'Longword.', startMs: 40, endMs: 500 },
  ];
  for (const options of [
    { ...DEFAULT_GROUPING_OPTIONS, maxWords: 1, maxCharacters: 99 },
    { ...DEFAULT_GROUPING_OPTIONS, maxWords: 99, maxCharacters: 10 },
  ]) {
    assert.throws(() => groupWordsIntoCaptions(words, options),
      /Primary caption timing quality failure.*short.*text budget/);
  }
  assert.throws(() => groupWordsIntoCaptions([
    { id: 'short', text: '你。', startMs: 0, endMs: 40 },
    { id: 'neighbor', text: '好。', startMs: 40, endMs: 500 },
  ], { ...DEFAULT_GROUPING_OPTIONS, maxCjkCharacters: 1 }),
  /Primary caption timing quality failure.*short.*text budget/);
});

test('unresolved long word fails cue sizing with clip and word provenance', () => {
  const project = projectFixture();
  project.clips[0].sourceEndMs = 16_000;
  const clipId = project.clips[0].id;
  const words = mapSourceWordsToTimeline(project.clips, {
    [project.clips[0].sourceId]: [
      { id: 'unbounded', text: 'Cannot guess.', startMs: 373, endMs: 14_502 },
    ],
  });
  assert.throws(() => groupTimelineWordsByClip(words, [clipId]),
    new RegExp(`Primary caption timing quality failure for caption-1, words ${clipId}-unbounded`));
});

test('overlapping generated words at a clip boundary stay in their owning clip and anchor once', () => {
  const project = projectFixture();
  project.clips = [
    { ...project.clips[0], id: 'left' },
    { ...project.clips[0], id: 'right', sourceId: 'right-source' },
  ];
  const projected = mapSourceWordsToTimeline(project.clips, {
    [project.clips[0].sourceId]: [
      { id: 'first', text: 'First.', startMs: 850, endMs: 990 },
      { id: 'second', text: 'Second.', startMs: 900, endMs: 1_000 },
    ],
    'right-source': [{ id: 'third', text: 'Third.', startMs: 0, endMs: 100 }],
  });
  const words = [
    ...normalizeProjectedPrimaryWords(projected.filter((word) => word.id.startsWith('left-')), 'left', 0, 1_000),
    ...normalizeProjectedPrimaryWords(projected.filter((word) => word.id.startsWith('right-')), 'right', 1_000, 2_000),
  ];
  const captions = groupTimelineWordsByClip(words, ['left', 'right']);
  assert.deepEqual(captions.flatMap((caption) => caption.wordIds), words.map((word) => word.id));
  assert.deepEqual(captions.map((caption) => caption.text), ['First. Second.', 'Third.']);
  assert.ok(captions.every((caption, index) => caption.endMs > caption.startMs
    && (index === 0 || caption.startMs >= captions[index - 1].endMs)));
  assert.ok(captions.filter((caption) => caption.id.startsWith('caption-left-'))
    .every((caption) => caption.startMs >= 0 && caption.endMs <= 1_000));
  assert.ok(captions.filter((caption) => caption.id.startsWith('caption-right-'))
    .every((caption) => caption.startMs >= 1_000 && caption.endMs <= 2_000));

  const anchored = anchorCaptionsToClips(captions, project.clips, words);
  assert.deepEqual(anchored.map((caption) => caption.wordIds), [['left-first', 'left-second'], ['right-third']]);
  assert.deepEqual(anchored.map((caption) => [caption.sourceAnchor.clipId,
    caption.sourceAnchor.sourceStartMs, caption.sourceAnchor.sourceEndMs]), [
    ['left', 850, 1_000], ['right', 0, 100],
  ]);
});

test('a long word endpoint is corrected before it can merge a chain of primary cues', () => {
  const project = projectFixture();
  project.clips[0].sourceEndMs = 16_000;
  const clipId = project.clips[0].id;
  const sourceWords = [
    { id: 'first', text: 'Hello.', startMs: 373, endMs: 14_502 },
    { id: 'second', text: 'These', startMs: 2_193, endMs: 2_520 },
    { id: 'third', text: 'words', startMs: 2_540, endMs: 2_870 },
    { id: 'fourth', text: 'need', startMs: 2_900, endMs: 3_180 },
    { id: 'fifth', text: 'their', startMs: 3_210, endMs: 3_480 },
    { id: 'sixth', text: 'own', startMs: 3_510, endMs: 3_800 },
    { id: 'seventh', text: 'cue.', startMs: 3_830, endMs: 4_140 },
  ];
  const projected = mapSourceWordsToTimeline(project.clips, { [project.clips[0].sourceId]: sourceWords });
  const words = normalizeProjectedPrimaryWords(projected, clipId, 0, 16_000);
  const captions = groupTimelineWordsByClip(words, [clipId]);
  const anchored = anchorCaptionsToClips(captions, project.clips, words);
  assert.ok(words[0].endMs <= words[1].startMs);
  assert.deepEqual(captions.flatMap((caption) => caption.wordIds), sourceWords.map((word) => `${clipId}-${word.id}`));
  assert.deepEqual(captions.map((caption) => caption.text), ['Hello.', 'These words need their own cue.']);
  assert.ok(captions.every((caption, index) => caption.endMs - caption.startMs <= 3_200
    && caption.endMs <= 16_000
    && (index === 0 || caption.startMs >= captions[index - 1].endMs)));
  assert.deepEqual(anchored.map((caption) => [caption.id, caption.text, caption.wordIds,
    caption.sourceAnchor.sourceStartMs, caption.sourceAnchor.sourceEndMs]),
  captions.map((caption) => [caption.id, caption.text, caption.wordIds, caption.startMs, caption.endMs]));
});

test('anchoring and remapping keep positive short primary cues visible', () => {
  const project = projectFixture();
  const clipId = project.clips[0].id;
  const word = { id: `${clipId}-word`, text: 'Short', startMs: 100, endMs: 140 };
  const caption = { id: 'short', text: 'Short', textMode: 'automatic',
    startMs: 100, endMs: 140, wordIds: [word.id], timelineVisible: true };
  const anchored = anchorCaptionsToClips([caption], project.clips, [word]);
  assert.equal(anchored[0].timelineVisible, true);
  assert.equal(remapCaptionsToTimeline(anchored, project.clips, [word])[0].timelineVisible, true);
  assert.equal(remapCaptionsToTimeline([{ ...anchored[0], timelineVisible: false }], project.clips, [word])[0].timelineVisible, false);
});

test('a source cue clipped wholly out of view reappears when its clip is restored', () => {
  const project = projectFixture();
  const clipId = project.clips[0].id;
  const cue = { id: 'restorable', text: 'Keep edited text', textMode: 'manual',
    startMs: 100, endMs: 300, wordIds: [], timelineVisible: true,
    sourceAnchor: { clipId, sourceStartMs: 100, sourceEndMs: 300, wordIds: [] } };
  const trimmed = remapCaptionsToTimeline([cue], [{ ...project.clips[0], sourceStartMs: 500 }], []);
  assert.equal(trimmed[0].timelineVisible, false);
  assert.equal(trimmed[0].startMs, trimmed[0].endMs);
  const restored = remapCaptionsToTimeline(trimmed, project.clips, []);
  assert.deepEqual([restored[0].text, restored[0].startMs, restored[0].endMs, restored[0].timelineVisible],
    ['Keep edited text', 100, 300, true]);
});

test('ripple cuts retain positive short primary fragments with identity and text', () => {
  const project = projectFixture();
  project.captions = [{ id: 'survivor', text: 'Authored text', textMode: 'manual',
    startMs: 0, endMs: 200, wordIds: [], timelineVisible: true }];
  const next = rippleTimedContent(project, 50, 200);
  assert.deepEqual(next.captions.map(({ id, text, startMs, endMs, timelineVisible }) =>
    ({ id, text, startMs, endMs, timelineVisible })), [
    { id: 'survivor', text: 'Authored text', startMs: 0, endMs: 50, timelineVisible: true },
  ]);
});

test('speed remaps short primary cues and retains explicit visibility', () => {
  const project = projectFixture();
  project.captions = [{ id: 'short', text: 'Keep me', textMode: 'manual',
    startMs: 100, endMs: 200, wordIds: [], timelineVisible: true }];
  const sped = setClipPlaybackRate(project, project.clips[0].id, 4);
  assert.deepEqual(sped.captions.map(({ id, text, startMs, endMs, timelineVisible }) =>
    ({ id, text, startMs, endMs, timelineVisible })), [
    { id: 'short', text: 'Keep me', startMs: 25, endMs: 50, timelineVisible: true },
  ]);
});
