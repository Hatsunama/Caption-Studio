import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_GROUPING_OPTIONS, groupTimelineWordsByClip, groupWordsIntoCaptions } from '../src/lib/caption-grouping.ts';

test('short first speech in the next clip never borrows time from the preceding clip', () => {
  const words = [
    { id: 'clip-a-one', text: 'Earlier.', startMs: 0, endMs: 1000 },
    { id: 'clip-b-short', text: 'A.', startMs: 1000, endMs: 1040 },
    { id: 'clip-b-next', text: 'Longword.', startMs: 1040, endMs: 1500 },
  ];
  const captions = groupTimelineWordsByClip(words, ['clip-a', 'clip-b'], { ...DEFAULT_GROUPING_OPTIONS, maxWords: 1 });
  assert.equal(captions.length, 3);
  assert.deepEqual(captions.flatMap((caption) => caption.wordIds), words.map((word) => word.id));
  assert.equal(captions[1].startMs, 1000);
  for (let index = 1; index < captions.length; index++) assert.ok(captions[index].startMs >= captions[index - 1].endMs);
});

test('visual padding respects the owning timing window and never changes source words', () => {
  const word = { id: 'tiny', text: 'Tiny.', startMs: 995, endMs: 1000 };
  const captions = groupWordsIntoCaptions([word], DEFAULT_GROUPING_OPTIONS, { startMs: 980, endMs: 1000 });
  assert.equal(captions[0].startMs, 980);
  assert.equal(captions[0].endMs, 1000);
  assert.deepEqual(word, { id: 'tiny', text: 'Tiny.', startMs: 995, endMs: 1000 });
});

test('short-cue padding cannot exceed the configured maximum cue duration', () => {
  const captions = groupWordsIntoCaptions([
    { id: 'tiny', text: 'Tiny.', startMs: 995, endMs: 1000 },
  ], { ...DEFAULT_GROUPING_OPTIONS, maxDurationMs: 40 });
  assert.equal(captions[0].endMs - captions[0].startMs, 40);
});
