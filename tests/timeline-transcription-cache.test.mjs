import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const compile = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const cacheSource = compile('../src/services/timeline-transcription-cache.ts');
const workflowSource = compile('../src/services/project-workflows.ts');
const uri = 'file:///cache/caption-timeline-transcription-v1.json';
const fingerprint = { algorithm: 'sha256', digest: 'a'.repeat(64) };
const result = (text = 'hello') => ({ modelId: 'fast', sourceFingerprint: fingerprint,
  language: 'en', generatedAt: '2026-09-29T00:00:00Z',
  words: [{ id: 'one', text, startMs: 0, endMs: 100 }] });

function harness() {
  const files = new Map();
  const events = [];
  let failMoveFrom;
  const fs = {
    cacheDirectory: 'file:///cache/',
    async getInfoAsync(path) { return { exists: files.has(path), isDirectory: false,
      size: Buffer.byteLength(files.get(path) ?? '', 'utf8') }; },
    async readAsStringAsync(path) { return files.get(path); },
    async writeAsStringAsync(path, raw) { events.push(['write', path]); files.set(path, raw); },
    async deleteAsync(path) { events.push(['delete', path]); files.delete(path); },
    async moveAsync({ from, to }) {
      events.push(['move', from, to]);
      files.delete(to);
      if (from === failMoveFrom) throw new Error('move interrupted');
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
  function reopen() {
    const exports = {};
    runInNewContext(cacheSource, { exports, JSON, Error, require(name) {
      if (name === 'expo-file-system/legacy') return fs;
      if (name === '@/lib/source-transcription-fingerprint') return {
        canReuseSourceTranscription: (value, model, key) => value?.modelId === model
          && value.sourceFingerprint?.digest === key.digest && Array.isArray(value.words),
      };
      throw new Error(`Unexpected dependency ${name}`);
    } });
    return exports;
  }
  return { files, events, cache: reopen(), reopen, failMove(path) { failMoveFrom = path; } };
}

test('mixed-audio transcripts are scoped to a project and cleared on project deletion', async () => {
  const h = harness();
  await h.cache.writeTimelineTranscription('project-a', fingerprint, result());
  assert.equal((await h.cache.readTimelineTranscription('project-a', fingerprint, 'fast'))?.words[0].text, 'hello');
  assert.equal(await h.cache.readTimelineTranscription('project-b', fingerprint, 'fast'), undefined);

  const exports = {};
  runInNewContext(workflowSource, { exports, Promise, console, require(name) {
    if (name === '@/services/caption-generation-session') return { createCaptionGenerationSession: () => ({}) };
    if (name === '@/services/database') return { deleteProjectRecord: async () => ({ id: 'project-a' }),
      deleteUnreadableProjectRecord: async () => [] };
    if (name === '@/services/timeline-transcription-cache') return h.cache;
    if (name === '@/services/editor-draft-journal') return { clearProjectEditorDraftJournals: async () => {} };
    if (name === '@/services/project-media') return { deleteProjectFiles: async () => {} };
    if (name === '@/services/media-permissions') return { linkedMediaUris: () => [],
      releaseUnreferencedReadPermissions: async () => {} };
    if (name === 'caption-media') return { cancelAudioExtraction() {} };
    return {};
  } });
  await exports.deleteProjectCompletely('project-a');
  assert.equal(await h.reopen().readTimelineTranscription('project-a', fingerprint, 'fast'), undefined);
  await h.cache.writeTimelineTranscription('unreadable', fingerprint, result());
  await exports.deleteUnreadableProjectCompletely('unreadable');
  assert.equal(await h.reopen().readTimelineTranscription('unreadable', fingerprint, 'fast'), undefined);
});

test('oversized UTF-8 transcript never replaces a valid cache', async () => {
  const h = harness();
  await h.cache.writeTimelineTranscription('project-a', fingerprint, result('old'));
  const old = h.files.get(uri);
  await h.cache.writeTimelineTranscription('project-a', fingerprint, result('中'.repeat(1_500_000)));
  assert.equal(h.files.get(uri), old);
  assert.equal((await h.reopen().readTimelineTranscription('project-a', fingerprint, 'fast'))?.words[0].text, 'old');
});

test('interrupted publish keeps the last transcript after restart and retry', async () => {
  const h = harness();
  await h.cache.writeTimelineTranscription('project-a', fingerprint, result('old'));
  h.failMove(`${uri}.writing`);
  await assert.rejects(h.cache.writeTimelineTranscription('project-a', fingerprint, result('new')), /interrupted/);
  assert.equal((await h.reopen().readTimelineTranscription('project-a', fingerprint, 'fast'))?.words[0].text, 'old');
  h.failMove(undefined);
  await h.reopen().writeTimelineTranscription('project-a', fingerprint, result('retry'));
  assert.equal((await h.reopen().readTimelineTranscription('project-a', fingerprint, 'fast'))?.words[0].text, 'retry');
});
