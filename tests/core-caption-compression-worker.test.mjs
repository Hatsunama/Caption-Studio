import assert from 'node:assert/strict';
import test from 'node:test';

import { createCaptionProject } from '../src/lib/project-factory.ts';
import { decodeVersionTwoProject } from '../src/lib/project-schema.ts';
import {
  replaceVisibleCaptionScript,
  setVideoClipGap,
  trimVideoClip,
  reorderVideoClip,
  setCaptionTexts,
} from '../src/lib/project-editor.ts';
import { buildClipTimeline, mapSourceWordsToTimeline, rippleTimedContent, setClipPlaybackRate } from '../src/lib/video-timeline.ts';
import { synchronizeCaptionTracks } from '../src/lib/caption-tracks.ts';
import { mergeCaptionScriptBlock } from '../src/lib/caption-script.ts';
import { sequenceGeneratedPrimaryCaptions } from '../src/lib/primary-caption-timing.ts';
import * as dualDrafts from '../src/lib/dual-caption-drafts.ts';

function fixture() {
  const project = createCaptionProject({
    id: 'core-caption-worker', name: 'Core caption regression',
    sources: [{ id: 'source', uri: 'file:///source.mp4', storageMode: 'copied',
      displayName: 'source.mp4', durationMs: 4000, width: 1080, height: 1920, rotation: 0 }],
  });
  const clipId = project.clips[0].id;
  project.transcription = { ...project.transcription, language: 'en', wordTiming: 'timeline',
    words: [{ id: 'word-left', text: 'Edited', startMs: 100, endMs: 600 },
      { id: 'word-right', text: 'words', startMs: 600, endMs: 1200 }] };
  project.captions = [
    { id: 'left', text: 'Edited left', startMs: 100, endMs: 600, wordIds: ['word-left'],
      textMode: 'manual', timingMode: 'source', timelineVisible: true,
      sourceAnchor: { clipId, sourceStartMs: 100, sourceEndMs: 600, wordIds: ['word-left'] } },
    { id: 'right', text: 'Edited right', startMs: 600, endMs: 1200, wordIds: ['word-right'],
      textMode: 'manual', timingMode: 'source', timelineVisible: true,
      sourceAnchor: { clipId, sourceStartMs: 600, sourceEndMs: 1200, wordIds: ['word-right'] } },
  ];
  project.captionTracks = { schemaVersion: 1, primaryTrackId: 'captions', translations:
    [['fr', 'Bonjour', 'monde'], ['zh-Hans', '\u4f60\u597d', '\u4e16\u754c']].map(([languageTag, left, right]) => ({
      id: `translation-${languageTag}`, kind: 'translation', sourceTrackId: 'captions',
      sourceLanguageTag: 'en', languageTag, displayName: languageTag, visible: true,
      origin: 'manual', provider: { id: 'manual' },
      cues: project.captions.map((caption, index) => ({ id: `${languageTag}-${caption.id}`,
        sourceCaptionId: caption.id, sourceTextSnapshot: caption.text,
        text: index === 0 ? left : right, status: 'reviewed', reviewed: true })),
    })) };
  return project;
}

function joinedDraft(project) {
  return mergeCaptionScriptBlock(project.captions, project.captions[1].id, 'previous').captions;
}

test('core worker: completed zero-gap splice preserves a positive short acoustic word', () => {
  const project = fixture();
  project.transcription.words = [{ id: 'tiny', text: 'A', startMs: 200, endMs: 230 }];
  const result = setVideoClipGap(project, project.clips[0].id, 0);
  const next = result?.project ?? result ?? project;
  assert.deepEqual(next.transcription.words, project.transcription.words);
});

test('core worker: removing a gap retains the positive acoustic word remnant below 80ms', () => {
  const project = fixture();
  project.clips[0].gapBeforeMs = 1000;
  project.transcription.words = [{ id: 'tiny', text: 'A', startMs: 950, endMs: 1050 }];
  const result = setVideoClipGap(project, project.clips[0].id, 0);
  assert.ok(result, 'gap removal must produce an edit');
  const next = result.project;
  assert.deepEqual(next.transcription.words.map(({ id, startMs, endMs }) => ({ id, startMs, endMs })),
    [{ id: 'tiny', startMs: 0, endMs: 50 }]);
});

