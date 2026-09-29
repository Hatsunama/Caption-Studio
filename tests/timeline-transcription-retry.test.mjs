import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

test('a grouping failure reuses completed audible-timeline transcription on retry', async () => {
  const source = readFileSync(new URL('../src/services/project-transcription.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const digest = 'a'.repeat(64);
  const cached = new Map();
  let transcriptions = 0;
  let groupingAttempts = 0;
  const project = {
    id: 'project', clips: [{ id: 'clip', sourceId: 'source' }],
    sources: [{ id: 'source', uri: 'file:///source.mp4', durationMs: 1_000 }],
    transcription: { sourceResults: {}, words: [] }, captions: [], captionTracks: {},
  };
  const synthetic = {
    ...project,
    clips: [{ id: 'clip', sourceId: 'mix' }],
    sources: [{ id: 'mix', uri: 'file:///mixed.m4a', durationMs: 1_000 }],
  };
  const words = [{ id: 'word', text: 'Hello.', startMs: 0, endMs: 200 }];
  const mocks = {
    '@/services/timeline-audio-render': {
      async createTimelineTranscriptionSession() {
        return { project: synthetic, restore: (value) => value, dispose() {} };
      },
    },
    'caption-media': { __esModule: true, default: { async sha256() { return digest; } } },
    '@/lib/caption-grouping': {
      groupingOptionsForLanguage: () => ({}),
      groupTimelineWordsByClip() {
        groupingAttempts += 1;
        if (groupingAttempts === 1) throw new Error('grouping failed');
        return [{ id: 'caption', text: 'Hello.', startMs: 0, endMs: 200, wordIds: ['clip-word'] }];
      },
    },
    '@/lib/caption-tracks': { synchronizeCaptionTracksAfterTranscription: () => ({}) },
    '@/lib/caption-languages': { canonicalCaptionLanguageTag: (value) => value },
    '@/lib/source-transcription-fingerprint': {
      createSourceTranscriptionFingerprint: (value) => ({ algorithm: 'sha256', digest: value }),
      canReuseSourceTranscription: (result, model, fingerprint) => result?.modelId === model
        && result.sourceFingerprint?.digest === fingerprint.digest,
    },
    '@/lib/video-timeline': {
      mapSourceWordsToTimeline: () => [{ ...words[0], id: 'clip-word' }],
      anchorCaptionsToClips: (captions) => captions,
    },
    '@/lib/primary-caption-timing': { canonicalizeSourceWords: (value) => value },
    '@/lib/caption-audio-route': { shouldTranscribeAudibleTimeline: () => true },
    '@/services/transcription': {
      async transcribeVideoLocally() { transcriptions += 1; return { words, language: 'en' }; },
    },
    '@/services/timeline-transcription-cache': {
      async readTimelineTranscription(projectId, fingerprint, modelId) {
        return cached.get(`${projectId}:${modelId}:${fingerprint.digest}`);
      },
      async writeTimelineTranscription(projectId, fingerprint, result) {
        cached.set(`${projectId}:${result.modelId}:${fingerprint.digest}`, result);
      },
    },
  };
  const module = { exports: {} };
  runInNewContext(compiled, { module, exports: module.exports, require(id) {
    if (!(id in mocks)) throw new Error(`Unexpected import ${id}`);
    return mocks[id];
  }, Date, Error });
  const { generateProjectCaptions } = module.exports;
  await assert.rejects(generateProjectCaptions(project, 'fast'), /grouping failed/);
  await generateProjectCaptions(project, 'fast');
  assert.equal(transcriptions, 1);
  assert.equal(groupingAttempts, 2);
});
