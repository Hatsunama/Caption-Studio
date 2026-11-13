import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { posix } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const secret = 'PRIVATE transcript file:///private/project.wav word-id';
const secretToken = ' PRIVATE_file:///private/project.wav_word-id';
const prefix = '[asr-timing-failure-v1]';

// Execute the actual service and timing modules; replace only native IO and
// model preparation. In particular, do not mock the diagnostic or alignment.
function harness({ segments = [], speech = [{ t0: 0, t1: 810 }], nativeError,
  aborted = false, cancel = false, releaseError, loggerThrows = false, decoded = {} } = {}) {
  const logs = [], events = [], data = new Map(), modules = new Map();
  class Directory {
    constructor(parent, name) { this.uri = `${parent.uri ?? parent}/${name}`; }
    create() {}
  }
  class File {
    constructor(parent, name) { this.uri = `${parent.uri}/${name}`; }
    get exists() { return data.has(this.uri); }
    delete() { events.push('delete'); data.delete(this.uri); }
  }
  const mocks = {
    'expo-file-system': { Directory, File, Paths: { cache: 'cache', document: 'document' } },
    'caption-media': {
      getMediaInfo: async () => ({ hasAudio: true }),
      extractAudioToWav: async (_uri, outputUri) => {
        data.set(outputUri, true);
        return { durationMs: 8128, pcmBytes: 260096, sampleRate: 16000, channelCount: 1,
          outputUri: secret, insertedSilenceMs: secret, extra: secret, ...decoded };
      },
    },
    'whisper.rn/index': {
      initWhisperVad: async () => ({ release: async () => events.push('vad-release') }),
      initWhisper: async () => ({
        transcribe: () => ({ stop: async () => {}, promise: nativeError
          ? Promise.reject(nativeError) : Promise.resolve({ segments, language: 'en', isAborted: aborted }) }),
        release: async () => { events.push('asr-release'); if (releaseError) throw releaseError; },
      }),
    },
    '@/services/storage-policy': { requireFreeSpace: async () => {} },
  };
  function load(id) {
    if (mocks[id]) return mocks[id];
    if (!id.startsWith('@/')) return require(id);
    if (modules.has(id)) return modules.get(id);
    let source = readFileSync(new URL(`../src/${id.slice(2)}.ts`, import.meta.url), 'utf8');
    if (id === '@/services/transcription') source += `
      modelReplacementReservation = async () => ({bytes: 0});
      ensureModel = ensureVadModel = async () => ({uri: 'model'});
      detectSpeechCooperatively = async () => ${JSON.stringify(speech)};
      export function modelUsers() { return activeModelUsers; }
    `;
    const code = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText;
    const module = { exports: {} };
    modules.set(id, module.exports);
    const record = (...args) => { logs.push(args); if (loggerThrows) throw new Error(secret); };
    const localRequire = spec => load(spec.startsWith('.')
      ? '@/' + posix.normalize(posix.join(posix.dirname(id.slice(2)), spec)) : spec);
    new Function('require', 'module', 'exports', 'console', code)(localRequire, module, module.exports,
      { warn: record, error: record, info: record, log: record });
    return module.exports;
  }
  const service = load('@/services/transcription');
  const session = { throwIfCancelled() { if (cancel && events.includes('vad-release')) throw new Error(secret); },
    registerStopper() { return () => events.push('unregister'); } };
  return { load, logs, events, data, service,
    run: () => service.transcribeVideoLocally({ projectId: secret, videoUri: secret, durationMs: 8000, session }) };
}

function payload(h, expectedDecoded = { durationMs: 8128, pcmBytes: 260096, sampleRate: 16000, channelCount: 1 }) {
  assert.equal(h.logs.length, 1, 'actual failed service must log exactly once');
  assert.equal(h.logs[0].length, 1, 'one bounded line, no extra error arguments');
  const line = h.logs[0][0];
  assert.ok(line.startsWith(prefix + ' '));
  assert.ok(Buffer.byteLength(line) <= 2048);
  assert.ok(!line.includes('PRIVATE') && !line.includes('file:') && !line.includes('word-id'));
  const value = JSON.parse(line.slice(prefix.length + 1));
  function numericOnly(node) {
    if (node === null || typeof node === 'boolean') return;
    if (typeof node === 'number') { assert.ok(Number.isFinite(node)); return; }
    assert.equal(typeof node, 'object', 'no content-bearing scalar');
    for (const child of Object.values(node)) numericOnly(child);
  }
  numericOnly(value);
  assert.deepEqual(value.decoded, expectedDecoded);
  assert.equal(value.durationMs, 8000);
  return value;
}
function cleaned(h, asr = true) {
  assert.equal(h.data.size, 0);
  assert.equal(h.service.modelUsers(), 0);
  assert.equal(h.events.filter(x => x === 'vad-release').length, 1);
  assert.equal(h.events.filter(x => x === 'asr-release').length, Number(asr));
}