test('core worker: manual join retains the chronological left primary ID', () => {
  const project = fixture();
  const next = replaceVisibleCaptionScript(project, joinedDraft(project));
  assert.deepEqual(next.captions.filter(c => c.timelineVisible !== false).map(c => c.id), ['left']);
});

for (const [trackIndex, expected] of [[0, 'Bonjour monde'], [1, '\u4f60\u597d\u4e16\u754c']]) {
  test(`core worker: manual join preserves both translated texts in track ${trackIndex}`, () => {
    const project = fixture();
    const before = structuredClone(project);
    const next = replaceVisibleCaptionScript(project, joinedDraft(project));
    const cues = next.captionTracks.translations[trackIndex].cues;
    assert.equal(cues.length, 1);
    assert.equal(cues[0].sourceCaptionId, 'left');
    assert.equal(cues[0].text, expected);
    assert.equal(cues[0].status, 'stale');
    assert.equal(cues[0].reviewed, false);
    assert.deepEqual(project, before);
  });
}

test('core worker: conflicting manual translated styles combine and retain recoverable originals', () => {
  const project = fixture();
  project.captionTracks.translations[0].cues[0].styleOverride = { textColor: '#FF0000' };
  project.captionTracks.translations[0].cues[1].styleOverride = { textColor: '#00FF00' };
  const before = structuredClone(project);
  const next = replaceVisibleCaptionScript(project, joinedDraft(project));
  assert.equal(next.captionTracks.translations[0].cues[0].text, 'Bonjour monde');
  assert.deepEqual(next.captionTracks.translations[0].cues[0].styleOverride, { textColor: '#FF0000' });
  assert.deepEqual(next.captions[0].mergeProvenance.fragments.map(f => f.translationCues['translation-fr']),
    before.captionTracks.translations[0].cues);
  assert.deepEqual(project, before);
});

test('core worker: conflicting manual translated timings combine their envelope and retain originals', () => {
  const project = fixture();
  Object.assign(project.captionTracks.translations[0].cues[0], { startMs: 150, endMs: 450 });
  Object.assign(project.captionTracks.translations[0].cues[1], { startMs: 900, endMs: 1800 });
  const before = structuredClone(project);
  const next = replaceVisibleCaptionScript(project, joinedDraft(project));
  const cue = next.captionTracks.translations[0].cues[0];
  assert.deepEqual([cue.startMs, cue.endMs, cue.text], [150, 1800, 'Bonjour monde']);
  assert.deepEqual(next.captions[0].mergeProvenance.fragments.map(f => f.translationCues['translation-fr']),
    before.captionTracks.translations[0].cues);
  assert.deepEqual(project, before);
});

test('core worker: completed trim clears outer gaps and leaves saved independent music unchanged', () => {
  const project = fixture();
  project.clips[0] = { ...project.clips[0], gapBeforeMs: 300, gapAfterMs: 700 };
  project.audioSources = [{ id: 'music', uri: 'file:///music.m4a', storageMode: 'copied',
    displayName: 'Music', durationMs: 10000, origin: 'audio-file' }];
  project.audioClips = [{ id: 'music-clip', sourceId: 'music', anchor: 'timeline', startMs: 2000,
    sourceStartMs: 0, sourceEndMs: 8000, volume: 1, muted: false, fadeInMs: 0, fadeOutMs: 0 }];
  const beforeMusic = structuredClone(project.audioClips);
  const next = trimVideoClip(project, project.clips[0].id, 'end', 3000).project;
  assert.equal(next.clips[0].gapBeforeMs, 0);
  assert.equal(next.clips.at(-1).gapAfterMs, 0);
  assert.deepEqual(next.audioClips, beforeMusic);
});

test('core worker: former final trailing gap remains internal after footage is appended', () => {
  const project = fixture();
  const first = { ...project.clips[0], gapBeforeMs: 300, gapAfterMs: 700 };
  project.clips = [first, { ...first, id: 'appended', gapBeforeMs: 200, gapAfterMs: 500 }];
  const result = trimVideoClip(project, 'appended', 'end', 3000);
  assert.ok(result, 'appended source trim must produce an edit');
  const next = result.project;
  assert.equal(next.clips[0].gapBeforeMs, 0);
  assert.equal(next.clips[0].gapAfterMs, 700);
  assert.equal(next.clips[1].gapBeforeMs, 200);
  assert.equal(next.clips[1].gapAfterMs, 0);
  const entries = buildClipTimeline(next.clips);
  assert.equal(entries[1].startMs - entries[0].endMs, 900);
});

