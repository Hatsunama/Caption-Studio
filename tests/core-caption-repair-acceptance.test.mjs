import assert from 'node:assert/strict';
import test from 'node:test';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { createEnglishChineseCaptionTrack, resolveCaptionPairs, setTranslationCueTiming } from '../src/lib/caption-tracks.ts';
import { trimVideoClip, replaceVisibleCaptionScript } from '../src/lib/project-editor.ts';
import { setClipPlaybackRate, totalClipDuration } from '../src/lib/video-timeline.ts';
import { decodeVersionTwoProject } from '../src/lib/project-schema.ts';
import { mergeCaptionScriptBlock, splitCaptionScriptBlock } from '../src/lib/caption-script.ts';
import { recoverMergedDualCaptionDrafts, dualCaptionDraftRevision, dualCaptionDraftsFromPairs } from '../src/lib/dual-caption-drafts.ts';

const reload = project => decodeVersionTwoProject(JSON.parse(JSON.stringify(project)));
const cue = project => project.captionTracks.translations[0].cues.find(c => c.sourceCaptionId === 'c1');
const bounds = project => [cue(project).startMs, cue(project).endMs];
function fixture(start = 3300, end = 3700, count = 2) {
  let project = createCaptionProject({ id: 'repair-acceptance', name: 'Repair acceptance', sources: [{ id: 'source',
    uri: 'file:///source.mp4', storageMode: 'copied', displayName: 'source.mp4', durationMs: 4000,
    width: 1080, height: 1920, rotation: 0 }] });
  project.clips = Array.from({ length: count }, (_, index) => ({ ...project.clips[0], id: index ? 'b' : 'a' }));
  project.transcription.language = 'en';
  project.captions = [
    { id: 'c1', text: 'First', startMs: 3200, endMs: 3800, wordIds: [], textMode: 'manual', timingMode: 'source', timelineVisible: true,
      sourceAnchor: { clipId: 'a', sourceStartMs: 3200, sourceEndMs: 3800, wordIds: [] } },
    ...(count > 1 ? [{ id: 'c2', text: 'Second', startMs: 4500, endMs: 5500, wordIds: [], textMode: 'manual', timingMode: 'source', timelineVisible: true,
      sourceAnchor: { clipId: 'b', sourceStartMs: 500, sourceEndMs: 1500, wordIds: [] } }] : []),
  ];
  project = createEnglishChineseCaptionTrack(project, { c1: 'Independent first', ...(count > 1 ? { c2: 'Independent second' } : {}) });
  if (start !== undefined && end !== undefined) Object.assign(cue(project), { startMs: start, endMs: end });
  project.audioSources = [{ id: 'music', uri: 'file:///music.m4a', storageMode: 'copied', displayName: 'Music', durationMs: 10000, origin: 'audio-file' }];
  project.audioClips = [{ id: 'music', sourceId: 'music', anchor: 'timeline', startMs: 5000, sourceStartMs: 0,
    sourceEndMs: 5000, volume: 1, muted: false, fadeInMs: 0, fadeOutMs: 0 }];
  return project;
}

test('repair acceptance: independent range survives head trim, reload, and restoration without moving music', () => {
  const original = fixture();
  const trimmed = reload(trimVideoClip(original, 'a', 'start', 3500).project);
  assert.deepEqual(bounds(trimmed), [3300, 3700]);
  const restored = reload(trimVideoClip(trimmed, 'a', 'start', 0).project);
  assert.deepEqual(bounds(restored), [3300, 3700]);
  assert.deepEqual(trimmed.audioClips, original.audioClips);
  assert.deepEqual(restored.audioClips, original.audioClips);
});

test('repair acceptance: speed after persisted head trim keeps the independent timing operation frame', () => {
  const original = fixture(500, 2000);
  const trimmed = reload(trimVideoClip(original, 'a', 'start', 1000).project);
  const sped = reload(setClipPlaybackRate(trimmed, 'a', 2));
  assert.deepEqual(bounds(sped), [500, 1500]);
  assert.deepEqual(sped.audioClips, original.audioClips);
  assert.equal(totalClipDuration(sped.clips), 5500);
});

test('repair acceptance: raw independent tail interval survives shorter video extent and restoration', () => {
  const original = fixture(3300, 3700, 1);
  const trimmed = reload(trimVideoClip(original, 'a', 'end', 2000).project);
  assert.equal(totalClipDuration(trimmed.clips), 2000);
  assert.deepEqual(bounds(trimmed), [3300, 3700]);
  assert.deepEqual(bounds(reload(trimVideoClip(trimmed, 'a', 'end', 4000).project)), [3300, 3700]);
  assert.deepEqual(trimmed.audioClips, original.audioClips);
});

