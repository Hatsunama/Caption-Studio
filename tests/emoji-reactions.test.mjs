import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { reactionEmojis } from '../src/lib/emoji-reactions.ts';

const reactionCatalog = JSON.parse(readFileSync(
  new URL('../modules/caption-media/android/src/main/assets/emoji-reactions.json', import.meta.url),
  'utf8',
));
const contextContract = readFileSync(
  new URL('../modules/caption-media/android/src/test/resources/emoji-reaction-context-contract.tsv', import.meta.url),
  'utf8',
).trim().split(/\r?\n/u).slice(1).map((line) => {
  const [expected, caption, serializedWords, activeIndex] = line.split('\t');
  return {
    expected,
    caption,
    words: serializedWords.split('␞'),
    activeIndex: Number(activeIndex),
  };
});

test('spoken concepts select distinct semantic reaction families', () => {
  assert.deepEqual(reactionEmojis('money'), ['💸', '🤑', '💰', '🪙', '💵', '💳']);
  assert.deepEqual(reactionEmojis('camera'), ['🎥', '📸', '🎬', '📹', '🍿', '📺']);
  assert.notDeepEqual(reactionEmojis('money'), reactionEmojis('sad'));
  assert.equal(new Set(reactionEmojis('camera')).size, 6);
});

test('English and Chinese variants resolve to the same concept', () => {
  assert.deepEqual(reactionEmojis('recording'), reactionEmojis('camera'));
  assert.deepEqual(reactionEmojis('loved'), reactionEmojis('love'));
  assert.deepEqual(reactionEmojis('dancing'), reactionEmojis('dance'));
  assert.deepEqual(reactionEmojis('开心'), reactionEmojis('happy'));
  assert.deepEqual(reactionEmojis('汽车'), reactionEmojis('car'));
  assert.deepEqual(reactionEmojis('钱'), reactionEmojis('money'));
  assert.deepEqual(reactionEmojis('愛'), reactionEmojis('love'));
});

test('filler and unknown words do not recycle an unrelated caption reaction', () => {
  assert.deepEqual(reactionEmojis('the', 'Turn on the camera'), []);
  assert.deepEqual(reactionEmojis('unmapped-one'), []);
  assert.deepEqual(reactionEmojis('unmapped-two'), []);
});

test('active Simplified and Traditional Chinese graphemes resolve through their local timed phrase', () => {
  contextContract.forEach(({ expected, caption, words, activeIndex }) => {
    const actual = reactionEmojis(words[activeIndex], caption, { words, activeIndex });
    const expectedEmojis = expected === '<empty>' ? [] : reactionEmojis(expected);
    assert.deepEqual(actual, expectedEmojis, `${caption} active token ${words[activeIndex]}`);
  });
});

test('semantic reactions are deterministic, diverse, and never use an unrelated nearby phrase', () => {
  const words = ['打', '开', '相', '机', '的'];
  const first = reactionEmojis(words[4], '打开相机的', { words, activeIndex: 4 });
  const second = reactionEmojis(words[4], '打开相机的', { words, activeIndex: 4 });
  assert.deepEqual(first, []);
  assert.deepEqual(second, first);

  const categories = ['money', 'camera', 'sad', 'happy', 'car', 'shopping', 'question', 'technology'];
  const families = categories.map((word) => reactionEmojis(word));
  assert.equal(new Set(families.map((family) => family.join(''))).size, categories.length);
  families.forEach((family) => assert.equal(new Set(family).size, 6));
});

test('every catalog keyword resolves to its declared family, including each active CJK grapheme', () => {
  const familySignatures = new Set();
  const categoryIds = new Set();
  reactionCatalog.categories.forEach((category) => {
    assert.ok(!categoryIds.has(category.id), `duplicate category ${category.id}`);
    categoryIds.add(category.id);
    assert.ok(category.emojis.length >= 6, `${category.id} has too few reactions`);
    assert.equal(new Set(category.emojis).size, category.emojis.length, `${category.id} repeats an emoji`);
    const signature = [...category.emojis].sort().join('');
    assert.ok(!familySignatures.has(signature), `${category.id} duplicates another category family`);
    familySignatures.add(signature);

    category.keywords.forEach((keyword) => {
      if (/\p{Script=Han}/u.test(keyword)) {
        const words = Array.from(keyword);
        words.forEach((word, activeIndex) => {
          assert.deepEqual(
            reactionEmojis(word, keyword, { words, activeIndex }),
            category.emojis,
            `${category.id}: ${keyword} active token ${word}`,
          );
        });
      } else {
        assert.deepEqual(reactionEmojis(keyword), category.emojis, `${category.id}: ${keyword}`);
      }
    });
  });
});