test('core worker: schema accepts renderer-supported 0.25 line height and preserves it', () => {
  const project = fixture();
  project.projectStyle.lineHeight = 0.25;
  const decoded = decodeVersionTwoProject(JSON.parse(JSON.stringify(project)));
  assert.ok(decoded, 'valid renderer line height must decode');
  assert.equal(decoded.projectStyle.lineHeight, 0.25);
});

test('core worker: ripple preserves a positive acoustic remainder without display padding', () => {
  const project = fixture();
  project.transcription.words = [{ id: 'acoustic', text: 'A', startMs: 950, endMs: 1050 }];
  const next = rippleTimedContent(project, 0, 1000);
  assert.deepEqual(next.transcription.words, [{ id: 'acoustic', text: 'A', startMs: 0, endMs: 50 }]);
});

test('core worker: generated tiny cue chooses the closer preceding neighbor', () => {
  const cues = [
    { id: 'a', text: 'Before.', startMs: 0, endMs: 1000, wordIds: ['a'] },
    { id: 'b', text: 'A.', startMs: 1000, endMs: 1040, wordIds: ['b'] },
    { id: 'c', text: 'After.', startMs: 1100, endMs: 2100, wordIds: ['c'] },
  ];
  const result = sequenceGeneratedPrimaryCaptions(cues, 3200, () => true);
  assert.deepEqual(result.map(c => c.wordIds), [['a', 'b'], ['c']]);
});

test('core worker: speed completion absorbs locally using elapsed display time and keeps raw source words', () => {
  const project = fixture();
  const clipId = project.clips[0].id;
  project.captionTracks.translations = [];
  project.captions = [
    { id: 'a', text: 'Before.', startMs: 0, endMs: 1000, wordIds: ['a'] },
    { id: 'b', text: 'A.', startMs: 1000, endMs: 1040, wordIds: ['b'] },
    { id: 'c', text: 'After.', startMs: 1100, endMs: 2100, wordIds: ['c'] },
  ].map(c => ({ ...c, textMode: 'manual', timingMode: 'source', timelineVisible: true,
    sourceAnchor: { clipId, sourceStartMs: c.startMs, sourceEndMs: c.endMs, wordIds: c.wordIds } }));
  project.transcription.sourceResults = { source: { language: 'en', modelId: 'test', generatedAt: project.createdAt,
    words: project.captions.map(c => ({ id: c.id, text: c.text, startMs: c.startMs, endMs: c.endMs })) } };
  const sourceBefore = structuredClone(project.transcription.sourceResults);
  const result = setClipPlaybackRate(project, clipId, 2);
  assert.deepEqual(result.captions.map(c => c.id), ['a', 'c']);
  assert.equal(result.captions[0].text, 'Before. A.');
  assert.deepEqual(project.transcription.sourceResults, sourceBefore);
  assert.deepEqual(result.transcription.sourceResults, sourceBefore);
});

test('core worker: manual cross-cut joins retain both translations and survive schema roundtrip', () => {
  const project = fixture();
  project.captions[1].sourceAnchor.clipId = 'other-cut';
  const result = replaceVisibleCaptionScript(project, joinedDraft(project));
  assert.equal(result.captions[0].timingMode, 'timeline');
  assert.equal(result.captionTracks.translations[0].cues[0].text, 'Bonjour monde');
  const restored = decodeVersionTwoProject(JSON.parse(JSON.stringify(result)));
  assert.deepEqual(JSON.parse(JSON.stringify(restored.captions[0].mergeProvenance)),
    JSON.parse(JSON.stringify(result.captions[0].mergeProvenance)));
  assert.equal(restored.captions[0].mergeProvenance.fragments.length, 2);
});

