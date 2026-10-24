import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captionCjkCharacterCount,
  captionTextHead,
  captionTextLength,
  captionTextPrefixLength,
  captionTextTail,
  safeCaptionTextOffset,
  spreadCaptionTokensAcrossRange,
} from '../src/lib/caption-text-breaks.ts';

const us = '\u{1F1FA}\u{1F1F8}';
const ca = '\u{1F1E8}\u{1F1E6}';
const england = String.fromCodePoint(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f);
const scotland = String.fromCodePoint(0x1f3f4, 0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074, 0xe007f);
const wales = String.fromCodePoint(0x1f3f4, 0xe0067, 0xe0062, 0xe0077, 0xe006c, 0xe0073, 0xe007f);

test('the midpoint of a flag snaps to its start, including between ordinary characters', () => {
  assert.equal(safeCaptionTextOffset(`a${us}b`, 3), 1);
});

test('the reported English tag-flag interior snaps to the flag start', () => {
  const text = `a${england}b`;
  assert.equal(safeCaptionTextOffset(text, 5), 1);
  assert.equal(captionTextLength(text), 3);
});

const cases = [
  ['English tag flag', [england]],
  ['Scottish tag flag', [scotland]],
  ['Welsh tag flag', [wales]],
  ['English tag flag between ordinary characters', ['a', england, 'b']],
  ['Scottish tag flag between ordinary characters', ['a', scotland, 'b']],
  ['Welsh tag flag between ordinary characters', ['a', wales, 'b']],
  ['adjacent tag flags', [england, scotland, wales]],
  ['tag flags adjacent to RI and ZWJ clusters', [us, england, '\u{1F469}\u200D\u{1F4BB}', scotland, ca, wales, 'b']],
  ['paired flag', [us]],
  ['three regional indicators', [us, '\u{1F1E8}']],
  ['four regional indicators', [us, ca]],
  ['flags adjacent to ordinary characters', ['a', us, 'b', ca, 'c']],
  ['ordinary characters reset regional pairing', ['\u{1F1FA}', 'a', '\u{1F1F8}\u{1F1E8}']],
  ['combining marks', ['a', 'e\u0301', 'b']],
  ['ZWJ family', ['a', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}', 'b']],
  ['ZWJ technologist with skin modifier', ['a', '\u{1F469}\u{1F3FD}\u200D\u{1F4BB}', 'b']],
  ['variation selector', ['a', '\u2764\uFE0F', 'b']],
  ['keycap', ['a', '1\uFE0F\u20E3', 'b']],
  ['mixed existing clusters and flags', ['e\u0301', us, '\u{1F469}\u200D\u{1F4BB}', ca, '1\uFE0F\u20E3']],
];

for (const [label, clusters] of cases) {
  test(`${label}: length, head, tail, prefix and every UTF-16 offset agree`, () => {
    const text = clusters.join('');
    assert.equal(captionTextLength(text), clusters.length);
    assert.equal(captionTextHead(text, 0), '');
    assert.equal(captionTextTail(text, 0), '');
    assert.equal(captionTextHead(text, clusters.length + 1), text);
    assert.equal(captionTextTail(text, clusters.length + 1), text);

    let start = 0;
    for (let index = 0; index < clusters.length; index += 1) {
      const end = start + clusters[index].length;
      assert.equal(captionTextHead(text, index + 1), clusters.slice(0, index + 1).join(''));
      assert.equal(captionTextTail(text, clusters.length - index), clusters.slice(index).join(''));
      for (let offset = start; offset <= end; offset += 1) {
        const snapsToStart = offset - start <= end - offset;
        const expected = snapsToStart ? start : end;
        assert.equal(safeCaptionTextOffset(text, offset), expected, `${label}: offset ${offset}`);
        assert.equal(captionTextPrefixLength(text, offset), snapsToStart ? index : index + 1);
      }
      start = end;
    }
    assert.equal(safeCaptionTextOffset(text, -1), 0);
    assert.equal(safeCaptionTextOffset(text, text.length + 1), text.length);
  });
}

test('every standard tag character extends the preceding cluster', () => {
  for (let codePoint = 0xe0020; codePoint <= 0xe007f; codePoint += 1) {
    const cluster = `\u{1F3F4}${String.fromCodePoint(codePoint)}`;
    const text = `a${cluster}b`;
    assert.equal(captionTextLength(text), 3, `tag U+${codePoint.toString(16)}`);
    assert.equal(captionTextHead(text, 2), `a${cluster}`);
    assert.equal(captionTextTail(text, 2), `${cluster}b`);
    for (let offset = 1; offset <= 1 + cluster.length; offset += 1) {
      const snapsToStart = offset - 1 <= 1 + cluster.length - offset;
      assert.equal(safeCaptionTextOffset(text, offset), snapsToStart ? 1 : 1 + cluster.length);
      assert.equal(captionTextPrefixLength(text, offset), snapsToStart ? 1 : 2);
    }
  }
});

test('ordinary mid-word offsets remain available', () => {
  const text = 'CaptionStudio';
  for (let offset = 0; offset <= text.length; offset += 1) {
    assert.equal(safeCaptionTextOffset(text, offset), offset);
    assert.equal(captionTextPrefixLength(text, offset), offset);
  }
  assert.equal(safeCaptionTextOffset(text, 3.9), 3);
});

test('regional pairs do not consume the CJK character budget', () => {
  assert.equal(captionCjkCharacterCount(`\u4F60${us}\u{20BB7}${ca}\u597D`), 3);
  assert.equal(captionCjkCharacterCount(us + ca), 0);
});

test('newly spread token timing uses one unit per flag and preserves the supplied range', () => {
  const tokens = spreadCaptionTokensAcrossRange(`${us} ab`, 100, 1000, 'flag');
  assert.deepEqual(tokens, [
    { id: 'flag:spread-0', text: us, startMs: 100, endMs: 400 },
    { id: 'flag:spread-1', text: 'ab', startMs: 400, endMs: 1000 },
  ]);
});
