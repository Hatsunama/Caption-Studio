import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL('src/services/caption-translation.ts', root), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

function harness(setting, overrides = {}) {
  const requests = [], logs = [];
  const contract = { id: 'model', promptContract: 'contract', sha256: 'hash', downloadBytes: 1, fileName: 'model' };
  class File {
    exists = true; size = 1; uri = 'model'; name = 'model'; parentDirectory = {};
    lastModified = 200; creationTime = 100;
    async text() { return JSON.stringify({ schemaVersion: 1, fileName: this.name,
      sizeBytes: this.size, sha256: contract.sha256, modifiedAtMs: this.lastModified,
      createdAtMs: this.creationTime }); }
  }
  const backend = setting === 'gpu' ? 'gpu' : 'cpu';
  const metric = { batchIndex: 0, captionCount: 1, backend, initializationFallback: false,
    durationMs: 20, initializationMs: 5, generationMs: 15, attempts: 1, repairAttempts: 0,
    generationFailures: 0, invalidOutputs: 0, qualityRejections: 0, outcome: 'completed' };
  const native = {
    limits: { maxCaptionsPerBatch: 32, maxOperationsPerSession: 8, maxBatchesPerSession: 32,
      maxCaptionsPerSession: 100, maxCharactersPerCaption: 100, maxCaptionCharactersPerBatch: 100,
      maxCaptionCharactersPerSession: 1000 },
    async translateNaturalCaptions(_uri, request) {
      requests.push(request);
      return { offline: true, backend, initializationFallback: false,
        benchmarkNoCheckpoints: setting === 'cpu' || setting === 'gpu', durationMs: 20,
        batchMetrics: [metric], modelId: 'model', promptContract: 'contract', batchCount: 1,
        operations: [{ id: 'private-operation', sourceLanguage: 'en', targetLanguage: 'es', captionCount: 1, batchCount: 1 }],
        captions: [{ id: 'c1', text: 'Hola' }], ...overrides };
    },
  };
  const mocks = {
    'expo-file-system': { File, Directory: class {}, Paths: {} },
    'caption-media': {},
    'caption-translation': { __esModule: true, default: native, TRANSLATION_RELEASE_CONTRACT: contract },
    '@/services/storage-policy': {}, '@/services/verified-model-download': {},
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, process: { env: { EXPO_PUBLIC_TRANSLATION_BENCHMARK_BACKEND: setting } },
    console: { info: (...args) => logs.push(args) }, setInterval, clearInterval, Error,
    require: (id) => id in mocks ? mocks[id] : require(id.startsWith('@/')
      ? fileURLToPath(new URL(`src/${id.slice(2)}.ts`, root)) : id),
  });
  return { requests, logs, metric, run: () => exports.translateNaturalCaptionOperations({ operations: [
    { id: 'private-operation', sourceLanguage: 'en', targetLanguage: 'es', captions: [{ id: 'private-cue', text: 'Hello' }] },
  ] }) };
}

test('default and invalid opt-ins explicitly preserve CPU, checkpoints, and repair', async () => {
  for (const setting of [undefined, '', 'auto', 'GPU', 'true', ' gpu ']) {
    const host = harness(setting);
    const result = await host.run();
    assert.equal(result.operations.get('private-operation').get('private-cue'), 'Hola');
    const request = host.requests[0];
    assert.equal(request.runtimeBackend, 'cpu');
    assert.equal(request.benchmarkNoCheckpoints, false);
    assert.equal(request.reuseCheckpoints, true);
    assert.equal(request.repairUnusableOutputs, true);
    assert.deepEqual(host.logs, []);
  }
});

test('normal results accept every native backend, including checkpoint-only none', async () => {
  for (const backend of ['cpu', 'gpu', 'none', 'unknown']) await harness(undefined, { backend }).run();
  await assert.rejects(harness(undefined, { backend: 'bogus' }).run(), /incomplete translation/);
});

test('explicit CPU and GPU benchmarks disable checkpoints and preserve content semantics', async () => {
  for (const setting of ['cpu', 'gpu']) {
    const host = harness(setting);
    const result = await host.run();
    assert.equal(result.operations.get('private-operation').get('private-cue'), 'Hola');
    assert.equal(host.requests[0].runtimeBackend, setting);
    assert.equal(host.requests[0].benchmarkNoCheckpoints, true);
    assert.equal(host.requests[0].reuseCheckpoints, false);
    assert.equal(host.requests[0].repairUnusableOutputs, true);
    assert.equal(host.logs.length, 1);
  }
});

test('benchmarks reject fallback, mismatched backends, and missing checkpoint opt-out acknowledgement', async () => {
  for (const setting of ['cpu', 'gpu']) {
    for (const backend of ['cpu', 'gpu', 'none', 'unknown']) {
      if (backend !== setting) await assert.rejects(harness(setting, { backend }).run(), /benchmark/i);
    }
    for (const overrides of [{ initializationFallback: true }, { benchmarkNoCheckpoints: false },
      { benchmarkNoCheckpoints: undefined }]) {
      await assert.rejects(harness(setting, overrides).run(), /benchmark/i);
    }
  }
});

test('benchmark logs project only safe primitive metrics, even from malformed native fields', async () => {
  const privateValue = 'PRIVATE CAPTION AND ID';
  const host = harness('gpu', { durationMs: privateValue, captions: [{ id: 'c1', text: 'Hola' }],
    batchMetrics: [{ batchIndex: 0, captionCount: 1, backend: privateValue, initializationFallback: privateValue,
      durationMs: privateValue, initializationMs: 5, generationMs: 15, attempts: 1,
      repairAttempts: 0, generationFailures: 0, invalidOutputs: 0, qualityRejections: 0,
      outcome: privateValue, text: privateValue, id: privateValue }] });
  await host.run();
  const logged = JSON.stringify(host.logs);
  assert.doesNotMatch(logged, /PRIVATE|private-operation|private-cue|Hola|c1/);
  assert.match(logged, /generationMs/);
  assert.match(logged, /15/);
});

test('existing offline, model, operation, and review guards still apply', async () => {
  for (const overrides of [{ offline: false }, { modelId: 'wrong' }, { promptContract: 'wrong' },
    { batchCount: 2 }, { operations: [] }]) {
    await assert.rejects(harness('gpu', overrides).run(), /incomplete translation/);
  }
  const result = await harness('gpu', { captions: [{ id: 'c1', text: '', valid: false, failureReason: 'invalid-output' }] }).run();
  assert.equal(result.operations.get('private-operation').get('private-cue'), '');
  assert.equal(result.needsReviewByOperation.get('private-operation').has('private-cue'), true);
  assert.equal(result.failureReasonsByOperation.get('private-operation').get('private-cue'), 'invalid-output');
});