for (const conflict of ['owner', 'style', 'timing']) {
  test(`core worker: speed absorption preserves incompatible ${conflict} pairs`, () => {
    const project = fixture();
    if (conflict === 'owner') project.captions[1].sourceAnchor.clipId = 'other-cut';
    if (conflict === 'style') project.captionTracks.translations[1].cues[1].styleOverride = { textColor: '#123456' };
    if (conflict === 'timing') Object.assign(project.captionTracks.translations[1].cues[1], { startMs: 900, endMs: 1500 });
    const next = setClipPlaybackRate(project, project.clips[0].id, 4);
    assert.deepEqual(next.captions.map(c => c.id), ['left', 'right']);
    assert.deepEqual(next.captionTracks.translations.map(t => t.cues.map(c => c.text)),
      [['Bonjour', 'monde'], ['\u4f60\u597d', '\u4e16\u754c']]);
  });
}

test('core worker: old-ID journal edits remap into the survivor without losing either fragment', () => {
  assert.equal(typeof dualDrafts.recoverMergedDualCaptionDrafts, 'function');
  const project = fixture();
  const next = replaceVisibleCaptionScript(project, joinedDraft(project));
  const pairs = [{ source: next.captions[0], translation: next.captionTracks.translations[0].cues[0] }];
  const recovered = dualDrafts.recoverMergedDualCaptionDrafts({
    left: { primaryText: 'Typed left', translatedText: 'Bonjour' },
    right: { primaryText: 'Edited right', translatedText: 'typed right translation' },
  }, pairs, 'translation-fr');
  assert.equal(recovered.remapped, true);
  assert.deepEqual(recovered.drafts, { left: {
    primaryText: 'Typed left Edited right', translatedText: 'Bonjour typed right translation',
  } });
});

test('core worker: unknown or conflicting journal IDs are retained as explicit recovery conflicts', () => {
  assert.equal(typeof dualDrafts.recoverMergedDualCaptionDrafts, 'function');
  const project = fixture();
  const next = replaceVisibleCaptionScript(project, joinedDraft(project));
  const pairs = [{ source: { ...next.captions[0], text: 'Changed after merge' },
    translation: next.captionTracks.translations[0].cues[0] }];
  const payload = { right: { primaryText: 'Typing', translatedText: 'Keep this typing' } };
  const before = structuredClone(payload);
  assert.throws(() => dualDrafts.recoverMergedDualCaptionDrafts(payload, pairs, 'translation-fr'), /conflict|changed/i);
  assert.throws(() => dualDrafts.recoverMergedDualCaptionDrafts({ unknown: payload.right }, [], 'translation-fr'), /unknown|identity|conflict/i);
  assert.deepEqual(payload, before);
});

test('core worker: bounded merge provenance never evicts existing fragment identities', () => {
  const project = fixture();
  project.captions[0].mergeProvenance = { fragments: Array.from({ length: 32 }, (_, i) => ({
    captionId: i === 0 ? 'left' : `old-${i}`, primaryText: 'part', translations: {},
  })) };
  const before = structuredClone(project);
  assert.throws(() => joinedDraft(project), /limit|bound|32|history/i);
  assert.deepEqual(project, before);
});

test('core worker: reorder zero splice retains a short acoustic word', () => {
  const project = fixture();
  project.clips.push({ ...project.clips[0], id: 'second' });
  project.transcription.words = [{ id: 'tiny', text: 'A', startMs: 100, endMs: 125 }];
  const next = reorderVideoClip(project, 'second', 0).project;
  assert.deepEqual(next.transcription.words, project.transcription.words);
});

test('core worker: automatic compatible joins preserve every translation track and stale review state', () => {
  const project = fixture();
  const next = setClipPlaybackRate(project, project.clips[0].id, 4);
  assert.deepEqual(next.captions.map(c => c.id), ['left']);
  assert.deepEqual(next.captionTracks.translations.map(track => [track.id, track.cues[0].text, track.cues[0].status, track.cues[0].reviewed]),
    [['translation-fr', 'Bonjour monde', 'stale', false], ['translation-zh-Hans', '\u4f60\u597d\u4e16\u754c', 'stale', false]]);
});

test('core worker: automatic overflow preserves the isolated short cue and all recovery history', () => {
  const project = fixture();
  project.captions[0].mergeProvenance = { fragments: Array.from({ length: 32 }, (_, index) => ({
    captionId: index === 0 ? 'left' : `retired-${index}`, primaryText: 'part', translations: {},
  })) };
  const before = structuredClone(project.captions[0].mergeProvenance);
  const next = setClipPlaybackRate(project, project.clips[0].id, 4);
  assert.deepEqual(next.captions.map(c => c.id), ['left', 'right']);
  assert.deepEqual(next.captions[0].mergeProvenance, before);
});

