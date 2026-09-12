import assert from 'node:assert/strict';
import test from 'node:test';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { decodeVersionTwoProject } from '../src/lib/project-schema.ts';
import { commitTranslationAttempt, translationAttemptMessage } from '../src/lib/translation-attempt.ts';
import {
  createTranslationCaptionTrack,
  synchronizeCaptionTracks,
  updatePairedCaptionText,
  updatePairedCaptionTexts,
} from '../src/lib/caption-tracks.ts';
import {
  isProjectIdentifier,
  isTranslationCueIdentifier,
  TRANSLATION_CUE_IDENTIFIER_MAX_LENGTH,
} from '../src/lib/project-identifiers.ts';

function projectWithCaptionId(id) {
  const project = createCaptionProject({
    id: 'translation-identifier-regression', name: 'Identifier regression',
    sources: [{ id: 'source-1', uri: 'content://media/video/1', storageMode: 'linked',
      displayName: 'clip.mp4', durationMs: 4000, width: 1080, height: 1920, rotation: 0 }],
  });
  return {
    ...project,
    transcription: { ...project.transcription, language: 'en' },
    captions: [{ id, text: 'Hello world', startMs: 500, endMs: 1900,
      wordIds: [], textMode: 'manual', timelineVisible: true }],
  };
}

function projectWithOverlappingPairIds() {
  const project = projectWithCaptionId('part:cue');
  project.captions.push({ ...project.captions[0], id: 'cue', text: 'See you later', startMs: 2000, endMs: 3000 });
  const spanish = createTranslationCaptionTrack(project, {
    id: 'translation', languageTag: 'es', displayName: 'Spanish',
    translations: { 'part:cue': 'Hola mundo', cue: 'Hasta luego' },
  });
  const french = createTranslationCaptionTrack(spanish, {
    id: 'translation:part', languageTag: 'fr', displayName: 'French',
    translations: { 'part:cue': 'Bonjour le monde', cue: 'Au revoir' },
  });
  return decodeVersionTwoProject(JSON.parse(JSON.stringify(french)));
}

test('a translated edit only changes its exact track and source pair, including after reload', () => {
  const project = projectWithOverlappingPairIds();
  const before = JSON.stringify(project);
  const changed = updatePairedCaptionText(project, {
    trackId: 'translation', sourceCaptionId: 'part:cue',
    translatedText: 'Hola a todos', translationStatus: 'reviewed',
  });
  const reopened = decodeVersionTwoProject(JSON.parse(JSON.stringify(changed)));
  assert.equal(reopened.captionTracks.translations[0].cues[0].text, 'Hola a todos');
  assert.equal(reopened.captionTracks.translations[0].cues[0].status, 'reviewed');
  assert.deepEqual(reopened.captionTracks.translations[1], project.captionTracks.translations[1]);
  assert.deepEqual(reopened.captionTracks.translations[0].cues[1], project.captionTracks.translations[0].cues[1]);
  assert.deepEqual(reopened.captions, project.captions);
  assert.equal(JSON.stringify(project), before);
});

test('batch edits distinguish colon-containing pairs while still rejecting real duplicates', () => {
  const project = projectWithOverlappingPairIds();
  const updates = [
    { trackId: 'translation', sourceCaptionId: 'part:cue', translatedText: 'Hola a todos', translationStatus: 'reviewed' },
    { trackId: 'translation:part', sourceCaptionId: 'cue', translatedText: 'À bientôt', translationStatus: 'translated' },
  ];
  const changed = updatePairedCaptionTexts(project, updates);
  assert.equal(changed.captionTracks.translations[0].cues[0].text, 'Hola a todos');
  assert.equal(changed.captionTracks.translations[0].cues[0].status, 'reviewed');
  assert.equal(changed.captionTracks.translations[1].cues[1].text, 'À bientôt');
  assert.equal(changed.captionTracks.translations[1].cues[1].status, 'translated');
  assert.deepEqual(changed.captionTracks.translations[0].cues[1], project.captionTracks.translations[0].cues[1]);
  assert.deepEqual(changed.captionTracks.translations[1].cues[0], project.captionTracks.translations[1].cues[0]);
  assert.throws(() => updatePairedCaptionTexts(project, [updates[0], updates[0]]), /more than one update/);
});

