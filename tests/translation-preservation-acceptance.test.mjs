import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTranslationContent } from '../src/lib/translation-preservation.ts';
import { acceptTranslationBoundary } from '../src/lib/translation-invariants.ts';
import { usableAutomaticTranslation, automaticTranslationCueWrites } from '../src/lib/caption-translation-commit.ts';

function accept(source, text) {
  return acceptTranslationBoundary([{ id: 'cue', text: source }], [{ id: 'cue', text }]);
}

for (const [label, source, output] of [
  ['URL query', 'Read https://example.test/a?x=2', 'Lisez https://example.test/a?x=3'],
  ['backtick code', 'Run \u0060user_id=42\u0060 now', 'Ex\u00e9cutez \u0060user_id=43\u0060'],
  ['emoji skin and ZWJ', 'Hello \ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb', 'Bonjour \ud83d\udc69\u200d\ud83d\udcbb'],
  ['flag', 'Hello \ud83c\uddfa\ud83c\uddf8', 'Bonjour \ud83c\uddec\ud83c\udde7'],
  ['keycap', 'Hello 1\ufe0f\u20e3', 'Bonjour 1'],
  ['variation selector', 'Hello \u2764\ufe0f', 'Bonjour \u2764'],
  ['explicit break', 'First\nSecond', 'Premier Deuxi\u00e8me'],
]) {
  test(label + ' loss is rejected before accepted batch persistence', () => {
    const result = accept(source, output);
    assert.equal(result.rejected.has('cue'), true);
    assert.equal(result.translations.get('cue'), '');
  });
}

test('opaque decomposed URL survives acceptance byte for byte', () => {
  const source = 'Read https://example.test/cafe\u0301';
  const text = 'Lisez https://example.test/cafe\u0301';
  const result = accept(source, text);
  assert.equal(result.rejected.size, 0);
  assert.equal(result.translations.get('cue'), text);
});

test('opaque code identifier survives acceptance byte for byte', () => {
  const source = 'Run \u0060cafe\u0301_id=42\u0060';
  const text = 'Ex\u00e9cutez \u0060cafe\u0301_id=42\u0060';
  assert.equal(accept(source, text).translations.get('cue'), text);
});

test('opaque URL must also survive the existing durable write caller', () => {
  const source = 'Read https://example.test/cafe\u0301';
  const text = 'Lisez https://example.test/cafe\u0301';
  assert.equal(usableAutomaticTranslation(source, text, false, 'fr'), text);
});

test('locale punctuation, decimal grouping, digits, CRLF, and ordinary names are accepted', () => {
  for (const [source, text] of [
    ['Okay.', 'OK!'],
    ['She said "hello".', 'Elle a dit \u00ab bonjour \u00bb.'],
    ['Pay 1,234.50 USD', 'Payez 1\u202f234,50 USD'],
    ['Buy 12 items', 'Achetez \u0661\u0662 articles'],
    ['Hello\r\nWorld', 'Bonjour\nMonde'],
    ['Meet OK Go', 'Rencontrez OK Go'],
  ]) assert.equal(accept(source,text).rejected.size, 0, text);
});

test('rejected protected content leaves saved text stale and empty text unresolved', () => {
  const captions = [{ id: 'saved', text: 'Hello \ud83d\udc4b' }, { id: 'empty', text: 'Hello \ud83d\udc4b' }];
  const result = acceptTranslationBoundary(captions, captions.map(c => ({ id: c.id, text: 'Bonjour' })));
  assert.deepEqual(automaticTranslationCueWrites({
    captions, translatedById: result.translations, needsReviewById: result.rejected,
    previousById: new Map([['saved', 'Salut \ud83d\udc4b']]), targetLanguage: 'fr',
  }), [{ sourceCaptionId: 'saved', translatedText: 'Salut \ud83d\udc4b', translationStatus: 'stale' }]);
});

test('strict ID set and explicit native invalid remain authoritative', () => {
  assert.throws(() => acceptTranslationBoundary([{ id:'cue',text:'Hello' }], [{ id:'other',text:'Bonjour' }]));
  const result = acceptTranslationBoundary([{ id:'cue',text:'Hello' }], [{ id:'cue',text:'Bonjour',valid:false }]);
  assert.equal(result.rejected.has('cue'),true);
});

test('shared protected composition passes quality and durable writes without exempting prose', async () => {
  const { readFile } = await import('node:fs/promises');
  const { isLikelyUntranslatedCaption } = await import('../src/lib/caption-languages.ts');
  const cases = JSON.parse(await readFile(new URL('../modules/caption-translation/android/src/test/resources/translation-protected-composition.json', import.meta.url), 'utf8'));
  for (const item of cases) {
    for (const target of item.targets ?? ['pl', 'zh-Hans', 'ar', 'ja']) {
      assert.equal(isLikelyUntranslatedCaption(item.source, item.translated, target), item.review,
        item.name + ': ' + target);
      assert.equal(usableAutomaticTranslation(item.source, item.translated, false, target),
        item.review ? undefined : normalizeTranslationContent(item.translated), item.name + ': durable ' + target);
    }
  }
});

test('exact Samsung composition writes under its requested ID; native invalid stays authoritative', () => {
  const source = 'ok https://example.com/ \u0060src/app.ts\u0060 \ud83d\ude00';
  const captions = [{ id: 'samsung-cue', text: source }];
  const result = acceptTranslationBoundary(captions, [{ id: 'samsung-cue', text: source, valid: true }]);
  assert.deepEqual(automaticTranslationCueWrites({
    captions, translatedById: result.translations, needsReviewById: result.rejected,
    previousById: new Map(), targetLanguage: 'pl',
  }), [{ sourceCaptionId: 'samsung-cue', translatedText: source, translationStatus: 'translated' }]);
  assert.equal(usableAutomaticTranslation(source, source, true, 'pl'), undefined);
});

test('protected data neither contaminates nor supplies translated prose script', async () => {
  const { readFile } = await import('node:fs/promises');
  const { isLikelyUntranslatedCaption } = await import('../src/lib/caption-languages.ts');
  const cases = JSON.parse(await readFile(new URL('../modules/caption-translation/android/src/test/resources/translation-protected-composition.json', import.meta.url), 'utf8'));
  for (const item of cases.filter(item => item.scriptFixture)) {
    for (const target of item.targets) {
      assert.equal(isLikelyUntranslatedCaption(item.source, item.translated, target), item.review, item.name);
      assert.equal(usableAutomaticTranslation(item.source, item.translated, false, target),
        item.review ? undefined : normalizeTranslationContent(item.translated), item.name + ': durable');
    }
  }
});
