import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { createCaptionGenerationSession, CaptionGenerationCancelledError } from '../src/services/caption-generation-session.ts';

const require = createRequire(import.meta.url);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
function load(name, mocks, extra = '') {
  const source = readFileSync(new URL(`../src/services/${name}.ts`, import.meta.url), 'utf8') + extra;
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)((id) => mocks[id] ?? (id.startsWith('@/') ? {} : require(id)), module, module.exports);
  return module.exports;
}
function filesystem() {
  const data = new Map();
  const hooks = {};
  class Directory {
    constructor(parent, name) { this.uri = `${parent.uri ?? parent}/${name}`; }
    create() {}
  }
  class File {
    constructor(parent, name) { this.parentDirectory = parent; this.name = name; this.uri = `${parent.uri}/${name}`; }
    get exists() { return data.has(this.uri); }
    get size() { return data.get(this.uri)?.length ?? 0; }
    create() { this.write(new Uint8Array()); }
    write(value) { data.set(this.uri, typeof value === 'string' ? new TextEncoder().encode(value) : value); }
    delete() { data.delete(this.uri); }
    async text() { await hooks.text?.(this); return new TextDecoder().decode(data.get(this.uri)); }
    async move(target) { await hooks.move?.(this); data.set(target.uri, data.get(this.uri)); data.delete(this.uri); }
    open() {
      const file = this;
      return {
        offset: 0, get size() { return file.size; },
        readBytes(count) { const bytes = data.get(file.uri).slice(this.offset, this.offset + count); this.offset += bytes.length; return bytes; },
        writeBytes(bytes) {
          const old = data.get(file.uri);
          const next = new Uint8Array(Math.max(old.length, this.offset + bytes.length));
          next.set(old); next.set(bytes, this.offset); data.set(file.uri, next); this.offset += bytes.length;
          hooks.write?.(file);
        },
        close() {},
      };
    }
  }
  return { File, Directory, Paths: { cache: 'cache', document: 'document' }, FileMode: { ReadOnly: 'r', WriteOnly: 'w' }, data, hooks };
}
function transcriptionHarness(native = {}) {
  const fs = filesystem();
  const service = load('transcription', {
    'expo-file-system': fs, 'whisper.rn/index': native,
    'caption-media': { getMediaInfo: async () => ({ hasAudio: true }), extractAudioToWav: async () => {} },
    '@/lib/media-validation': { assertCaptionAudioAvailable: () => {} },
    '@/services/storage-policy': { requireFreeSpace: async () => {} },
    '@/lib/wav-chunking': require('../src/lib/wav-chunking.ts'),
    '@/lib/speech-alignment': require('../src/lib/speech-alignment.ts'),
  }, `
export { ensureModel, detectSpeechCooperatively };
export function configure(h) {
  if (h.downloadModel) downloadModel = h.downloadModel;
  if (h.reservation) modelReplacementReservation = h.reservation;
  if (h.ensureModel) ensureModel = h.ensureModel;
  if (h.ensureVadModel) ensureVadModel = h.ensureVadModel;
  if (h.detectSpeech) detectSpeechCooperatively = h.detectSpeech;
  obsoleteModelsPruned = true;
}`);
  service.configure({ reservation: async () => ({ bytes: 0 }), ensureVadModel: async () => ({ uri: 'vad' }), detectSpeech: async () => [{ t0: 0, t1: 100 }] });
  return { ...service, fs };
}
const options = { projectId: 'test', videoUri: 'video', durationMs: 1000 };

test('failed model preparation cannot leave a sibling VAD download running', async () => {
  const h = transcriptionHarness();
  let vadStarts = 0;
  h.configure({ ensureModel: async () => { throw new Error('model failed'); }, ensureVadModel: async () => { vadStarts += 1; return new Promise(() => {}); } });
  await assert.rejects(h.transcribeVideoLocally(options), /model failed/);
  assert.equal(vadStarts, 0);
});

test('a retry waits for the previous model writer and acquires its own cancellation owner', async () => {
  const h = transcriptionHarness();
  const first = deferred();
  const owners = [];
  const ownerA = { throwIfCancelled() {} }, ownerB = { throwIfCancelled() {} };
  h.configure({ downloadModel: async (_progress, session) => { owners.push(session); if (owners.length === 1) return first.promise; return { uri: 'retry' }; } });
  const a = h.ensureModel(undefined, ownerA);
  const b = h.ensureModel(undefined, ownerB);
  const failure = assert.rejects(a, /first failed/);
  const result = b.then((value) => ({ value }), (error) => ({ error }));
  assert.equal(owners.length, 1);
  first.reject(new Error('first failed'));
  await failure;
  assert.deepEqual(await result, { value: { uri: 'retry' } });
  assert.deepEqual(owners, [ownerA, ownerB]);
});