test('core worker: an incompatible closer neighbor does not prevent choosing the other compatible neighbor', () => {
  const project = fixture();
  const owner = project.clips[0].id;
  project.captionTracks.translations = [];
  project.captions = [
    { id: 'a', text: 'Before.', startMs: 0, endMs: 1000, wordIds: [], styleOverride: { textColor: '#FF0000' } },
    { id: 'b', text: 'A.', startMs: 1000, endMs: 1040, wordIds: [] },
    { id: 'c', text: 'After.', startMs: 1100, endMs: 2100, wordIds: [] },
  ].map(c => ({ ...c, textMode: 'manual', timingMode: 'source', timelineVisible: true,
    sourceAnchor: { clipId: owner, sourceStartMs: c.startMs, sourceEndMs: c.endMs, wordIds: [] } }));
  const next = setClipPlaybackRate(project, owner, 2);
  assert.deepEqual(next.captions.map(c => [c.id, c.text]), [['a', 'Before.'], ['b', 'A. After.']]);
});

test('core worker: later human review is not erased by subsequent source edits or synchronization', () => {
  const project = fixture();
  const joined = replaceVisibleCaptionScript(project, joinedDraft(project));
  Object.assign(joined.captionTracks.translations[0].cues[0], { status: 'reviewed', reviewed: true });
  const edited = setCaptionTexts(joined, { left: 'New source after human review' });
  const tracks = synchronizeCaptionTracks(edited);
  assert.equal(tracks.translations[0].cues[0].reviewed, true);
  assert.equal(tracks.translations[0].cues[0].status, 'stale');
});

test('core worker: compaction moves attached audio and restores hidden source anchors without moving independent media', () => {
  const project = fixture();
  const clip = project.clips[0];
  project.clips = [{ ...clip, gapBeforeMs: 300, gapAfterMs: 700 }];
  const canonical = [{ id: 'first', text: 'Edited left', startMs: 100, endMs: 600 },
    { id: 'last', text: 'Edited right', startMs: 3500, endMs: 3800 }];
  project.transcription.wordTiming = 'source';
  project.transcription.sourceResults = { source: { language: 'en', modelId: 'test', generatedAt: project.createdAt, words: canonical } };
  project.transcription.words = mapSourceWordsToTimeline(project.clips, { source: canonical });
  project.captions = project.captions.map((caption, index) => ({ ...caption,
    startMs: canonical[index].startMs + 300, endMs: canonical[index].endMs + 300,
    wordIds: [`${clip.id}-${canonical[index].id}`], sourceAnchor: { clipId: clip.id,
      sourceStartMs: canonical[index].startMs, sourceEndMs: canonical[index].endMs,
      wordIds: [`${clip.id}-${canonical[index].id}`] } }));
  project.audioSources = [{ id: 'audio', uri: 'file:///audio.m4a', storageMode: 'copied',
    displayName: 'Audio', durationMs: 10000, origin: 'video-audio' }];
  const independent = { id: 'music', sourceId: 'audio', anchor: 'timeline', startMs: 5000,
    sourceStartMs: 0, sourceEndMs: 5000, volume: 1, muted: false, fadeInMs: 0, fadeOutMs: 0 };
  project.audioClips = [independent, { ...independent, id: 'attached', anchor: 'video', videoClipId: clip.id,
    anchorOffsetMs: 0, startMs: 400, sourceStartMs: 100, sourceEndMs: 600 }];
  const trimmed = trimVideoClip(project, clip.id, 'end', 3000).project;
  assert.deepEqual(trimmed.audioClips.find(c => c.id === 'music'), independent);
  assert.equal(trimmed.audioClips.find(c => c.id === 'attached').startMs, 100);
  assert.equal(trimmed.captions.find(c => c.id === 'right').timelineVisible, false);
  assert.deepEqual(trimmed.captions.find(c => c.id === 'right').sourceAnchor, project.captions[1].sourceAnchor);
  const restored = trimVideoClip(trimmed, clip.id, 'end', 4000).project;
  const right = restored.captions.find(c => c.id === 'right');
  assert.deepEqual([right.startMs, right.endMs, right.timelineVisible, right.text], [3500, 3800, true, 'Edited right']);
  assert.deepEqual(restored.transcription.sourceResults.source.words, canonical);
});