test('repair acceptance: inherited source-aligned translation follows footage and restores its source range', () => {
  const original = fixture(3200, 3800);
  const trimmed = reload(trimVideoClip(original, 'a', 'start', 3500).project);
  assert.deepEqual(bounds(trimmed), [0, 300]);
  assert.deepEqual(bounds(trimmed), [trimmed.captions[0].startMs, trimmed.captions[0].endMs]);
  const restored = reload(trimVideoClip(trimmed, 'a', 'start', 0).project);
  assert.deepEqual(bounds(restored), [3200, 3800]);
});

test('repair acceptance: explicit independent timing remains independent even when matching primary bounds', () => {
  const original = fixture(3200, 3800);
  const explicit = reload(setTranslationCueTiming(original, original.captionTracks.translations[0].id, 'c1', 'move', 3200, 3800));
  const trimmed = reload(trimVideoClip(explicit, 'a', 'start', 3500).project);
  assert.deepEqual(bounds(trimmed), [3200, 3800]);
  assert.notDeepEqual(bounds(trimmed), [trimmed.captions[0].startMs, trimmed.captions[0].endMs]);
});

test('repair acceptance: split archives persist and current-revision journals recover by current IDs', () => {
  let project = fixture(3200, 3800);
  project.captions = project.captions.map((caption, index) => ({ ...caption, id: index ? 'b' : 'a',
    text: index ? 'Beta' : 'Alpha', startMs: index * 1000, endMs: (index + 1) * 1000, timingMode: 'timeline', sourceAnchor: undefined }));
  project = createEnglishChineseCaptionTrack({ ...project, captionTracks: { schemaVersion: 1, primaryTrackId: 'captions', translations: [] } },
    { a: 'Translation Alpha', b: 'Translation Beta' });
  const joined = replaceVisibleCaptionScript(project, mergeCaptionScriptBlock(project.captions, 'b').captions);
  const archive = JSON.parse(JSON.stringify(joined.captions[0].mergeProvenance.fragments));
  const split = reload(replaceVisibleCaptionScript(joined, splitCaptionScriptBlock(joined.captions, 'a', 5, [], 'b').captions));
  assert.deepEqual(JSON.parse(JSON.stringify(split.captions[0].mergeProvenance.fragments)), archive);
  const pairs = split.captions.map(source => ({ source, translation: split.captionTracks.translations[0].cues.find(c => c.sourceCaptionId === source.id) }));
  const committed = dualCaptionDraftsFromPairs(pairs);
  const draft = { ...committed, b: { primaryText: 'Typed right', translatedText: 'Typed right translation' } };
  const recovered = recoverMergedDualCaptionDrafts(draft, pairs, split.captionTracks.translations[0].id, dualCaptionDraftRevision(committed));
  assert.equal(recovered.drafts.a.primaryText, 'Alpha');
  assert.equal(recovered.drafts.b.translatedText, 'Typed right translation');
  const rejoined = reload(replaceVisibleCaptionScript(split, mergeCaptionScriptBlock(split.captions, 'b').captions));
  assert.equal(rejoined.captions.length, 1);
  assert.ok(rejoined.captions[0].mergeProvenance.fragments.length >= archive.length);
});

test('repair acceptance: manual joins archive independent operation frames and keep the survivor frame', () => {
  const original = fixture();
  const trimmed = reload(trimVideoClip(original, 'a', 'start', 1000).project);
  const trackId = trimmed.captionTracks.translations[0].id;
  const survivorId = cue(trimmed).id;
  const before = structuredClone(trimmed);
  const joined = reload(replaceVisibleCaptionScript(trimmed, mergeCaptionScriptBlock(trimmed.captions, 'c2').captions));
  assert.equal(joined.captionTracks.independentTimingOrigins[survivorId], 1000);
  assert.equal(joined.captions[0].mergeProvenance.fragments[0].translationOrigins[trackId], 1000);
  assert.deepEqual(joined.captions[0].mergeProvenance.fragments[0].translationCues[trackId], before.captionTracks.translations[0].cues[0]);
  assert.deepEqual(JSON.parse(JSON.stringify(trimmed)), JSON.parse(JSON.stringify(before)));
});

test('repair acceptance: source-linked hidden ranges restore while explicit visibility remains owned by the user', () => {
  for (const visible of [true, false]) {
    const original = fixture(3200, 3800);
    cue(original).timelineVisible = visible;
    const trimmed = reload(trimVideoClip(original, 'a', 'end', 2000).project);
    const trackId = trimmed.captionTracks.translations[0].id;
    assert.equal(resolveCaptionPairs(trimmed, trackId).find(pair => pair.source.id === 'c1').timelineVisible, false);
    const restored = reload(trimVideoClip(trimmed, 'a', 'end', 4000).project);
    assert.deepEqual(bounds(restored), [3200, 3800]);
    assert.equal(resolveCaptionPairs(restored, trackId).find(pair => pair.source.id === 'c1').timelineVisible, visible);
  }
});