for (const [name, segments, speech, expected] of [
  ['clipping tie', [[90, 140], [100, 150]], [{ t0: 120, t1: 200 }],
    { before: [900, 1000], after: [1200, 1200], capped: 1200, index: 0 }],
  ['equal coalesced onsets', [[120, 140], [120, 150]], [{ t0: 120, t1: 200 }],
    { before: [1200, 1200], after: [1200, 1200], capped: 1200, index: 0 }],
  ['onset outside logical D', [[801, 805]], [{ t0: 0, t1: 810 }],
    { before: [8010], after: [8010], capped: 8000, index: 0 }],
]) {
  test(`actual service connects numeric failure diagnostic: ${name}`, async () => {
    // Leading filtered word ensures accepted and coalesced ordinals differ.
    const h = harness({ segments: [{ text: secretToken, t0: 900, t1: 910 },
      ...segments.map(([t0, t1]) => ({ text: secretToken, t0, t1 }))], speech });
    await assert.rejects(h.run(), { message: 'Source word timing quality failure for word-1' });
    const d = payload(h);
    assert.equal(d.acceptedIndex, expected.index);
    assert.equal(d.acceptedCount, segments.length);
    assert.equal(d.previous, null);
    assert.equal(d.current.startMs, expected.after[0]);
    assert.equal(d.cappedEndMs, expected.capped);
    assert.equal(d.rejected.nonpositiveCappedSupport, true);
    assert.equal(d.rejected.startOutsideDuration, name === 'onset outside logical D');
    for (const [i, key] of ['currentOrigin', 'nextOrigin'].entries()) {
      if (i >= segments.length) { assert.equal(d[key], null); continue; }
      assert.equal(d[key].coalescedIndex, i + 1);
      assert.equal(d[key].before.startMs, expected.before[i]);
      assert.equal(d[key].after.startMs, expected.after[i]);
      assert.equal(d[key].windowIndex, 0);
      assert.deepEqual(d[key].window, { startMs: speech[0].t0 * 10, endMs: speech[0].t1 * 10 });
    }
    cleaned(h);
  });
}

test('first canonical throw exposes all predicates and bounded neighboring numbers without IDs/text', () => {
  const h = harness();
  const canonical = h.load('@/lib/primary-caption-timing').canonicalizeSourceWords;
  const snapshots = [];
  const words = [{ id: secret, text: secret, startMs: 0, endMs: 50 },
    { id: secret, text: ' ', startMs: 100, endMs: Infinity },
    { id: secret, text: secret, startMs: NaN, endMs: 200 }];
  assert.throws(() => canonical(words, 8000, d => snapshots.push(d)), { message: `Source word timing quality failure for ${secret}` });
  assert.equal(snapshots.length, 1);
  const d = snapshots[0];
  assert.equal(d.acceptedIndex, 1);
  assert.deepEqual(d.previous, { startMs: 0, endMs: 50 });
  assert.equal(d.current.endMs, null);
  assert.equal(d.next.startMs, null);
  assert.equal(d.rejected.duplicateId, true);
  assert.equal(d.rejected.invalidText, true);
  assert.equal(d.rejected.nonfiniteEnd, true);
  assert.equal(d.rejected.nonfiniteNextStart, true);
  assert.ok(!JSON.stringify(d).includes('PRIVATE'));
});

test('zero clipped support reports the real alignment rejection without changing its message', () => {
  const h = harness(), snapshots = [];
  const align = h.load('@/lib/speech-alignment').alignWordsToSpeech;
  assert.throws(() => align([{ id: secret, text: secret, startMs: 795, endMs: 800 }],
    [{ t0: 80, t1: 100 }], 8000, d => snapshots.push(d)), { message: 'Source word timing quality failure for word-1' });
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].currentOrigin.before.startMs, 795);
  assert.deepEqual(snapshots[0].currentOrigin.after, { startMs: 800, endMs: 800 });
  assert.equal(snapshots[0].rejected.nonpositiveCappedSupport, true);
  assert.equal(h.logs.length, 0, 'library has no logging side effect');
});

test('success returns identical words and never logs', async () => {
  const h = harness({ segments: [{ text: ' One', t0: 790, t1: 805 }, { text: ' Two', t0: 795, t1: 805 }] });
  assert.deepEqual(await h.run(), { language: 'en', words: [
    { id: 'word-1', text: 'One', startMs: 7900, endMs: 7950 },
    { id: 'word-2', text: 'Two', startMs: 7950, endMs: 8000 },
  ] });
  assert.deepEqual(h.logs, []);
  cleaned(h);
});

