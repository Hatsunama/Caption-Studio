import assert from 'node:assert/strict';
import test from 'node:test';
import { isLikelyUntranslatedCaption } from '../src/lib/caption-languages.ts';
import { usableAutomaticTranslation, automaticTranslationCueWrites } from '../src/lib/caption-translation-commit.ts';
import { acceptTranslationBoundary } from '../src/lib/translation-invariants.ts';

test('case, punctuation, spacing and NFC normalized sentence echoes are rejected', () => {
  for (const [source, output, target] of [
    ['Hello, world!', 'HELLO WORLD.', 'es'], ['Bonjour le monde', 'bonjour, le monde!', 'fr'],
    ['Caf\u00e9 au lait', 'CAFE\u0301 AU LAIT!', 'en'], ['One-two', 'one two', 'de'],
    ['Hello world', 'hello\u00a0world', 'pt'],
  ]) {
    assert.equal(isLikelyUntranslatedCaption(source, output, target), true, `${target}: ${output}`);
    assert.equal(usableAutomaticTranslation(source, output, false, target), undefined);
  }
});

test('English requires Latin script and rejects Han, matching native basic screening', () => {
  for (const output of ['\u041f\u0440\u0438\u0432\u0435\u0442', '\u0645\u0631\u062d\u0628\u0627', '\u3053\u3093\u306b\u3061\u306f', '\ud55c\uae00', '123!', 'Hello \u4e16\u754c']) {
    assert.equal(isLikelyUntranslatedCaption('Bonjour', output, 'en-US'), true, output);
  }
  assert.equal(isLikelyUntranslatedCaption('Bonjour', 'Hello', 'en'), false);
  assert.equal(isLikelyUntranslatedCaption('Salutation', 'H\u00e9llo', 'en'), false);
});

test('Chinese variant screening uses native character sets and keeps shared Han characters', () => {
  for (const [output, target] of [['\u9019\u500b\u570b\u5bb6', 'zh-Hans'], ['\u8fd9\u4e2a\u56fd\u5bb6', 'zh-Hant'],
    ['\u96f2', 'zh-CN'], ['\u4e91', 'zh-TW'], ['\u4f60\u597d\u9580', 'zh-Hans'], ['\u4f60\u597d\u95e8', 'zh-Hant'],
    ['\u0645\u0631\u062d\u0628\u0627', 'zh-Hans']]) {
    assert.equal(isLikelyUntranslatedCaption('A greeting', output, target), true, `${target}: ${output}`);
  }
  for (const [output, target] of [['\u8fd9\u4e2a\u56fd\u5bb6', 'zh-Hans'], ['\u9019\u500b\u570b\u5bb6', 'zh-Hant'],
    ['\u4f60\u597d', 'zh-Hans'], ['\u4f60\u597d', 'zh-Hant'], ['\ud842\udfb7', 'zh-Hans']]) {
    assert.equal(isLikelyUntranslatedCaption('A greeting', output, target), false);
  }
});

test('invariants and borrowed acknowledgements remain usable; native invalid remains authoritative', () => {
  for (const [source, output] of [['Okay.', 'OK!'], ['42', '42'], ['https://example.test', 'https://example.test']]) {
    for (const target of ['en', 'zh-Hans', 'zh-Hant', 'fr']) {
      assert.equal(usableAutomaticTranslation(source, output, false, target), output);
      assert.equal(usableAutomaticTranslation(source, output, true, target), undefined);
    }
  }
  const result = acceptTranslationBoundary([{ id: 'cue', text: 'Bonjour' }], [{ id: 'cue', text: 'Hello', valid: false }]);
  assert.equal(result.translations.get('cue'), '');
  assert.equal(result.rejected.has('cue'), true);
  assert.equal(isLikelyUntranslatedCaption('Bring the documents tomorrow', 'OK', 'fr'), true);
  assert.equal(isLikelyUntranslatedCaption('O K', 'O K', 'fr'), true);
});

test('same-script non-echo output is screened without guessing its semantic language', () => {
  assert.equal(isLikelyUntranslatedCaption('Hello world', 'Good morning', 'fr'), false);
  assert.equal(isLikelyUntranslatedCaption('Bonjour', 'Hola', 'en'), false);
});

test('rejected normalized echoes retain saved text and leave empty cues unresolved', () => {
  const writes = automaticTranslationCueWrites({ captions: [{ id: 'saved', text: 'Hello world' }, { id: 'empty', text: 'Good morning' }],
    translatedById: new Map([['saved', 'HELLO, WORLD!'], ['empty', 'GOOD MORNING!']]),
    previousById: new Map([['saved', 'Bonjour le monde']]), targetLanguage: 'fr' });
  assert.deepEqual(writes, [{ sourceCaptionId: 'saved', translatedText: 'Bonjour le monde', translationStatus: 'stale' }]);
});
