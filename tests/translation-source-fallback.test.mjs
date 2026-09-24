import assert from 'node:assert/strict';
import test from 'node:test';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { createEnglishChineseCaptionTrack, resolveCaptionPairs, updatePairedCaptionText, setTranslationCueSkipped } from '../src/lib/caption-tracks.ts';
import { commitTranslationAttempt } from '../src/lib/translation-attempt.ts';
import { exportCaptionPairs, exportTranslationSummary } from '../src/lib/export-caption-pairs.ts';
import { buildTimelineRenderPlan } from '../src/lib/export-render-plan.ts';
import { serializeSrt, serializeAss } from '../src/lib/subtitle-export.ts';
import { dualCaptionDraftsFromPairs, mergeRecoveredDualCaptionDrafts, shouldRestoreDualCaptionJournal } from '../src/lib/dual-caption-drafts.ts';
import { usableAutomaticTranslation } from '../src/lib/caption-translation-commit.ts';
import { decodePersistedProject } from '../src/lib/project-codec.ts';
import { serializeProjectSnapshot } from '../src/lib/project-schema.ts';

function fixture() {
  const project = createCaptionProject({ id: 'p1', name: 'Fallback', sources: [{
    id: 'v1', uri: 'file:///video.mp4', storageMode: 'copied', displayName: 'video.mp4',
    durationMs: 6000, width: 1080, height: 1920, rotation: 0, frameRate: 30,
  }] });
  project.transcription.language = 'en';
  project.captions = ['Hello world', 'See you later'].map((text, i) => ({
    id: `c${i + 1}`, text, startMs: i * 1500, endMs: (i + 1) * 1500, wordIds: [],
  }));
  return createEnglishChineseCaptionTrack(project, { c1: '\u4f60\u597d' });
}
const trackId = 'translation-zh-Hans';
const fail = (p) => commitTranslationAttempt(p, trackId, p.captions, []);

test('failed display prefers saved translation, otherwise derives current source without persisting it', () => {
  let p = fail(fixture());
  let pairs = resolveCaptionPairs(p, trackId);
  assert.equal(pairs[0].displayText, '\u4f60\u597d');
  assert.equal(pairs[0].displayProvenance, 'translation');
  assert.equal(pairs[1].displayText, 'See you later');
  assert.equal(pairs[1].displayProvenance, 'source-fallback');
  assert.equal(pairs[1].translation.text, '');
  assert.equal(pairs[1].translation.status, 'failed');
  assert.equal(dualCaptionDraftsFromPairs(pairs).c2.translatedText, '');
  p = updatePairedCaptionText(p, { trackId, sourceCaptionId: 'c2', primaryText: 'Next time' });
  p = decodePersistedProject(serializeProjectSnapshot(p));
  pairs = resolveCaptionPairs(p, trackId);
  assert.equal(pairs[1].displayText, 'Next time');
  assert.equal(pairs[1].translation.text, '');
  assert.equal(pairs[1].translation.status, 'failed');
});

test('fallback remains unresolved and requires consent for all export formats', () => {
  const p = fail(fixture());
  const before = JSON.stringify(p);
  assert.deepEqual(exportTranslationSummary(p), { missing: 1, needsReview: 1 });
  for (const run of [exportCaptionPairs, serializeSrt, serializeAss, buildTimelineRenderPlan]) {
    assert.throws(() => run(p), /Export anyway/);
  }
  assert.equal(exportCaptionPairs(p, true).length, 2);
  assert.match(serializeSrt(p, true), /See you later\nSee you later/);
  assert.equal((serializeAss(p, true).match(/See you later/g) ?? []).length, 2);
  assert.equal(buildTimelineRenderPlan(p, undefined, true).captions.find(c => c.id === `${trackId}:c2`).text, 'See you later');
  assert.equal(JSON.stringify(p), before);
  const skipped = setTranslationCueSkipped(p, trackId, 'c2', true);
  assert.equal(exportCaptionPairs(skipped, true).length, 1);
  assert.deepEqual(exportTranslationSummary(skipped), { missing: 0, needsReview: 1 });
});

test('commit boundary rejects sentence echoes while preserving earlier translations', () => {
  const p = fixture();
  const next = commitTranslationAttempt(p, trackId, p.captions, p.captions.map(c => ({
    sourceCaptionId: c.id, translatedText: c.text, translationStatus: 'translated',
  })));
  const pairs = resolveCaptionPairs(next, trackId);
  assert.equal(pairs[0].translation.text, '\u4f60\u597d');
  assert.equal(pairs[0].translation.status, 'failed');
  assert.equal(pairs[1].translation.text, '');
  assert.equal(pairs[1].displayProvenance, 'source-fallback');
});

test('a successful retry replaces only the derived fallback', () => {
  const p = fail(fixture());
  const next = commitTranslationAttempt(p, trackId, [p.captions[1]], [{
    sourceCaptionId: 'c2', translatedText: '\u518d\u89c1', translationStatus: 'translated',
  }]);
  const pair = resolveCaptionPairs(next, trackId)[1];
  assert.equal(pair.displayText, '\u518d\u89c1');
  assert.equal(pair.displayProvenance, 'translation');
  assert.equal(pair.translation.status, 'translated');
  assert.equal(pair.translation.failureReason, undefined);
});

test('safe invariant tokens pass through, arbitrary echoed sentences do not', () => {
  for (const token of ['42', 'https://example.test', 'OK']) {
    assert.equal(usableAutomaticTranslation(token, token, false, 'zh-Hans'), token);
    assert.equal(usableAutomaticTranslation(token, token, true, 'zh-Hans'), undefined);
  }
  for (const target of ['zh-Hans', 'fr', 'ja']) {
    assert.equal(usableAutomaticTranslation('Hello world', 'Hello world', false, target), undefined);
  }
});

test('recovery never replaces a committed translation with a source echo after a primary edit', () => {
  const committed = { c1: { primaryText: 'Hello world', translatedText: '\u4f60\u597d' } };
  const recovered = { c1: { primaryText: 'Edited greeting', translatedText: 'Hello world' } };
  assert.deepEqual(mergeRecoveredDualCaptionDrafts(recovered, committed), {
    c1: { primaryText: 'Edited greeting', translatedText: '\u4f60\u597d' },
  });
  assert.equal(shouldRestoreDualCaptionJournal(recovered, committed), true);
});