for (const mode of ['generic', 'spoofed timing message', 'aborted', 'cancelled', 'cleanup']) {
  test(`${mode} failure leaks no diagnostic metadata or arbitrary error content`, async () => {
    const error = new Error(mode === 'spoofed timing message' ? 'Source word timing quality failure for word-11' : secret,
      { cause: new Error(secret) });
    error.stack = secret;
    error.toJSON = () => { throw new Error('must never serialize errors'); };
    const h = harness({ segments: [{ text: secret, t0: 0, t1: 100 }],
      nativeError: ['generic', 'spoofed timing message'].includes(mode) ? error : undefined,
      aborted: mode === 'aborted', cancel: mode === 'cancelled', releaseError: mode === 'cleanup' ? error : undefined });
    await assert.rejects(h.run());
    assert.deepEqual(h.logs, []);
    cleaned(h, mode !== 'cancelled');
  });
}

test('logger failure cannot replace timing rejection or prevent cleanup', async () => {
  const h = harness({ segments: [{ text: secret, t0: 801, t1: 805 }], loggerThrows: true });
  await assert.rejects(h.run(), { message: 'Source word timing quality failure for word-1' });
  payload(h);
  cleaned(h);
});

test('word-11 snapshot keeps accepted/coalesced indices and actual merged window distinct', () => {
  const h = harness(), snapshots = [];
  const align = h.load('@/lib/speech-alignment').alignWordsToSpeech;
  const words = Array.from({ length: 10 }, (_, i) => ({ id: secret, text: secret, startMs: i * 100, endMs: i * 100 + 50 }));
  words.push({ id: secret, text: secret, startMs: 1500, endMs: 1600 },
    { id: secret, text: secret, startMs: 1900, endMs: 2400 },
    { id: secret, text: secret, startMs: 2000, endMs: 2500 });
  assert.throws(() => align(words, [{ t0: 0, t1: 100 }, { t0: 220, t1: 240 }, { t0: 245, t1: 300 }],
    8000, d => snapshots.push(d)), { message: 'Source word timing quality failure for word-11' });
  assert.equal(snapshots.length, 1);
  const d = snapshots[0];
  assert.equal(d.acceptedIndex, 10);
  assert.equal(d.acceptedCount, 12);
  assert.deepEqual(d.previous, { startMs: 900, endMs: 950 });
  assert.equal(d.currentOrigin.coalescedIndex, 11);
  assert.equal(d.nextOrigin.coalescedIndex, 12);
  assert.equal(d.currentOrigin.windowIndex, 1);
  assert.deepEqual(d.currentOrigin.window, { startMs: 2200, endMs: 3000 });
});

test('decoded fields reject content-bearing values and nonfinite numbers', async () => {
  const h = harness({ segments: [{ text: secretToken, t0: 801, t1: 805 }],
    decoded: { durationMs: secret, pcmBytes: NaN, sampleRate: Infinity, channelCount: { toJSON() { throw new Error(secret); } } } });
  await assert.rejects(h.run(), { message: 'Source word timing quality failure for word-1' });
  payload(h, { durationMs: null, pcmBytes: null, sampleRate: null, channelCount: null });
  cleaned(h);
});

test('recognized rejection still logs once if existing release failure overrides it', async () => {
  const releaseError = new Error(secret);
  const h = harness({ segments: [{ text: secretToken, t0: 801, t1: 805 }], releaseError });
  await assert.rejects(h.run(), error => error === releaseError);
  payload(h);
  cleaned(h);
});

test('literal rejecting predicate metadata covers malformed numeric and content fields', () => {
  const canonical = harness().load('@/lib/primary-caption-timing').canonicalizeSourceWords;
  for (const [patch, predicate] of [
    [{ id: '' }, 'invalidId'], [{ id: { toJSON() { throw new Error(secret); } } }, 'invalidId'],
    [{ text: '' }, 'invalidText'], [{ startMs: NaN }, 'nonfiniteStart'],
    [{ endMs: Infinity }, 'nonfiniteEnd'], [{ startMs: -1 }, 'negativeStart'],
    [{ startMs: 8000 }, 'startOutsideDuration'], [{ endMs: 0 }, 'nonpositiveCappedSupport'],
  ]) {
    const snapshots = [];
    assert.throws(() => canonical([{ id: secret, text: secret, startMs: 0, endMs: 100, ...patch }],
      8000, d => snapshots.push(d)));
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].rejected[predicate], true);
    assert.ok(!JSON.stringify(snapshots).includes('PRIVATE'));
  }
  const snapshots = [];
  assert.throws(() => canonical([{ id: secret, text: secret, startMs: 100, endMs: 200 },
    { id: secret, text: secret, startMs: 50, endMs: 300 }], 8000, d => snapshots.push(d)));
  assert.equal(snapshots[0].rejected.decreasingNextStart, true);
  for (const duration of [NaN, Infinity, 0, -1]) {
    const invalid = [];
    assert.throws(() => canonical([], duration, d => invalid.push(d)),
      { message: 'Source word timing quality failure: invalid source duration' });
    assert.equal(invalid.length, 1);
    assert.equal(invalid[0].rejected.invalidDuration, true);
    assert.equal(invalid[0].acceptedIndex, null);
  }
});
