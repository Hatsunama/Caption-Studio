import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TOP_SPOKEN_CAPTION_LANGUAGES,
  automaticTranslationTargetTags,
  canAutomaticallyTranslatePair,
  captionGroupingProfile,
  captionLanguageLabel,
  dualCaptionLanguageChoices,
  resolveCaptionLanguage,
  supportsAutomaticCaptionTranslation,
} from '../src/lib/caption-languages.ts';

const supported = ['en', 'zh-Hans', 'zh-Hant', 'hi', 'es', 'fr', 'ar', 'bn', 'pt', 'ru',
  'id', 'de', 'ja', 'ko', 'tr', 'vi', 'th', 'it', 'pl'];

test('selectable catalog contains exactly the retained languages without Urdu', () => {
  assert.deepEqual(TOP_SPOKEN_CAPTION_LANGUAGES.map(({ tag }) => tag), supported);
  for (const source of supported) {
    assert.ok(!automaticTranslationTargetTags(source).includes('ur'));
    assert.ok(!dualCaptionLanguageChoices(source).some(({ tag }) => tag === 'ur'));
  }
});

test('Urdu and regional aliases cannot resolve or translate in either direction', () => {
  for (const tag of ['ur', 'ur-PK', 'ur-IN', ' UR ']) {
    assert.equal(resolveCaptionLanguage(tag), undefined, tag);
    assert.equal(supportsAutomaticCaptionTranslation(tag), false, tag);
    assert.throws(() => automaticTranslationTargetTags(tag), /unknown source language/);
    for (const other of supported) {
      assert.equal(canAutomaticallyTranslatePair(tag, other), false, `${tag} -> ${other}`);
      assert.equal(canAutomaticallyTranslatePair(other, tag), false, `${other} -> ${tag}`);
    }
    assert.ok(dualCaptionLanguageChoices(tag).every(({ automatic }) => !automatic));
  }
});

test('retained language pairs still translate and legacy Urdu keeps Arabic grouping', () => {
  for (const source of supported) {
    assert.equal(supportsAutomaticCaptionTranslation(source), true);
    for (const target of supported) {
      const differentFamily = resolveCaptionLanguage(source).family !== resolveCaptionLanguage(target).family;
      assert.equal(canAutomaticallyTranslatePair(source, target), differentFamily);
    }
  }
  for (const legacy of ['ur', 'ur-PK', 'ur-IN']) {
    assert.equal(captionGroupingProfile(legacy), 'arabic');
    assert.equal(captionLanguageLabel(legacy), legacy);
  }
  assert.equal(captionLanguageLabel('ar'), 'Arabic');
});