test('cancel during Whisper initialization releases without starting transcription', async () => {
  const init = deferred(), entered = deferred();
  let starts = 0, releases = 0;
  const h = transcriptionHarness({ initWhisperVad: async () => ({ release: async () => {} }), initWhisper: async () => { entered.resolve(); return init.promise; } });
  h.configure({ ensureModel: async () => ({ uri: 'model' }) });
  const session = createCaptionGenerationSession(async () => {});
  const running = session.run((context) => h.transcribeVideoLocally({ ...options, session: context }));
  const rejected = assert.rejects(running, CaptionGenerationCancelledError);
  await entered.promise;
  const cancellation = await session.cancel();
  let finished = false;
  void cancellation.finished.then(() => { finished = true; });
  init.resolve({ transcribe: () => { starts += 1; return { promise: Promise.resolve({ isAborted: true }), stop: async () => {} }; }, release: async () => { releases += 1; } });
  await rejected;
  await cancellation.finished;
  assert.equal(starts, 0);
  assert.equal(releases, 1);
  assert.equal(finished, true);
});

test('stopper registration failure stops and observes transcription before release', async () => {
  const nativeWork = deferred(), started = deferred();
  let stopped = 0, released = 0;
  const h = transcriptionHarness({ initWhisperVad: async () => ({ release: async () => {} }), initWhisper: async () => ({
    transcribe: () => { started.resolve(); return { promise: nativeWork.promise, stop: async () => { stopped += 1; } }; },
    release: async () => { released += 1; },
  }) });
  h.configure({ ensureModel: async () => ({ uri: 'model' }) });
  const running = h.transcribeVideoLocally({ ...options, session: { throwIfCancelled() {}, registerStopper() { throw new Error('registration failed'); } } });
  const rejection = assert.rejects(running, /registration failed/);
  await started.promise;
  await tick();
  const earlyRelease = released;
  nativeWork.reject(new Error('native work terminated'));
  await rejection;
  assert.equal(stopped, 1);
  assert.equal(earlyRelease, 0);
  assert.equal(released, 1);
});

test('cancelled work returning normally is never reported as successful', async () => {
  const held = deferred();
  const session = createCaptionGenerationSession(async () => {});
  const running = session.run(async () => held.promise);
  const rejection = assert.rejects(running, CaptionGenerationCancelledError);
  await session.cancel();
  held.resolve('false completion');
  await rejection;
});

test('stop failure remains explicit on the work result after natural termination', async () => {
  const held = deferred();
  const stopError = new Error('Whisper abort unavailable');
  const session = createCaptionGenerationSession(async () => {});
  const running = session.run(async (context) => { context.registerStopper(async () => { throw stopError; }); await held.promise; context.throwIfCancelled(); });
  const rejection = assert.rejects(running, (error) => error.name === 'CaptionGenerationStopError' && error.failures.includes(stopError));
  assert.equal((await session.cancel()).status, 'stop-failed');
  held.resolve();
  await rejection;
});

test('overlapping VAD slices merge continuous speech without duplicate seam windows', async () => {
  const fs = filesystem();
  const wav = require('../src/lib/wav-chunking.ts');
  const h = load('transcription', { 'expo-file-system': fs, 'whisper.rn/index': {}, 'caption-media': {}, '@/lib/wav-chunking': wav, '@/lib/speech-alignment': require('../src/lib/speech-alignment.ts') }, '\nexport { detectSpeechCooperatively };');
  const audio = new fs.File({ uri: 'cache' }, 'audio.wav');
  audio.write(wav.buildPcm16MonoWave(new Uint8Array(18 * 32000), 16000));
  let calls = 0;
  const segments = await h.detectSpeechCooperatively({ detectSpeech: async () => { calls += 1; return calls === 1 ? [{ t0: 785, t1: 1000 }] : [{ t0: 0, t1: 1000 }]; } }, audio);
  assert.equal(calls, 2);
  assert.deepEqual(segments, [{ t0: 785, t1: 1800 }]);
});

function downloadHarness(bytes = 2 * 1024 * 1024) {
  const fs = filesystem();
  const resume = require('../src/lib/model-download-resume.ts');
  const h = load('verified-model-download', { 'expo-file-system': fs, '@/lib/model-download-resume': resume, '@/lib/model-artifact-lifecycle': require('../src/lib/model-artifact-lifecycle.ts') });
  const target = new fs.File({ uri: 'file:///models' }, 'model.bin');
  const descriptor = { downloadUrl: 'https://example.invalid/model', downloadBytes: bytes, sha256: 'a'.repeat(64) };
  const file = (suffix) => new fs.File(target.parentDirectory, target.name + suffix);
  const identity = { url: descriptor.downloadUrl, fileUri: file('.download').uri, expectedBytes: bytes, sha256: descriptor.sha256 };
  const seed = () => { file('.download').create(); file('.download.resume.json').write(resume.encodeModelDownloadCheckpoint(identity, 0)); file('.download.chunk').write(new Uint8Array(bytes)); file('.download.chunk.offset').write('0'); };
  return { ...h, fs, target, descriptor, file, seed };
}

