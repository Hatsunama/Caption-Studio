import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const { encodeModelDownloadCheckpoint, decodeModelDownloadCheckpoint } = require('../src/lib/model-download-resume.ts');
const resume = require('../src/lib/model-download-resume.ts');
const artifacts = require('../src/lib/model-artifact-lifecycle.ts');
const CHUNK = 8 * 1024 * 1024;
const descriptor = { downloadUrl: 'https://example.invalid/model', downloadBytes: CHUNK, sha256: 'a'.repeat(64) };

function loadService(path, mocks, extra = '') {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8') + extra;
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)((id) => mocks[id] ?? (id.startsWith('@/') ? {} : require(id)), module, module.exports);
  return module.exports;
}

function fileSystem() {
  const files = new Map();
  let onWriteBytes;
  let onText;
  class File {
    constructor(parent, name) {
      this.name = name;
      this.parentDirectory = parent;
      this.uri = `${parent.uri}/${name}`;
    }
    get exists() { return files.has(this.uri); }
    get size() { return files.get(this.uri)?.length ?? 0; }
    create() { files.set(this.uri, new Uint8Array()); }
    delete() { files.delete(this.uri); }
    async text() { await onText?.(this); return new TextDecoder().decode(files.get(this.uri)); }
    write(value) { files.set(this.uri, typeof value === 'string' ? new TextEncoder().encode(value) : value); }
    async move(destination) { files.set(destination.uri, files.get(this.uri)); files.delete(this.uri); }
    open(mode) {
      const file = this;
      return {
        offset: 0,
        get size() { return file.size; },
        readBytes(count) {
          const result = files.get(file.uri).slice(this.offset, this.offset + count);
          this.offset += result.length;
          return result;
        },
        writeBytes(bytes) {
          const current = files.get(file.uri);
          const next = new Uint8Array(Math.max(current.length, this.offset + bytes.length));
          next.set(current);
          next.set(bytes, this.offset);
          files.set(file.uri, next);
          this.offset += bytes.length;
          onWriteBytes?.(file);
        },
        close() {},
      };
    }
  }
  const parent = { uri: 'file:///models' };
  const target = new File(parent, 'model.bin');
  const sidecar = (suffix) => new File(parent, `model.bin${suffix}`);
  return { File, files, target, sidecar, setOnWriteBytes: (callback) => { onWriteBytes = callback; }, setOnText: (callback) => { onText = callback; } };
}

function downloadHarness() {
  const fs = fileSystem();
  const service = loadService('../src/services/verified-model-download.ts', {
    'expo-file-system': { File: fs.File, FileMode: { ReadOnly: 'r', WriteOnly: 'w' } },
    '@/lib/model-download-resume': resume,
    '@/lib/model-artifact-lifecycle': artifacts,
  });
  const identity = { url: descriptor.downloadUrl, fileUri: fs.sidecar('.download').uri, expectedBytes: CHUNK, sha256: descriptor.sha256 };
  const checkpoint = () => decodeModelDownloadCheckpoint(new TextDecoder().decode(fs.files.get(fs.sidecar('.download.resume.json').uri)), identity);
  return { ...fs, ...service, identity, checkpoint };
}

test('cancellation during checkpoint read stops before a range request and retains the checkpoint', async () => {
  const h = downloadHarness();
  h.sidecar('.download').write(new Uint8Array(1024));
  h.sidecar('.download.resume.json').write(encodeModelDownloadCheckpoint(h.identity, 1024));
  let pause;
  let requests = 0;
  h.setOnText(async (file) => { if (file.name.endsWith('.resume.json')) await pause?.(); });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { requests += 1; throw new Error('unexpected fetch'); };
  try {
    await assert.rejects(h.downloadVerifiedModel({ target: h.target, descriptor, verifySha256: async () => descriptor.sha256, registerPauser: (callback) => { pause = callback; return () => {}; } }), h.ModelDownloadPausedError);
    assert.equal(requests, 0);
    assert.equal(h.checkpoint(), 1024);
    assert.equal(h.sidecar('.download').size, 1024);
  } finally { globalThis.fetch = originalFetch; }
});