test('partial automatic translation commits keep success and failure ownership within the requested track', () => {
  const project = projectWithOverlappingPairIds();
  const changed = commitTranslationAttempt(project, 'translation', project.captions, [
    { sourceCaptionId: 'part:cue', translatedText: 'Hola a todos', translationStatus: 'translated' },
  ]);
  assert.equal(changed.captionTracks.translations[0].cues[0].text, 'Hola a todos');
  assert.equal(changed.captionTracks.translations[0].cues[1].text, 'Hasta luego');
  assert.equal(changed.captionTracks.translations[0].cues[1].status, 'failed');
  assert.deepEqual(changed.captionTracks.translations[1], project.captionTracks.translations[1]);
  assert.match(translationAttemptMessage(changed, 'translation', ['part:cue', 'cue']), /^1 subtitles/);
  assert.equal(translationAttemptMessage(changed, 'translation:part', ['part:cue', 'cue']), undefined);
});

test('long saved caption IDs can create language tracks and retain translations after reopen', () => {
  for (const length of [110, 127, 128, 200, 255, 256]) {
    const captionId = 'caption-'.padEnd(length, 'x');
    const project = decodeVersionTwoProject(JSON.parse(JSON.stringify(projectWithCaptionId(captionId))));
    for (const languageTag of ['zh-Hans', 'zh-Hant', 'es', 'fr', 'de', 'ja', 'hi', 'ar']) {
      const trackId = `translation-${languageTag}`;
      const bilingual = createTranslationCaptionTrack(project, {
        id: trackId, languageTag, displayName: languageTag,
      });
      const translated = updatePairedCaptionText(bilingual, {
        trackId, sourceCaptionId: captionId, translatedText: 'Translated text',
      });
      const reopened = decodeVersionTwoProject(JSON.parse(JSON.stringify(translated)));
      const cue = reopened.captionTracks.translations[0].cues[0];
      assert.equal(cue.id, `${trackId}:${captionId}`);
      assert.equal(cue.sourceCaptionId, captionId);
      assert.equal(cue.text, 'Translated text');
      assert.deepEqual(reopened.captions, project.captions);
      assert.deepEqual(synchronizeCaptionTracks(reopened), reopened.captionTracks);
    }
  }
});

test('maximum-length track and caption components produce a bounded persistent cue', () => {
  const captionId = 'c'.repeat(256);
  const trackId = 't'.repeat(256);
  const translated = createTranslationCaptionTrack(projectWithCaptionId(captionId), {
    id: trackId, languageTag: 'es', displayName: 'Spanish',
  });
  const reopened = decodeVersionTwoProject(JSON.parse(JSON.stringify(translated)));
  assert.equal(reopened.captionTracks.translations[0].cues[0].id.length, TRANSLATION_CUE_IDENTIFIER_MAX_LENGTH);
  // Hydration of a missing cue uses exactly the same identifier contract.
  translated.captionTracks.translations[0].cues = [];
  const hydrated = decodeVersionTwoProject(JSON.parse(JSON.stringify(translated)));
  assert.deepEqual(JSON.parse(JSON.stringify(hydrated)), JSON.parse(JSON.stringify(reopened)));
});

test('identifier validation still rejects invalid characters and overlong components', () => {
  for (const value of ['', '_leading', 'contains space', 'path/segment', 'bad\n', null, 42]) {
    assert.equal(isProjectIdentifier(value), false);
    assert.equal(isTranslationCueIdentifier(value), false);
  }
  assert.equal(isProjectIdentifier('a'.repeat(257)), false);
  assert.equal(isTranslationCueIdentifier('a'.repeat(514)), false);
  assert.throws(() => createTranslationCaptionTrack(projectWithCaptionId('c'.repeat(257)), {
    id: 'translation-es', languageTag: 'es', displayName: 'Spanish',
  }), /Primary caption identifier is invalid/);
});