test('copy yields to cancellation events and retains bytes for retry', async () => {
  const h = downloadHarness(); h.seed();
  let pause, writes = 0;
  h.fs.hooks.write = () => { writes += 1; if (writes === 1) setTimeout(() => void pause(), 0); };
  await assert.rejects(h.downloadVerifiedModel({ target: h.target, descriptor: h.descriptor, verifySha256: async () => h.descriptor.sha256, registerPauser: (callback) => { pause = callback; return () => {}; } }), h.ModelDownloadPausedError);
  assert.equal(writes, 1);
  assert.equal(h.file('.download.chunk').exists, true);
  h.fs.hooks.write = undefined;
  await h.downloadVerifiedModel({ target: h.target, descriptor: h.descriptor, verifySha256: async () => h.descriptor.sha256 });
  assert.equal(h.target.size, h.descriptor.downloadBytes);
});

test('an already paused checkpoint is retained before any invalid-state cleanup', async () => {
  const h = downloadHarness(16);
  h.file('.download').write(new Uint8Array(8));
  h.file('.download.resume.json').write('invalid checkpoint');
  await assert.rejects(h.downloadVerifiedModel({ target: h.target, descriptor: h.descriptor, verifySha256: async () => h.descriptor.sha256, registerPauser: (pause) => { void pause(); return () => {}; } }), h.ModelDownloadPausedError);
  assert.equal(h.file('.download').size, 8);
  assert.equal(await h.file('.download.resume.json').text(), 'invalid checkpoint');
});

test('reservation hash cancellation retains complete temporary artifacts', async () => {
  const h = downloadHarness(16);
  h.file('.download').write(new Uint8Array(16));
  let cancelled = false;
  await assert.rejects(h.resumableModelDownloadReservation(h.target, h.descriptor, async () => { cancelled = true; return 'bad hash'; }, () => { if (cancelled) throw new CaptionGenerationCancelledError(); }), CaptionGenerationCancelledError);
  assert.equal(h.file('.download').size, 16);
});

test('hash cancellation keeps session stopping until hash work actually exits', async () => {
  const h = downloadHarness(16);
  h.file('.download').write(new Uint8Array(16));
  const hash = deferred(), entered = deferred();
  const session = createCaptionGenerationSession(async () => {});
  const running = session.run((context) => h.downloadVerifiedModel({ target: h.target, descriptor: h.descriptor, registerPauser: (pause) => context.registerStopper(pause), verifySha256: async () => { entered.resolve(); return hash.promise; } }));
  const rejection = assert.rejects(running, h.ModelDownloadPausedError);
  await entered.promise;
  const cancellation = await session.cancel();
  let finished = false;
  void cancellation.finished.then(() => { finished = true; });
  await tick();
  assert.equal(finished, false);
  await assert.rejects(session.run(async () => {}), /already underway/);
  hash.resolve(h.descriptor.sha256);
  await rejection; await cancellation.finished;
  assert.equal(h.file('.download').size, 16);
  assert.equal(h.target.exists, false);
});

test('cancellation during promotion awaits the move and cannot report a successful download', async () => {
  const h = downloadHarness(16);
  h.file('.download').write(new Uint8Array(16));
  const move = deferred(), entered = deferred();
  let pause;
  h.fs.hooks.move = async () => { entered.resolve(); await move.promise; };
  const running = h.downloadVerifiedModel({ target: h.target, descriptor: h.descriptor, verifySha256: async () => h.descriptor.sha256, registerPauser: (callback) => { pause = callback; return () => {}; } });
  const outcome = running.then(() => ({ success: true }), (error) => ({ error }));
  await entered.promise;
  await pause();
  let exited = false;
  void outcome.then(() => { exited = true; });
  await tick();
  assert.equal(exited, false);
  move.resolve();
  assert.ok((await outcome).error instanceof h.ModelDownloadPausedError);
  assert.equal(h.target.size, 16);
});

