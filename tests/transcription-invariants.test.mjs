import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createCaptionProject } from '../src/lib/project-factory.ts';
import { decodeVersionTwoProject, serializeProjectSnapshot } from '../src/lib/project-schema.ts';
import { hydrateProjectTranscription } from '../src/lib/transcription-hydration.ts';
import { recoverPersistedDuplicateSourceWordIds } from '../src/lib/transcription-recovery.ts';
import { restoreTimelineTranscription } from '../src/lib/timeline-transcription.ts';
import { mapSourceWordsToTimeline, recoverCanonicalSourceWords } from '../src/lib/video-timeline.ts';
import { setVideoClipLeadingGap, splitVideoClip } from '../src/lib/project-editor.ts';
import { mergeCaptionScriptBlock, splitCaptionScriptBlock } from '../src/lib/caption-script.ts';
import { projectPrimaryCaptionLanguage } from '../src/lib/caption-tracks.ts';
import { coalesceWhisperWords } from '../src/lib/whisper-words.ts';
import { alignWordsToSpeech } from '../src/lib/speech-alignment.ts';

const sourceId = 'source-1789220397255-tx9f59cd-0';
const word = (id, startMs, endMs, text = 'spoken') => ({ id, text, startMs, endMs, confidence: undefined, styleOverride: undefined });
const sourceResult = (words) => ({ language: 'en', modelId: 'balanced', generatedAt: '2026-09-12T00:00:00.000Z', words });

function fixture() {
  const project = createCaptionProject({
    id: 'transcription-test', name: 'Transcription test',
    sources: [{ id: sourceId, uri: 'file:///test.mp4', storageMode: 'copied', displayName: 'Test.mp4', durationMs: 4_000, width: 1080, height: 1920, rotation: 0 }],
  });
  project.clips[0].id = 'whole';
  return project;
}

function reopen(project) {
  const decoded = decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(project)));
  return { ...decoded, ...hydrateProjectTranscription(decoded, decoded.clips) };
}

function splitFixture() {
  const project = fixture();
  const whole = project.clips[0];
  project.clips = [
    { ...whole, id: 'left', sourceEndMs: 2_000 },
    { ...whole, id: 'right', sourceStartMs: 2_000 },
  ];
  return project;
}

test('zero-word source results survive checkpoint, hydration, editing, and save/reload', () => {
  const project = fixture();
  project.transcription.sourceResults[sourceId] = sourceResult([]);
  for (const wordTiming of [undefined, 'source', 'timeline']) {
    project.transcription.wordTiming = wordTiming;
    const opened = reopen(project);
    const split = splitVideoClip(opened, 'whole', 2_000, 'left', 'right').project;
    const saved = reopen(split);
    assert.deepEqual(saved.transcription.words, []);
    assert.deepEqual(saved.transcription.sourceResults[sourceId].words, []);
    assert.deepEqual(reopen(saved), saved);
  }
});

test('native segment aggregation and speech alignment assign unique IDs across chunks', () => {
  const words = coalesceWhisperWords([
    { id: 0, text: ' Hello', t0: 0, t1: 30 },
    { id: 0, text: ' world', t0: 30, t1: 60 },
    { id: 0, text: ' Hello', t0: 100, t1: 130 },
    { id: 0, text: ' world', t0: 130, t1: 160 },
  ]);
  const aligned = alignWordsToSpeech(words, [{ t0: 0, t1: 60 }, { t0: 100, t1: 160 }]);
  assert.equal(aligned.length, 4);
  assert.equal(new Set(aligned.map((entry) => entry.id)).size, 4);
});

test('the production error is a source ID suffix, and real duplicates remain invalid', () => {
  const project = splitFixture();
  project.transcription.words = [word('left-word-1', 1_800, 2_000), word('right-word-1', 2_000, 2_200)];
  // The old hydration cache keyed by id:start:end retained both fragments with
  // id=word-1. The next getProject during Save draft threw this exact error.
  project.transcription.sourceResults[sourceId] = sourceResult([word('word-1', 1_800, 2_000), word('word-1', 2_000, 2_200)]);
  assert.throws(() => serializeProjectSnapshot(project), {
    message: `source transcription ${sourceId} words contain duplicate identifiers`,
  });
  project.transcription.sourceResults = {};
  project.transcription.words.push({ ...project.transcription.words[0] });
  assert.throws(() => serializeProjectSnapshot(project), /project transcription words contain duplicate identifiers/);
});

