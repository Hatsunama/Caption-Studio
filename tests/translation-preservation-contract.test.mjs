import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeTranslationContent, preservesTranslationContent } from '../src/lib/translation-preservation.ts';
import { acceptTranslationBoundary } from '../src/lib/translation-invariants.ts';
import { automaticTranslationCueWrites, usableAutomaticTranslation } from '../src/lib/caption-translation-commit.ts';
import { commitTranslationAttempt } from '../src/lib/translation-attempt.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { createTranslationCaptionTrack, resolveCaptionPairs } from '../src/lib/caption-tracks.ts';
import { decodePersistedProject } from '../src/lib/project-codec.ts';
import { serializeProjectSnapshot } from '../src/lib/project-schema.ts';

const corpus = JSON.parse(await readFile(new URL('../modules/caption-translation/android/src/test/resources/translation-preservation-contract.json', import.meta.url), 'utf8'));
for (const item of corpus) test('shared preservation: ' + item.name, () => {
  assert.equal(preservesTranslationContent(item.source, item.translated), item.preserved);
});

test('prose NFC continues while code and URL interiors remain raw', () => {
  const text = '  cafe\u0301 \u0060cafe\u0301_id=42\u0060 https://example.test/cafe\u0301  ';
  assert.equal(normalizeTranslationContent(text), 'caf\u00e9 \u0060cafe\u0301_id=42\u0060 https://example.test/cafe\u0301');
});

test('localized integer-only cues pass the full automatic-write screen', () => {
  for (const target of ['fr', 'en', 'zh-Hans', 'ar']) {
    assert.equal(usableAutomaticTranslation('42', '\u0664\u0662', false, target), '\u0664\u0662');
    assert.equal(usableAutomaticTranslation('42', '\u0664\u0663', false, target), undefined);
  }
});

function fixture() {
  const project = createCaptionProject({ id: 'preservation-project', name: 'Preservation', sources: [{
    id: 'v1', uri: 'file:///video.mp4', storageMode: 'copied', displayName: 'video.mp4',
    durationMs: 6000, width: 1080, height: 1920, rotation: 0, frameRate: 30,
  }] });
  project.transcription.language = 'en';
  project.captions = [
    '\nRead https://example.test/cafe\u0301\n',
    'Hello \ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb',
    'Run \u0060cafe\u0301_id=42\u0060',
  ].map((text, i) => ({ id: 'c' + (i + 1), text, startMs: i * 1500, endMs: (i + 1) * 1500, wordIds: [] }));
  return createTranslationCaptionTrack(project, { id: 'translation-fr', languageTag: 'fr', displayName: 'French' });
}
function apply(project, captions, actual, previous = new Map()) {
  const boundary = acceptTranslationBoundary(captions, actual);
  const writes = automaticTranslationCueWrites({ captions, translatedById: boundary.translations,
    needsReviewById: boundary.rejected, previousById: previous, targetLanguage: 'fr' });
  return commitTranslationAttempt(project, 'translation-fr', captions, writes);
}
const pairs = project => resolveCaptionPairs(project, 'translation-fr');

test('accepted partial batch stays exact through automatic project commit and reopen', () => {
  const project = fixture();
  const text = '\nLisez https://example.test/cafe\u0301\n';
  const next = apply(project, [project.captions[0]], [{ id: 'c1', text }]);
  const restored = decodePersistedProject(serializeProjectSnapshot(next));
  assert.equal(pairs(restored)[0].translation.text, text);
  assert.equal(pairs(restored)[0].translation.status, 'translated');
  assert.equal(pairs(restored)[1].translation.status, 'pending');
  assert.equal(pairs(restored)[2].translation.status, 'pending');
});

