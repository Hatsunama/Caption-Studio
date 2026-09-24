import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';
import test from 'node:test';

async function serviceFixture(failSecond = false) {
  const source = await readFile(new URL('../src/services/caption-translation.ts', import.meta.url), 'utf8');
  const compiled = await transform(source, { loader: 'ts', format: 'cjs' });
  const contract = { id: 'model', revision: 'revision', promptVersion: 'prompt',
    promptContract: 'contract', fileName: 'model.bin', downloadBytes: 1, sha256: 'hash', label: 'Model' };
  const limits = { maxCaptionsPerBatch: 1, maxOperationsPerSession: 8, maxBatchesPerSession: 10,
    maxCaptionsPerSession: 10, maxCharactersPerCaption: 100, maxCaptionCharactersPerBatch: 100,
    maxCaptionCharactersPerSession: 1000 };
  const listeners = new Set();
  const calls = [];
  const acceptedBatches = [];
  class File {
    constructor(parent, name) {
      this.name = name;
      this.parentDirectory = parent;
      this.uri = `file:///${name}`;
      this.exists = true;
      this.size = 1;
    }
    async text() { return 'hash'; }
    write() {}
  }
  const native = {
    limits,
    addListener(_name, callback) {
      listeners.add(callback);
      return { remove: () => listeners.delete(callback) };
    },
    async translateNaturalCaptions(_model, request) {
      calls.push(request);
      const batches = request.operations.flatMap((operation) => operation.batches);
      const output = batches.map((batch) => batch.captions.map(({ id }) => ({ id, text: `translated-${id}`, valid: true })));
      if (request.requestId) {
        const first = { requestId: request.requestId, batchIndex: 0, captions: output[0] };
        acceptedBatches.push(first);
        listeners.forEach((listener) => listener(first));
        await Promise.resolve();
        if (failSecond) throw new Error('Later native batch failed');
        const second = { requestId: request.requestId, batchIndex: 1, captions: output[1] };
        acceptedBatches.push(second);
        listeners.forEach((listener) => listener(second));
      } else if (failSecond && calls.length === 2) {
        throw new Error('Later native batch failed');
      }
      return {
        captions: output.flat(), batchCount: batches.length, offline: true, backend: 'cpu',
        modelId: contract.id, promptContract: contract.promptContract,
        operations: request.operations.map((operation) => ({ id: operation.id,
          sourceLanguage: operation.sourceLanguage, targetLanguage: operation.targetLanguage,
          captionCount: operation.batches.flatMap((batch) => batch.captions).length,
          batchCount: operation.batches.length })),
      };
    },
    async getNaturalCaptionTranslationProgress() { return { stage: 'translating', processedItems: 0, totalItems: 2 }; },
    async getNaturalCaptionAcceptedBatches() { return acceptedBatches; },
    async cancelNaturalCaptionTranslation() {},
  };
  const modules = {
    'expo-file-system': { File, Directory: class { constructor() {} }, Paths: { document: '/' } },
    'caption-media': { __esModule: true, default: { sha256: async () => 'hash' } },
    'caption-translation': { __esModule: true, default: native, TRANSLATION_RELEASE_CONTRACT: contract },
    '@/lib/caption-languages': { canonicalCaptionLanguageTag: (value) => value,
      resolveCaptionLanguage: (tag) => ({ tag, automaticTranslation: true }),
      isLikelyUntranslatedCaption: () => false },
    '@/lib/caption-text-breaks': { captionTextHead: (text) => text, captionTextTail: (text) => text },
    '@/lib/translation-batching': { createTranslationBatches: (captions) => captions.map((caption) => [caption]) },
    '@/lib/contextual-translation-batching': { splitBatchesByContext: (batches) => batches },
    '@/lib/translation-input': { validateTranslationUnits: (captions) => captions },
    '@/lib/translation-invariants': { acceptTranslationBoundary: (expected, actual) => ({
      translations: new Map(actual.map(({ id, text }) => [id, text])), rejected: new Set(),
    }) },
    '@/services/storage-policy': { requireFreeSpace: async () => {} },
    '@/services/verified-model-download': {},
  };
  const module = { exports: {} };
  runInNewContext(compiled.code, { module, exports: module.exports, require: (id) => {
    assert.ok(id in modules, `Unexpected dependency: ${id}`);
    return modules[id];
  }, process, setInterval, clearInterval, console, Symbol, Map, Set, Array, Error });
  return { service: module.exports, calls };
}

const captions = [{ id: 'first', text: 'Hello' }, { id: 'second', text: 'World' }];

test('multi-batch acceptance uses one native session and commits each batch', async () => {
  const { service, calls } = await serviceFixture();
  const committed = [];
  await service.translateNaturalCaptionBatch({ sourceLanguage: 'en', targetLanguage: 'fr', captions,
    onAcceptedBatch: async (batch) => committed.push([...batch.captions.keys()]) });
  assert.equal(calls.length, 1);
  assert.deepEqual(committed, [['first'], ['second']]);
});

test('a later native failure keeps the earlier accepted batch', async () => {
  const { service, calls } = await serviceFixture(true);
  const committed = [];
  await assert.rejects(service.translateNaturalCaptionBatch({ sourceLanguage: 'en', targetLanguage: 'fr', captions,
    onAcceptedBatch: async (batch) => committed.push([...batch.captions.keys()]) }), /Later native batch failed/);
  assert.equal(calls.length, 1);
  assert.deepEqual(committed, [['first']]);
});
