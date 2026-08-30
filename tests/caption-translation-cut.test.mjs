import assert from 'node:assert/strict';
import test from 'node:test';

import { groupingOptionsForLanguage, groupWordsIntoCaptions } from '../src/lib/caption-grouping.ts';
import {
  automaticTranslationTargetTags,
  canAutomaticallyTranslatePair,
  captionLanguageLabel,
  captionGroupingProfile,
  dualCaptionLanguageChoices,
  TOP_SPOKEN_CAPTION_LANGUAGES,
} from '../src/lib/caption-languages.ts';
import { cutTranslatedDocument, packCaptionDocuments } from '../src/lib/caption-translation-cut.ts';

test('the spoken-language catalog covers twenty languages without claiming fake translation providers', () => {
  assert.equal(TOP_SPOKEN_CAPTION_LANGUAGES.length, 20);
  assert.equal(TOP_SPOKEN_CAPTION_LANGUAGES.filter((language) => language.automaticTranslation).length, 3);
  assert.equal(captionLanguageLabel('es'), 'Spanish');
  assert.equal(captionLanguageLabel('zh-CN'), 'Chinese (Simplified)');
  assert.equal(captionGroupingProfile('ko'), 'hangul');
  assert.equal(captionGroupingProfile('th'), 'thai');
  assert.deepEqual(automaticTranslationTargetTags('en'), ['zh-Hans', 'zh-Hant']);
  assert.deepEqual(automaticTranslationTargetTags('zh-TW'), ['en']);
  const englishChoices = dualCaptionLanguageChoices('en');
  assert.equal(englishChoices.some((choice) => choice.tag === 'en'), false);
  assert.equal(englishChoices.find((choice) => choice.tag === 'zh-Hans')?.automatic, true);
  assert.equal(englishChoices.find((choice) => choice.tag === 'es')?.automatic, false);
  assert.equal(canAutomaticallyTranslatePair('en', 'zh-Hans'), true);
  assert.equal(canAutomaticallyTranslatePair('es', 'en'), false);
  const spanishChoices = dualCaptionLanguageChoices('es');
  assert.equal(spanishChoices.some((choice) => choice.tag === 'es'), false);
  assert.equal(spanishChoices.every((choice) => choice.automatic === false), true);
});

test('Chinese grouping stays character-limited while English grouping stays word-limited', () => {
  assert.equal(groupingOptionsForLanguage('zh-Hans').maxCjkCharacters, 16);
  assert.equal(groupingOptionsForLanguage('en').maxWords, 7);
  const english = groupWordsIntoCaptions([
    { id: 'w1', text: 'first', startMs: 0, endMs: 200 },
    { id: 'w2', text: 'caption', startMs: 210, endMs: 400 },
    { id: 'w3', text: 'second.', startMs: 1_100, endMs: 1_300 },
  ], groupingOptionsForLanguage('en'));
  assert.equal(english.length, 2);
});

test('whole-script translation packs captions then cuts the result back to the original rhythm', () => {
  const captions = [
    { id: 'c1', text: 'Hello world.', startMs: 0, endMs: 1_000 },
    { id: 'c2', text: 'How are you today?', startMs: 1_100, endMs: 2_400 },
    { id: 'c3', text: 'See you later.', startMs: 2_500, endMs: 3_200 },
  ];
  const chunks = packCaptionDocuments(captions);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].sourceIds.join(','), 'c1,c2,c3');
  const cut = cutTranslatedDocument(
    '你好，世界。你今天怎么样？回头见。',
    captions,
    'zh-Hans',
  );
  assert.equal(cut.size, 3);
  assert.ok([...cut.values()].every((text) => text.length > 0));
  assert.ok((cut.get('c1') ?? '').includes('你'));
});

test('document packing respects the model chunk budget without splitting a caption', () => {
  const captions = [
    { id: 'a', text: 'A'.repeat(900) },
    { id: 'b', text: 'B'.repeat(900) },
  ];
  const chunks = packCaptionDocuments(captions, 900);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((chunk) => chunk.sourceIds), [['a'], ['b']]);
});