test('cancellation during chunk append preserves a resumable chunk and retry verifies before replacement', async () => {
  const h = downloadHarness();
  let pause;
  let writes = 0;
  h.setOnWriteBytes((file) => { if (file.name === 'model.bin.download' && ++writes === 1) void pause(); });
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return { status: 206, headers: { get: () => `bytes 0-${CHUNK - 1}/${CHUNK}` }, arrayBuffer: async () => new Uint8Array(CHUNK).buffer };
  };
  try {
    await assert.rejects(h.downloadVerifiedModel({ target: h.target, descriptor, verifySha256: async () => descriptor.sha256, registerPauser: (callback) => { pause = callback; return () => {}; } }), h.ModelDownloadPausedError);
    assert.equal(writes, 1);
    assert.equal(h.checkpoint(), 0);
    assert.equal(h.sidecar('.download.chunk').size, CHUNK);
    h.setOnWriteBytes(undefined);
    let hashes = 0;
    await h.downloadVerifiedModel({ target: h.target, descriptor, verifySha256: async () => { hashes += 1; return descriptor.sha256; } });
    assert.equal(requests, 1);
    assert.equal(hashes, 1);
    assert.equal(h.target.size, CHUNK);
  } finally { globalThis.fetch = originalFetch; }
});

test('cancellation during final SHA leaves complete temporary bytes for verified retry', async () => {
  const h = downloadHarness();
  h.sidecar('.download').write(new Uint8Array());
  h.sidecar('.download.resume.json').write(encodeModelDownloadCheckpoint(h.identity, 0));
  h.sidecar('.download.chunk').write(new Uint8Array(CHUNK));
  h.sidecar('.download.chunk.offset').write('0');
  let pause;
  await assert.rejects(h.downloadVerifiedModel({ target: h.target, descriptor, verifySha256: async () => { await pause(); return descriptor.sha256; }, registerPauser: (callback) => { pause = callback; return () => {}; } }), h.ModelDownloadPausedError);
  assert.equal(h.target.exists, false);
  assert.equal(h.sidecar('.download').size, CHUNK);
  await h.downloadVerifiedModel({ target: h.target, descriptor, verifySha256: async () => descriptor.sha256 });
  assert.equal(h.target.size, CHUNK);
});

test('VAD cancellation during temporary chunk write skips native detection and removes the chunk', async () => {
  const h = fileSystem();
  let cancelled = false;
  let detects = 0;
  const source = new h.File(h.target.parentDirectory, 'audio.wav');
  source.write(new Uint8Array(48));
  const service = loadService('../src/services/transcription.ts', {
    'expo-file-system': { File: h.File, FileMode: { ReadOnly: 'r' } },
    'whisper.rn/index': {},
    'caption-media': {},
    '@/lib/wav-chunking': {
      parseCaptionPcmWave: () => ({ dataOffset: 44, dataBytes: 4, bytesPerSecond: 32000, sampleRate: 16000 }),
      planOverlappingPcmChunks: () => [{ start: 0, end: 4 }],
      buildPcm16MonoWave: (pcm) => pcm,
    },
  }, '\nexport { detectSpeechCooperatively };');
  const originalWrite = h.File.prototype.write;
  h.File.prototype.write = function (bytes) { originalWrite.call(this, bytes); if (this.name.startsWith('.vad-')) cancelled = true; };
  const session = { throwIfCancelled: () => { if (cancelled) throw new Error('cancelled'); } };
  await assert.rejects(service.detectSpeechCooperatively({ detectSpeech: async () => { detects += 1; return []; } }, source, undefined, session), /cancelled/);
  assert.equal(detects, 0);
  assert.equal([...h.files.keys()].some((uri) => uri.includes('.vad-')), false);
});