test('later rejected batch keeps earlier durable text and raw saved edits; retry fills only attempted cues', () => {
  let project = fixture();
  const firstText = '\nLisez https://example.test/cafe\u0301\n';
  project = apply(project, [project.captions[0]], [{ id: 'c1', text: firstText }]);
  const old = '\n Ancien \u0060cafe\u0301_id=42\u0060 \n';
  project.captionTracks.translations[0].cues[1].text = old;
  project.captionTracks.translations[0].cues[1].status = 'reviewed';
  const captions = project.captions.slice(1);
  const failed = apply(project, captions, [{ id: 'c2', text: 'Bonjour' }, { id: 'c3', text: 'Ex\u00e9cutez \u0060caf\u00e9_id=42\u0060' }], new Map([['c2', old]]));
  assert.equal(pairs(failed)[0].translation.text, firstText);
  assert.equal(pairs(failed)[1].translation.text, old);
  assert.equal(pairs(failed)[1].translation.status, 'failed');
  assert.equal(pairs(failed)[2].translation.text, '');
  assert.equal(pairs(failed)[2].translation.status, 'failed');
  assert.equal(pairs(failed)[2].displayProvenance, 'source-fallback');
  const writes = automaticTranslationCueWrites({ captions, translatedById: new Map(),
    previousById: new Map([['c2', old]]), targetLanguage: 'fr' });
  assert.equal(writes[0].translatedText, old);
  assert.equal(writes[0].translationStatus, 'stale');
  const retry = apply(failed, captions, [
    { id: 'c2', text: 'Bonjour \ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb' },
    { id: 'c3', text: 'Ex\u00e9cutez \u0060cafe\u0301_id=42\u0060' },
  ]);
  const restored = decodePersistedProject(serializeProjectSnapshot(retry));
  assert.equal(pairs(restored)[0].translation.text, firstText);
  assert.equal(pairs(restored)[1].translation.status, 'translated');
  assert.equal(pairs(restored)[2].translation.text, 'Ex\u00e9cutez \u0060cafe\u0301_id=42\u0060');
});

test('strict ID errors cannot produce a partial accepted map', () => {
  assert.throws(() => acceptTranslationBoundary([{ id: 'a', text: 'Hello' }, { id: 'b', text: 'World' }],
    [{ id: 'a', text: 'Bonjour' }, { id: 'a', text: 'Monde' }]));
});

test('Seeker standalone operator loss cannot reach boundary acceptance or automatic writes', () => {
  const source = '42 https://example.com/\n\n\u0060src/app.ts\u0060 + is ready.';
  const good = '42 https://example.com/\n\n\u0060src/app.ts\u0060 + 已准备好。';
  const dropped = good.replace(' +', '');
  const captions = [{ id: 'seeker', text: source }];
  const rejected = acceptTranslationBoundary(captions, [{ id: 'seeker', text: dropped, valid: true }]);
  assert.equal(rejected.rejected.has('seeker'), true);
  assert.equal(rejected.translations.get('seeker'), '');
  assert.equal(usableAutomaticTranslation(source, dropped, false, 'zh-Hans'), undefined);
  assert.deepEqual(automaticTranslationCueWrites({ captions, translatedById: rejected.translations,
    needsReviewById: rejected.rejected, previousById: new Map(), targetLanguage: 'zh-Hans' }), []);
  const accepted = acceptTranslationBoundary(captions, [{ id: 'seeker', text: good, valid: true }]);
  assert.equal(accepted.rejected.size, 0);
  assert.equal(usableAutomaticTranslation(source, good, false, 'zh-Hans'), good);
  assert.equal(usableAutomaticTranslation(source, source, false, 'zh-Hans'), undefined);
});

test('standalone operator lexer masks only tokens and keeps ordinary prose translatable', async () => {
  const { translationProse, isInvariantCompositionTranslation } = await import('../src/lib/translation-preservation.ts');
  assert.equal(translationProse('Ready + now'), 'Ready   now');
  assert.equal(translationProse('well-known x+y C++'), 'well-known x+y C++');
  assert.equal(isInvariantCompositionTranslation('Ready + now', 'Ready + now'), false);
});

for (const [source, translated] of [
  ['Ready + now', '现在+已就绪'],
  ['42 https://example.com/\n\n\u0060src/app.ts\u0060 + is ready.',
    '42 https://example.com/\n\n\u0060src/app.ts\u0060+已准备好。'],
]) {
  test('unspaced target plus passes real JS boundary: ' + source, () => {
    const boundary = acceptTranslationBoundary([{ id: 'cue', text: source }],
      [{ id: 'cue', text: translated, valid: true }]);
    assert.equal(boundary.rejected.size, 0);
    assert.equal(boundary.translations.get('cue'), translated);
  });
  test('unspaced target plus passes real automatic write: ' + source, () => {
    assert.equal(usableAutomaticTranslation(source, translated, false, 'zh-Hans'), translated);
    assert.deepEqual(automaticTranslationCueWrites({
      captions: [{ id: 'cue', text: source }], translatedById: new Map([['cue', translated]]),
      previousById: new Map(), targetLanguage: 'zh-Hans',
    }), [{ sourceCaptionId: 'cue', translatedText: translated, translationStatus: 'translated' }]);
  });
}