test('a failing Whisper initialization remains explicit when cancellation races it', async () => {
  const init = deferred(), entered = deferred();
  const failure = new Error('Whisper initialization failed');
  const h = transcriptionHarness({ initWhisperVad: async () => ({ release: async () => {} }), initWhisper: async () => { entered.resolve(); return init.promise; } });
  h.configure({ ensureModel: async () => ({ uri: 'model' }) });
  const session = createCaptionGenerationSession(async () => {});
  const running = session.run((context) => h.transcribeVideoLocally({ ...options, session: context }));
  const rejected = assert.rejects(running, (error) => error === failure);
  await entered.promise;
  const cancellation = await session.cancel();
  init.reject(failure);
  await rejected; await cancellation.finished;
});

test('failed registration and failed native stop remain explicit after native termination', async () => {
  const nativeWork = deferred(), started = deferred();
  const setupError = new Error('registration failed'), stopError = new Error('stop failed');
  let releases = 0;
  const h = transcriptionHarness({ initWhisperVad: async () => ({ release: async () => {} }), initWhisper: async () => ({
    transcribe: () => { started.resolve(); return { promise: nativeWork.promise, stop: async () => { throw stopError; } }; },
    release: async () => { releases += 1; },
  }) });
  h.configure({ ensureModel: async () => ({ uri: 'model' }) });
  const running = h.transcribeVideoLocally({ ...options, session: { throwIfCancelled() {}, registerStopper() { throw setupError; } } });
  const rejected = assert.rejects(running, (error) => error instanceof AggregateError && error.errors.includes(setupError) && error.errors.includes(stopError));
  await started.promise; await tick();
  assert.equal(releases, 0);
  nativeWork.reject(new Error('native transcription terminated'));
  await rejected;
  assert.equal(releases, 1);
});

test('VAD cancellation waits for the current bounded native slice and skips later slices', async () => {
  const fs = filesystem(), wav = require('../src/lib/wav-chunking.ts');
  const h = load('transcription', { 'expo-file-system': fs, 'whisper.rn/index': {}, 'caption-media': {}, '@/lib/wav-chunking': wav, '@/lib/speech-alignment': require('../src/lib/speech-alignment.ts') }, '\nexport { detectSpeechCooperatively };');
  const audio = new fs.File({ uri: 'cache' }, 'audio.wav');
  audio.write(wav.buildPcm16MonoWave(new Uint8Array(18 * 32000), 16000));
  const slice = deferred(), entered = deferred();
  let calls = 0, releases = 0;
  const session = createCaptionGenerationSession(async () => {});
  const running = session.run(async (context) => {
    try {
      return await h.detectSpeechCooperatively({ detectSpeech: async (uri, options) => {
        calls += 1;
        assert.ok(fs.data.get(uri).length <= 10 * 32000 + 44);
        assert.equal(options.minSpeechDurationMs, 180);
        assert.equal(options.minSilenceDurationMs, 280);
        entered.resolve(); return slice.promise;
      } }, audio, undefined, context);
    } finally { releases += 1; }
  });
  const rejected = assert.rejects(running, CaptionGenerationCancelledError);
  await entered.promise;
  const cancellation = await session.cancel();
  let finished = false;
  void cancellation.finished.then(() => { finished = true; });
  await tick();
  assert.equal(releases, 0); assert.equal(finished, false);
  slice.resolve([{ t0: 1, t1: 20 }]);
  await rejected; await cancellation.finished;
  assert.equal(calls, 1); assert.equal(releases, 1);
  assert.equal([...fs.data.keys()].some((uri) => uri.includes('.vad-')), false);
});

test('VAD overlap retains a short seam utterance and does not fill a real silence gap', async () => {
  const fs = filesystem(), wav = require('../src/lib/wav-chunking.ts');
  const alignment = require('../src/lib/speech-alignment.ts');
  const h = load('transcription', { 'expo-file-system': fs, 'whisper.rn/index': {}, 'caption-media': {}, '@/lib/wav-chunking': wav, '@/lib/speech-alignment': alignment }, '\nexport { detectSpeechCooperatively };');
  const audio = new fs.File({ uri: 'cache' }, 'audio.wav');
  audio.write(wav.buildPcm16MonoWave(new Uint8Array(18 * 32000), 16000));
  let calls = 0;
  const segments = await h.detectSpeechCooperatively({ detectSpeech: async () => ++calls === 1 ? [{ t0: 700, t1: 720 }, { t0: 785, t1: 815 }] : [{ t0: 200, t1: 220 }] }, audio);
  assert.deepEqual(segments, [{ t0: 700, t1: 720 }, { t0: 785, t1: 815 }, { t0: 1000, t1: 1020 }]);
  const words = alignment.alignWordsToSpeech([{ id: 'seam', text: 'hello', startMs: 7900, endMs: 8120 }, { id: 'silence', text: 'noise', startMs: 9000, endMs: 9200 }], segments);
  assert.equal(words.length, 1);
  assert.equal(words[0].endMs, 8120);
});