test('known duplicate derived source caches recover without discarding the saved edit', () => {
  const project = splitFixture();
  project.transcription.words = [word('left-word-1', 1_800, 2_000), word('right-word-1', 2_000, 2_200)];
  project.transcription.sourceResults[sourceId] = sourceResult([
    word('word-1', 1_800, 2_000),
    word('word-1', 2_000, 2_200),
  ]);
  project.captions = [{
    id: 'edited-caption',
    text: 'User edited text',
    textMode: 'manual',
    startMs: 1_800,
    endMs: 2_200,
    wordIds: ['left-word-1', 'right-word-1'],
  }];

  const recovered = recoverPersistedDuplicateSourceWordIds(structuredClone(project));
  assert.equal(recovered.transcription.wordTiming, 'timeline');
  assert.deepEqual(Object.keys(recovered.transcription.sourceResults), []);
  const decoded = decodeVersionTwoProject(recovered);
  const opened = { ...decoded, ...hydrateProjectTranscription(decoded, decoded.clips) };
  assert.deepEqual(opened.transcription.words, project.transcription.words);
  assert.equal(opened.captions[0].text, 'User edited text');
  assert.doesNotThrow(() => serializeProjectSnapshot(opened));
});

test('recovery refuses to hide duplicate canonical timeline word identifiers', () => {
  const project = fixture();
  project.transcription.words = [word('duplicate', 100, 200), word('duplicate', 300, 400)];
  project.transcription.sourceResults[sourceId] = sourceResult([
    word('source-duplicate', 100, 200),
    word('source-duplicate', 300, 400),
  ]);
  const candidate = structuredClone(project);
  assert.equal(recoverPersistedDuplicateSourceWordIds(candidate), candidate);
  assert.throws(() => decodeVersionTwoProject(candidate), /project transcription words contain duplicate identifiers/);
});

test('legacy split fragments keep every timeline word and never manufacture duplicate source IDs', () => {
  const project = splitFixture();
  project.transcription.words = [word('left-word-1', 1_800, 2_000), word('right-word-1', 2_000, 2_200)];
  const original = structuredClone(project.transcription.words);
  assert.deepEqual(recoverCanonicalSourceWords(project.clips, original), {});
  const opened = reopen(project);
  assert.deepEqual(opened.transcription.words, original);
  assert.deepEqual(Object.keys(opened.transcription.sourceResults), []);
  assert.deepEqual(reopen(opened), opened);
});

test('recovery never overwrites conflicting text/style or drops unmappable words', () => {
  const project = fixture();
  project.clips = [
    { ...project.clips[0], id: 'one', sourceEndMs: 1_000 },
    { ...project.clips[0], id: 'two', sourceEndMs: 1_000, gapBeforeMs: 500 },
  ];
  for (const words of [
    [word('one-w', 100, 500, 'first'), word('two-w', 1_600, 2_000, 'different')],
    [word('one-w', 100, 500), { ...word('two-w', 1_600, 2_000), styleOverride: { textColor: '#FF0000' } }],
    [word('one-w', 100, 500), word('gap', 1_100, 1_300)],
    [word('crossing', 800, 1_700)],
    [word('zero-duration', 100, 100)],
  ]) {
    project.transcription.words = words;
    const opened = reopen(project);
    assert.deepEqual(opened.transcription.words, words);
    assert.deepEqual(Object.keys(opened.transcription.sourceResults), []);
  }
});

test('identical repeated source occurrences recover once and project back without data loss', () => {
  const project = fixture();
  project.clips = [{ ...project.clips[0], id: 'one' }, { ...project.clips[0], id: 'two' }];
  const sourceWords = [word('w', 100, 500)];
  project.transcription.words = mapSourceWordsToTimeline(project.clips, { [sourceId]: sourceWords });
  const opened = reopen(project);
  assert.deepEqual(opened.transcription.sourceResults[sourceId].words, sourceWords);
  assert.deepEqual(opened.transcription.words, project.transcription.words);
});

test('legacy ID migration updates both caption and source-anchor references and is idempotent', () => {
  const project = fixture();
  project.transcription.words = [word('w', 100, 500)];
  project.captions = [{ id: 'caption', text: 'My edit', textMode: 'manual', timingMode: 'source', startMs: 100, endMs: 500, wordIds: ['w'], sourceAnchor: { clipId: 'whole', sourceStartMs: 100, sourceEndMs: 500, wordIds: ['w'] } }];
  const opened = reopen(project);
  assert.deepEqual(opened.captions[0].wordIds, ['whole-w']);
  assert.deepEqual(opened.captions[0].sourceAnchor.wordIds, ['whole-w']);
  assert.equal(opened.captions[0].text, 'My edit');
  assert.equal(serializeProjectSnapshot(reopen(opened)), serializeProjectSnapshot(opened));
});

