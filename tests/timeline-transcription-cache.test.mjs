import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { coalesceWhisperWords } from '../src/lib/whisper-words.ts';
import { alignWordsToSpeech } from '../src/lib/speech-alignment.ts';
import { canReuseSourceTranscription, createSourceTranscriptionFingerprint } from '../src/lib/source-transcription-fingerprint.ts';

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
        canReuseSourceTranscription,
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

test('duration bounds apply to current, previous and write routes without rewriting saved cache', async () => {
  const h = harness();
  const record = (value) => JSON.stringify({ version: 2, projectId: 'project-a', result: value });
  const outside = { ...result('outside'), words: [{ id: 'tail', text: 'outside', startMs: 100, endMs: 110 }] };
  h.files.set(uri, record(outside));
  h.files.set(`${uri}.previous`, record(result('bounded')));
  assert.equal((await h.cache.readTimelineTranscription('project-a', fingerprint, 'fast', 100))?.words[0].text, 'bounded');
  h.files.set(`${uri}.previous`, record(outside));
  const original = new Map(h.files);
  assert.equal(await h.cache.readTimelineTranscription('project-a', fingerprint, 'fast', 100), undefined);
  await h.cache.writeTimelineTranscription('project-a', fingerprint, outside, 100);
  assert.deepEqual(h.files, original);
  assert.deepEqual(h.events, []);
  assert.equal((await h.cache.readTimelineTranscription('project-a', fingerprint, 'fast', 110))?.words[0].text, 'outside');
});

test('previous alignment revision misses both disk copies without deleting them', async () => {
  const h = harness();
  const old = createSourceTranscriptionFingerprint('a'.repeat(64), '2'.repeat(64));
  const current = createSourceTranscriptionFingerprint('a'.repeat(64));
  for (const path of [uri, `${uri}.previous`]) h.files.set(path, JSON.stringify({ version: 2, projectId: 'project-a', result: { ...result(), sourceFingerprint: old } }));
  const original = new Map(h.files);
  assert.equal(await h.cache.readTimelineTranscription('project-a', current, 'fast', 1000), undefined);
  assert.deepEqual(h.files, original);
  assert.deepEqual(h.events, []);
  assert.deepEqual(current, createSourceTranscriptionFingerprint('a'.repeat(64), '3'.repeat(64)));
});

test('oversized UTF-8 transcript never replaces a valid cache', async () => {
  const h = harness();
  await h.cache.writeTimelineTranscription('project-a', fingerprint, result('old'));
  const old = h.files.get(uri);
  const oversized = '\u4e2d'.repeat(1_500_000);
  assert.ok(oversized.length < 4 * 1024 * 1024, 'fixture must stay below the character limit');
  assert.ok(Buffer.byteLength(oversized, 'utf8') > 4 * 1024 * 1024, 'UTF-8 bytes must exceed the bound');
  await h.cache.writeTimelineTranscription('project-a', fingerprint, result(oversized));
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

test('revision 3 fractional chain survives cache persistence and corrupt-current fallback', async () => {
  const h = harness();
  const current = createSourceTranscriptionFingerprint('a'.repeat(64));
  const words = alignWordsToSpeech(coalesceWhisperWords([
    { text: ' a b ' + 'c'.repeat(99), t0: 400, t1: 401 },
  ]), [{ t0: 0, t1: 500 }], 5000);
  assert.ok(words.some(w => !Number.isInteger(w.startMs)));
  const value = { ...result(), sourceFingerprint: current, words };
  await h.cache.writeTimelineTranscription('project-a', current, value, 5000);
  const saved = JSON.parse(h.files.get(uri));
  assert.equal(saved.version, 2, 'cache schema remains unchanged');
  assert.deepEqual(saved.result.words, words);
  assert.deepEqual(JSON.parse(JSON.stringify(await h.reopen().readTimelineTranscription('project-a', current, 'fast', 5000))), value);
  h.files.set(`${uri}.previous`, h.files.get(uri));
  h.files.set(uri, '{corrupt');
  const original = new Map(h.files);
  h.events.length = 0;
  assert.deepEqual(JSON.parse(JSON.stringify(await h.reopen().readTimelineTranscription('project-a', current, 'fast', 5000))), value);
  assert.deepEqual(h.files, original);
  assert.deepEqual(h.events, []);
});
