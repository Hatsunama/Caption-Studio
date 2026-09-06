import assert from 'node:assert/strict';
import test from 'node:test';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { createEnglishChineseCaptionTrack, resolveCaptionPairs, setTranslationCueSkipped, setTranslationCueTiming, updatePairedCaptionText } from '../src/lib/caption-tracks.ts';
import { decodeVersionTwoProject } from '../src/lib/project-schema.ts';
import { exportCaptionPairs, exportTranslationSummary } from '../src/lib/export-caption-pairs.ts';
import { buildTimelineRenderPlan } from '../src/lib/export-render-plan.ts';
import { serializeSrt, serializeAss } from '../src/lib/subtitle-export.ts';
import { usableAutomaticTranslation } from '../src/lib/caption-translation-commit.ts';

function fixture() {
  const project = createCaptionProject({ id: 'p1', name: 'Translation choices', sources: [{
    id: 'video1', uri: 'file:///video.mp4', storageMode: 'copied', displayName: 'video.mp4',
    durationMs: 6000, width: 1080, height: 1920, rotation: 0, frameRate: 30,
  }] });
  project.transcription.language = 'en';
  project.captions = ['Hello', 'Earlier', 'Okay'].map((text, index) => ({
    id: `c${index + 1}`, text, startMs: index * 1500, endMs: (index + 1) * 1500, wordIds: [],
  }));
  return createEnglishChineseCaptionTrack(project, { c1: '\u4f60\u597d' });
}

test('missing and review counts describe the actual exported lines; consent never modifies a project', () => {
  const project = fixture();
  const cue = project.captionTracks.translations[0].cues[1];
  cue.text = '\u4ee5\u524d'; cue.status = 'failed';
  const before = JSON.stringify(project);
  assert.deepEqual(exportTranslationSummary(project), { missing: 1, needsReview: 1 });
  assert.throws(() => exportCaptionPairs(project), /Export anyway/);
  assert.equal(exportCaptionPairs(project, true).length, 2);
  assert.equal(buildTimelineRenderPlan(project, undefined, true).captions.length, 5);
  assert.match(serializeSrt(project, true), /\u4f60\u597d/);
  assert.match(serializeAss(project, true), /\u4ee5\u524d/);
  assert.equal(JSON.stringify(project), before);
});

test('skipping is reversible, survives persistence and timing edits, and retains both texts', () => {
  const original = fixture();
  const trackId = original.captionTracks.translations[0].id;
  const skipped = setTranslationCueSkipped(original, trackId, 'c1', true);
  const retimed = setTranslationCueTiming(skipped, trackId, 'c1', 'move', 500, 2000);
  const restored = decodeVersionTwoProject(JSON.parse(JSON.stringify(retimed)));
  assert.equal(resolveCaptionPairs(restored, trackId)[0].timelineVisible, false);
  assert.equal(restored.captionTracks.translations[0].cues[0].text, '\u4f60\u597d');
  assert.equal(restored.captions[0].text, 'Hello');
  assert.doesNotMatch(serializeSrt(restored, true), /\u4f60\u597d/);
  const included = setTranslationCueSkipped(restored, trackId, 'c1', false);
  assert.equal(resolveCaptionPairs(included, trackId)[0].timelineVisible, true);
  assert.equal(resolveCaptionPairs(included, trackId)[0].startMs, 500);
});

test('source edits retain existing translations and can still export without refreshing', () => {
  const project = fixture();
  const trackId = project.captionTracks.translations[0].id;
  const changed = updatePairedCaptionText(project, { trackId, sourceCaptionId: 'c1', primaryText: 'Good morning' });
  assert.equal(changed.captionTracks.translations[0].cues[0].text, '\u4f60\u597d');
  assert.equal(changed.captionTracks.translations[0].cues[0].status, 'stale');
  assert.match(serializeSrt(changed, true), /Good morning\n\u4f60\u597d/);
});

test('a reviewed translation becoming stale still saves and reloads with human provenance', () => {
  let project = fixture();
  const trackId = project.captionTracks.translations[0].id;
  project = updatePairedCaptionText(project, { trackId, sourceCaptionId: 'c1', translatedText: '\u60a8\u597d', translationStatus: 'reviewed' });
  project = updatePairedCaptionText(project, { trackId, sourceCaptionId: 'c1', primaryText: 'Good morning' });
  const restored = decodeVersionTwoProject(JSON.parse(JSON.stringify(project)));
  assert.equal(restored.captionTracks.translations[0].cues[0].status, 'stale');
  assert.equal(restored.captionTracks.translations[0].cues[0].reviewed, true);
});

test('hidden, skipped and off-timeline missing lines do not inflate export warnings', () => {
  let project = fixture();
  const trackId = project.captionTracks.translations[0].id;
  project = setTranslationCueSkipped(project, trackId, 'c2', true);
  project.captionTracks.translations[0].cues[2].startMs = 9000;
  project.captionTracks.translations[0].cues[2].endMs = 10000;
  assert.deepEqual(exportTranslationSummary(project), { missing: 0, needsReview: 0 });
  assert.equal(exportCaptionPairs(project).length, 1);
});

test('short acknowledgements and invariant tokens work without admitting echoed sentences', () => {
  for (const [source, text, target] of [
    ['okay', '\u597d', 'zh-Hans'], ['okay', 'OK!', 'zh-Hans'], ['Okay', 'okay', 'fr'],
    ['42', '42', 'zh-Hans'], ['https://example.test', 'https://example.test', 'ja'],
    ['a name', '\u{20BB7}', 'zh-Hans'],
    ['okay', '\u1eea', 'vi'],
  ]) assert.equal(usableAutomaticTranslation(source, text, false, target), text);
  for (const text of ['Hello world', '', 'okay']) {
    assert.equal(usableAutomaticTranslation(text || 'Hello', text, false, 'zh-Hans'), undefined);
  }
  assert.equal(usableAutomaticTranslation('OK', 'OK', true, 'zh-Hans'), undefined);
});