test('legacy hydration does not create empty or overlong identifiers', () => {
  for (const id of ['whole-', 'w'.repeat(256)]) {
    const project = fixture();
    project.transcription.words = [word(id, 100, 500)];
    const opened = reopen(project);
    assert.deepEqual(opened.transcription.words, project.transcription.words);
    assert.deepEqual(Object.keys(opened.transcription.sourceResults), []);
    assert.doesNotThrow(() => serializeProjectSnapshot(opened));
  }
});

test('timeline restore keeps mixed word identity and correctly restores trimmed/rate-adjusted anchors', () => {
  const project = fixture();
  project.clips[0] = { ...project.clips[0], sourceStartMs: 1_000, sourceEndMs: 3_000, playbackRate: 2 };
  const generated = structuredClone(project);
  generated.transcription.words = [word('whole-w', 100, 300)];
  generated.captions = [{ id: 'caption', text: 'spoken', startMs: 100, endMs: 300, wordIds: ['whole-w'], sourceAnchor: { clipId: 'whole', sourceStartMs: 100, sourceEndMs: 300, wordIds: ['whole-w'] } }];
  const restored = restoreTimelineTranscription(project, generated);
  assert.equal(restored.transcription.wordTiming, 'timeline');
  assert.deepEqual(restored.captions[0].sourceAnchor, { clipId: 'whole', sourceStartMs: 1_200, sourceEndMs: 1_600, wordIds: ['whole-w'] });
  const opened = reopen(restored);
  assert.deepEqual(opened.transcription.words, generated.transcription.words);
  assert.deepEqual(Object.keys(opened.transcription.sourceResults), []);
});

test('timeline checkpoints preserve the previous transcript until new captions are complete', () => {
  const project = fixture();
  project.transcription.sourceResults[sourceId] = sourceResult([word('old', 100, 500)]);
  const checkpoint = { ...project, transcription: { ...project.transcription, sourceResults: { synthetic: sourceResult([word('new', 100, 500)]) } } };
  const restored = restoreTimelineTranscription(project, checkpoint);
  assert.equal(restored.transcription, project.transcription);
  assert.equal(restored.captions, project.captions);
});

test('old source caches cannot replace mixed-audio words or their detected language after editing', () => {
  const project = splitFixture();
  project.transcription.sourceResults[sourceId] = { ...sourceResult([word('old', 100, 500, 'old')]), language: 'ja' };
  const generated = structuredClone(project);
  generated.transcription.language = 'en';
  generated.transcription.words = [word('right-new', 2_100, 2_500, 'new')];
  const restored = reopen(restoreTimelineTranscription(project, generated));
  const edited = setVideoClipLeadingGap(restored, 'right', 500).project;
  assert.deepEqual(edited.transcription.words, [word('right-new', 2_600, 3_000, 'new')]);
  assert.equal(projectPrimaryCaptionLanguage(edited), 'en');
  assert.deepEqual(reopen(edited).transcription.sourceResults, restored.transcription.sourceResults);
});

test('script split/merge preserves transcript identity and valid save snapshots', () => {
  const project = fixture();
  project.transcription.words = [word('whole-one', 100, 400, 'one'), word('whole-two', 500, 800, 'two')];
  project.transcription.wordTiming = 'timeline';
  project.captions = [{ id: 'caption', text: 'one two', startMs: 100, endMs: 800, wordIds: ['whole-one', 'whole-two'] }];
  const split = splitCaptionScriptBlock(project.captions, 'caption', 4, project.transcription.words, 'second');
  assert.ok(split);
  project.captions = split.captions;
  assert.doesNotThrow(() => serializeProjectSnapshot(project));
  const merged = mergeCaptionScriptBlock(project.captions, 'second');
  assert.ok(merged);
  project.captions = merged.captions;
  assert.deepEqual(reopen(project).transcription.words, project.transcription.words);
});

test('all persistence writes validate before database access and editor exit waits for save success', () => {
  const database = readFileSync(new URL('../src/services/database.ts', import.meta.url), 'utf8');
  const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
  assert.match(database, /const snapshot = serializeProjectSnapshot\(project\);[\s\S]*const database = await getDatabase\(\)/);
  assert.match(editor, /const saved = await saveEditorDraft[\s\S]*exitApprovedRef\.current = true;[\s\S]*navigation\.dispatch\(action\)/);
  assert.match(editor, /catch \(caught\) \{\s*exitPromptOpenRef\.current = false;\s*Alert\.alert\('Could not leave the editor'/);
});
