import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  alignCaptionTimedWords,
  captionPlaybackTimedWords,
  captionSplitBoundaryAtCursor,
  captionLayoutText,
  captionSpokenTokenSpans,
  captionTextHead,
  captionTextLength,
  captionTextTail,
  captionTextTokens,
  safeCaptionTextOffset,
  compactCaptionToken,
} from '../src/lib/caption-text-breaks.ts';

const timingContract = readFileSync(
  new URL('../modules/caption-media/android/src/test/resources/caption-word-timing-contract.tsv', import.meta.url),
  'utf8',
).trim().split(/\r?\n/).slice(1).map((line) => {
  const [valid, caption, timed, rendered] = line.split('\t');
  return {
    valid: valid === 'true',
    caption,
    timed: timed.split('␞'),
    rendered: rendered === '<empty>' ? [] : rendered.split('␞'),
  };
});

test('Chinese captions expose safe wrapping boundaries while preserving Latin words and emoji clusters', () => {
  assert.deepEqual(captionTextTokens('你好，世界 Caption Studio'), ['你', '好', '，', '世', '界', 'Caption', 'Studio']);
  assert.deepEqual(captionTextTokens('字👩🏽‍💻幕'), ['字', '👩🏽‍💻', '幕']);
  assert.equal(captionLayoutText(['你', '好', 'Caption', 'Studio']), '你好Caption Studio');
  assert.equal(compactCaptionToken('你'), true);
  assert.equal(compactCaptionToken('，'), true);
  assert.equal(compactCaptionToken('Caption'), false);
});

test('caption layout uses locale-appropriate spacing around Chinese and Latin punctuation', () => {
  assert.equal(captionLayoutText(['你', '好，', '世', '界！']), '你好，世界！');
  assert.equal(captionLayoutText(['Caption,', 'Studio!']), 'Caption, Studio!');
  assert.equal(captionLayoutText(['AI', '字幕', '很', '自然。']), 'AI字幕很自然。');
  assert.deepEqual(
    captionSpokenTokenSpans('「繁體字幕」，真的很好！').map((span) => span.text),
    ['「繁', '體', '字', '幕」，', '真', '的', '很', '好！'],
  );
});

test('caption offsets are grapheme-safe and CJK split boundaries do not depend on spaces', () => {
  const text = '𠮷好，世界';
  assert.equal(captionTextLength('𠮷好👩🏽‍💻'), 3);
  assert.equal(captionTextHead('𠮷好👩🏽‍💻', 2), '𠮷好');
  assert.equal(captionTextTail('𠮷好👩🏽‍💻', 2), '好👩🏽‍💻');
  assert.equal(safeCaptionTextOffset(text, 1), 0);
  assert.deepEqual(captionSplitBoundaryAtCursor(text, 4), { offset: 4, tokenIndex: 2 });
});

test('word-timed caption alignment follows the shared mixed-script and punctuation contract', () => {
  for (const row of timingContract) {
    const words = row.timed.map((text, index) => ({
      id: `word-${index}`,
      text,
      startMs: index * 200,
      endMs: (index + 1) * 200,
    }));
    const aligned = alignCaptionTimedWords(words, row.caption);
    assert.equal(aligned.length > 0, row.valid, row.caption);
    assert.deepEqual(aligned.map((word) => word.text), row.rendered, row.caption);
  }
});

test('packed CJK timing is split by grapheme without splitting astral characters', () => {
  const aligned = alignCaptionTimedWords([
    { id: 'packed', text: '𠮷好', startMs: 100, endMs: 300 },
  ], '𠮷好');
  assert.deepEqual(aligned.map(({ id, text, startMs, endMs }) => ({ id, text, startMs, endMs })), [
    { id: 'packed:timing-0', text: '𠮷', startMs: 100, endMs: 200 },
    { id: 'packed:timing-1', text: '好', startMs: 200, endMs: 300 },
  ]);
});

test('edited captions that no longer match Whisper tokens still highlight across the subtitle window', () => {
  const spread = captionPlaybackTimedWords(
    [{ id: 'word-1', text: 'hello', startMs: 100, endMs: 400 }],
    'hello there extra',
    { id: 'caption', startMs: 1_000, endMs: 2_000 },
  );
  assert.equal(spread.length, 3);
  assert.equal(spread[0].startMs, 1_000);
  assert.equal(spread.at(-1)?.endMs, 2_000);
  assert.ok(spread.every((word) => word.endMs > word.startMs));
  assert.deepEqual(spread.map((word) => word.text), ['hello', 'there', 'extra']);
});
