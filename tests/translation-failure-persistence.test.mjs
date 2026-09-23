import assert from 'node:assert/strict';
import test from 'node:test';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { createEnglishChineseCaptionTrack, resolveCaptionPairs, updatePairedCaptionText } from '../src/lib/caption-tracks.ts';
import { commitTranslationAttempt, translationAttemptMessage } from '../src/lib/translation-attempt.ts';
import { decodePersistedProject } from '../src/lib/project-codec.ts';
import { serializeProjectSnapshot } from '../src/lib/project-schema.ts';

function fixture() {
  const project = createCaptionProject({ id: 'p1', name: 'Failure persistence', sources: [{
    id: 'video1', uri: 'file:///video.mp4', storageMode: 'copied', displayName: 'video.mp4',
    durationMs: 6000, width: 1080, height: 1920, rotation: 0, frameRate: 30,
  }] });
  project.transcription.language = 'en';
  project.captions = ['Hello', 'Earlier', 'Later'].map((text, index) => ({
    id: `c${index + 1}`, text, startMs: index * 1500, endMs: (index + 1) * 1500,
    wordIds: [], textMode: 'manual', timingMode: 'timeline',
  }));
  return createEnglishChineseCaptionTrack(project, { c1: '\u4f60\u597d', c2: '\u4ee5\u524d' });
}

const success = (id, text) => ({ sourceCaptionId: id, translatedText: text, translationStatus: 'translated' });

test('mixed results persist reasons and retain saved text without source fallback', () => {
  const original = fixture();
  const trackId = original.captionTracks.translations[0].id;
  const next = commitTranslationAttempt(original, trackId, original.captions,
    [success('c1', '\u60a8\u597d')], new Map([['c2', 'native-timeout'], ['c3', 'output-needs-review']]));
  const restored = decodePersistedProject(serializeProjectSnapshot(next));
  const cues = restored.captionTracks.translations[0].cues;
  assert.equal(cues[0].status, 'translated');
  assert.equal(cues[0].text, '\u60a8\u597d');
  assert.equal(cues[1].status, 'failed');
  assert.equal(cues[1].text, '\u4ee5\u524d');
  assert.equal(cues[1].failureReason, 'native-timeout');
  assert.equal(cues[2].status, 'failed');
  assert.equal(cues[2].text, '');
  assert.equal(cues[2].failureReason, 'output-needs-review');
  assert.match(translationAttemptMessage(restored, trackId, ['c2', 'c3']), /2 subtitle translation attempts failed/);
  assert.equal(original.captionTracks.translations[0].cues[2].status, 'pending');
});

test('individual, selected and unfinished retries preserve successes outside the request', () => {
  const original = fixture();
  const trackId = original.captionTracks.translations[0].id;
  const failed = commitTranslationAttempt(original, trackId, original.captions.slice(1), []);
  for (const ids of [['c2'], ['c2', 'c3'], resolveCaptionPairs(failed, trackId)
    .filter((pair) => pair.translation.status === 'failed').map((pair) => pair.source.id)]) {
    const captions = failed.captions.filter((caption) => ids.includes(caption.id));
    const next = commitTranslationAttempt(failed, trackId, captions, [success('c2', '\u65e9\u4e9b')]);
    assert.deepEqual(next.captionTracks.translations[0].cues[0], failed.captionTracks.translations[0].cues[0]);
    assert.equal(next.captionTracks.translations[0].cues[1].status, 'translated');
    assert.equal(next.captionTracks.translations[0].cues[1].failureReason, undefined);
    assert.equal(next.captionTracks.translations[0].cues[2].status, 'failed');
    assert.equal(next.captionTracks.translations[0].cues[2].text, '');
  }
});

test('source edits keep failures visible and manual translation edits clear their reasons', () => {
  const original = fixture();
  const trackId = original.captionTracks.translations[0].id;
  const failed = commitTranslationAttempt(original, trackId, original.captions, [], new Map([['c3', 'native-timeout']]));
  const edited = updatePairedCaptionText(failed, { trackId, sourceCaptionId: 'c3', primaryText: 'Next time' });
  const cue = resolveCaptionPairs(edited, trackId)[2].translation;
  assert.equal(cue.status, 'failed');
  assert.equal(cue.failureReason, 'native-timeout');
  const manual = updatePairedCaptionText(edited, {
    trackId, sourceCaptionId: 'c3', translatedText: '\u4e0b\u6b21', translationStatus: 'reviewed',
  });
  assert.equal(manual.captionTracks.translations[0].cues[2].failureReason, undefined);
  assert.equal(manual.captionTracks.translations[0].cues[2].status, 'reviewed');
});

test('legacy failures and malformed reason metadata remain failed on reload', () => {
  const original = fixture();
  const trackId = original.captionTracks.translations[0].id;
  const failed = commitTranslationAttempt(original, trackId, original.captions, []);
  const cues = failed.captionTracks.translations[0].cues;
  delete cues[0].failureReason;
  cues[1].failureReason = { unexpected: true };
  cues[2].failureReason = 'x'.repeat(2000);
  const restored = decodePersistedProject(JSON.stringify(failed)).captionTracks.translations[0].cues;
  assert.ok(restored.every((cue) => cue.status === 'failed'));
  assert.equal(restored[0].failureReason, undefined);
  assert.equal(restored[1].failureReason, undefined);
  assert.equal(restored[2].failureReason.length, 1024);
});
