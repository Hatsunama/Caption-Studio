import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';
import test from 'node:test';
import { encodeModelVerificationMarker, modelVerificationMarkerIdentityMatches } from '../src/lib/model-verification.ts';
import * as modelArtifacts from '../src/lib/model-artifact-lifecycle.ts';
import { translationModelConsentMessage } from '../src/lib/translation-model-consent.ts';

class ModelDownloadPausedError extends Error {}
class ModelDownloadIntegrityError extends Error {}
class ModelDownloadTransferError extends Error {}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const failure = (message, code = 'E_TRANSLATION_FAILED') => Object.assign(new Error(message), { code });
async function serviceFixture(config = {}) {
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
      this.exists = !config.download;
      this.size = 1;
      this.lastModified = 200;
      this.creationTime = 100;
    }
    async text() { return encodeModelVerificationMarker({ fileName: contract.fileName,
      sizeBytes: contract.downloadBytes, modifiedAtMs: this.lastModified,
      createdAtMs: this.creationTime }, contract.sha256); }
    write() {}
  }
  const native = {
    limits,
    addListener(_name, callback) {
      listeners.add(callback);
      return { remove: () => listeners.delete(callback) };
    },
    async translateNaturalCaptions(_model, request) {
      if (config.translate) return config.translate(request, listeners, acceptedBatches);
      calls.push(request);
      const batches = request.operations.flatMap((operation) => operation.batches);
      const output = batches.map((batch) => batch.captions.map(({ id }) => ({ id, text: `translated-${id}`, valid: true })));
      if (request.requestId) {
        const first = { requestId: request.requestId, batchIndex: 0, captions: output[0] };
        acceptedBatches.push(first);
        listeners.forEach((listener) => listener(first));
        await Promise.resolve();
        if (config.failSecond) throw new Error('Later native batch failed');
        const second = { requestId: request.requestId, batchIndex: 1, captions: output[1] };
        acceptedBatches.push(second);
        listeners.forEach((listener) => listener(second));
      } else if (config.failSecond && calls.length === 2) {
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
    async getNaturalCaptionAcceptedBatches() { if (config.readAccepted) return config.readAccepted(); return acceptedBatches; },
    async cancelNaturalCaptionTranslation() { return config.stop?.(); },
  };
  const modules = {
    'expo-file-system': { File, Directory: class { create() {} }, Paths: { document: '/' } },
    'caption-media': { __esModule: true, default: { sha256: async () => 'hash' } },
    'caption-translation': { __esModule: true, default: native, TRANSLATION_RELEASE_CONTRACT: contract },
    '@/lib/caption-languages': { canonicalCaptionLanguageTag: (value) => value,
      resolveCaptionLanguage: (tag) => ({ tag, automaticTranslation: true }),
      isLikelyUntranslatedCaption: () => false },
    '@/lib/caption-text-breaks': { captionTextHead: (text) => text, captionTextTail: (text) => text },
    '@/lib/model-verification': { encodeModelVerificationMarker, modelVerificationMarkerIdentityMatches },
    '@/lib/model-artifact-lifecycle': modelArtifacts,
    '@/lib/translation-batching': { createTranslationBatches: (captions) => captions.map((caption) => [caption]) },
    '@/lib/translation-model-consent': { translationModelConsentMessage },
    '@/lib/contextual-translation-batching': { splitBatchesByContext: (batches) => batches },
    '@/lib/translation-input': { validateTranslationUnits: (captions) => captions },
    '@/lib/translation-invariants': { acceptTranslationBoundary: (expected, actual) => ({
      translations: new Map(actual.map(({ id, text }) => [id, text])), rejected: new Set(),
    }) },
    '@/services/storage-policy': { requireFreeSpace: async () => {} },
    '@/services/verified-model-download': { ModelDownloadPausedError, ModelDownloadIntegrityError, ModelDownloadTransferError,
      resumableModelDownloadReservation: async () => 1,
      downloadVerifiedModel: (options) => config.download(options) },
  };
  const module = { exports: {} };
  runInNewContext(compiled.code, { module, exports: module.exports, require: (id) => {
    assert.ok(id in modules, `Unexpected dependency: ${id}`);
    return modules[id];
  }, process, setInterval, clearInterval, console, Symbol, Map, Set, Array, Error });
  return { service: module.exports, calls };
}

const captions = [{ id: 'first', text: 'Hello' }, { id: 'second', text: 'World' }];
const start = (service, extra = {}) => service.translateNaturalCaptionBatch({
  sourceLanguage: 'en', targetLanguage: 'fr', captions, ...extra,
});
const sameFailure = (expected) => (actual) => {
  assert.equal(actual, expected);
  return true;
};

test('native cleanup failure survives a stop request', async () => {
  const entered = deferred(), work = deferred();
  const { service } = await serviceFixture({ translate: () => { entered.resolve(); return work.promise; } });
  const error = failure('Native cancellation cleanup failed');
  const result = start(service);
  const rejection = assert.rejects(result, sameFailure(error));
  await entered.promise;
  await service.cancelNaturalCaptionTranslation();
  work.reject(error);
  await rejection;
});

test('message text and Error name do not classify real failures as cancellation', async () => {
  for (const error of [failure('Unable to cancel native cleanup'), Object.assign(new Error('disk full'), { name: 'CancelCleanupError' })]) {
    const { service } = await serviceFixture({ translate: async () => { throw error; } });
    await assert.rejects(start(service), sameFailure(error));
  }
});

test('typed native cancellation is cancellation even without cancel text or Error prototype', async () => {
  const { service } = await serviceFixture({ translate: async () => { throw { code: 'E_TRANSLATION_CANCELLED', message: 'Stopped' }; } });
  await assert.rejects(start(service), (error) => error instanceof service.CaptionTranslationCancelledError);
});

test('accepted-batch save failure survives stop and consumes queue-triggered stop rejection', async () => {
  const entered = deferred(), work = deferred(), save = deferred(), saving = deferred();
  const disk = new Error('cancel checkpoint save: disk full');
  const stop = failure('stop dispatch failed');
  const { service } = await serviceFixture({
    stop: async () => { throw stop; },
    translate: (request, listeners) => {
      entered.resolve();
      listeners.forEach((listener) => listener({ requestId: request.requestId, batchIndex: 0,
        captions: [{ id: request.operations[0].batches[0].captions[0].id, text: 'Bonjour', valid: true }] }));
      return work.promise;
    },
  });
  const result = start(service, { onAcceptedBatch: () => { saving.resolve(); return save.promise; } });
  const rejection = assert.rejects(result, sameFailure(disk));
  await entered.promise;
  await saving.promise;
  await assert.rejects(service.cancelNaturalCaptionTranslation(), sameFailure(stop));
  save.reject(disk);
  await tick();
  work.reject({ code: 'E_TRANSLATION_CANCELLED' });
  await rejection;
});

test('stop dispatch failure stays terminal when native acknowledges cancellation', async () => {
  const entered = deferred(), work = deferred();
  const stop = failure('stop dispatch failed');
  const { service } = await serviceFixture({ stop: async () => { throw stop; },
    translate: () => { entered.resolve(); return work.promise; } });
  const result = start(service);
  const rejection = assert.rejects(result, sameFailure(stop));
  await entered.promise;
  await assert.rejects(service.cancelNaturalCaptionTranslation(), sameFailure(stop));
  work.reject({ code: 'E_TRANSLATION_CANCELLED' });
  await rejection;
});

test('accepted-batch recovery read failure cannot replace original native failure or skip pending save', async () => {
  const entered = deferred(), work = deferred(), save = deferred(), saving = deferred();
  const native = failure('cleanup failed');
  const { service } = await serviceFixture({
    readAccepted: async () => { throw new Error('accepted list unavailable'); },
    translate: (request, listeners) => {
      listeners.forEach((listener) => listener({ requestId: request.requestId, batchIndex: 0,
        captions: [{ id: request.operations[0].batches[0].captions[0].id, text: 'Bonjour', valid: true }] }));
      entered.resolve();
      return work.promise;
    },
  });
  const order = [];
  service.registerCaptionTranslationResources(() => ({ ready: Promise.resolve(), restore: async () => { order.push('restore'); } }));
  const result = start(service, { onAcceptedBatch: async () => { saving.resolve(); await save.promise; order.push('save'); } });
  const rejection = assert.rejects(result, (error) => {
    assert.equal(error.cause ?? error, native);
    return true;
  });
  await entered.promise; await saving.promise;
  work.reject(native);
  await tick();
  assert.deepEqual(order, []);
  save.resolve();
  await rejection;
  assert.deepEqual(order, ['save', 'restore']);
});

test('download transfer, integrity and unknown failures survive stop; explicit pause remains cancellation', async () => {
  for (const error of [new ModelDownloadTransferError('cancel transfer: network failed'),
    new ModelDownloadIntegrityError('digest failed'), new Error('cancel checkpoint failed'), new ModelDownloadPausedError()]) {
    const entered = deferred(), work = deferred();
    const { service } = await serviceFixture({ download: (options) => {
      options.registerPauser(async () => {});
      entered.resolve();
      return work.promise;
    } });
    const result = start(service);
    const rejection = assert.rejects(result, (actual) => {
      if (error instanceof ModelDownloadPausedError) assert.ok(actual instanceof service.CaptionTranslationCancelledError);
      else {
        assert.ok(!(actual instanceof service.CaptionTranslationCancelledError));
        if (!(error instanceof ModelDownloadIntegrityError)) assert.match(actual.message, /cancel/);
      }
      return true;
    });
    await entered.promise; await service.cancelNaturalCaptionTranslation();
    work.reject(error); await rejection;
  }
});

test('download pause does not swallow native stop failure', async () => {
  const entered = deferred(), work = deferred();
  const stop = failure('native stop failed while downloading');
  const { service } = await serviceFixture({ stop: async () => { throw stop; },
    download: (options) => { options.registerPauser(async () => {}); entered.resolve(); return work.promise; } });
  const result = start(service);
  const rejection = assert.rejects(result, sameFailure(stop));
  await entered.promise;
  const cancellation = assert.rejects(service.cancelNaturalCaptionTranslation(), sameFailure(stop));
  work.reject(new ModelDownloadPausedError());
  await cancellation; await rejection;
});

test('lifecycle ownership waits for stop completion and restore; no new run or removal', async () => {
  const entered = deferred(), work = deferred(), stop = deferred(), restoring = deferred(), restore = deferred();
  const { service } = await serviceFixture({ stop: () => stop.promise,
    translate: () => { entered.resolve(); return work.promise; } });
  service.registerCaptionTranslationResources(() => ({ ready: Promise.resolve(), restore: () => {
    restoring.resolve(); return restore.promise;
  } }));
  const result = start(service);
  const rejection = assert.rejects(result, (error) => error instanceof service.CaptionTranslationCancelledError);
  await entered.promise;
  const cancellation = service.cancelNaturalCaptionTranslation();
  work.reject({ code: 'E_TRANSLATION_CANCELLED' });
  await tick();
  let didRestore = false;
  restoring.promise.then(() => { didRestore = true; });
  await tick();
  assert.equal(didRestore, false);
  await assert.rejects(start(service), /already running/);
  await assert.rejects(service.removeDownloadedNaturalTranslationModel(), /Wait/);
  stop.resolve(); await cancellation; await restoring.promise;
  await assert.rejects(start(service), /already running/);
  restore.resolve(); await rejection;
});

test('restore failure is terminal for cancellation but does not replace an earlier terminal failure', async () => {
  for (const native of [{ code: 'E_TRANSLATION_CANCELLED' }, failure('native cleanup failed')]) {
    const restore = new Error('resource restore failed');
    const { service } = await serviceFixture({ translate: async () => { throw native; } });
    service.registerCaptionTranslationResources(() => ({ ready: Promise.resolve(), restore: async () => { throw restore; } }));
    await assert.rejects(start(service), sameFailure(native.code === 'E_TRANSLATION_CANCELLED' ? restore : native));
  }
});

async function hookFixture(config = {}) {
  const source = await readFile(new URL('../src/hooks/use-project-caption-translation.ts', import.meta.url), 'utf8');
  const compiled = await transform(source, { loader: 'ts', format: 'cjs' });
  const slots = [], effects = [], cleanups = [];
  let cursor = 0, listener, controller;
  const react = {
    useRef: (value) => { const index = cursor++; return slots[index] ??= { current: value }; },
    useState: (value) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = value;
      return [slots[index], (next) => { slots[index] = next; }];
    },
    useCallback: (fn) => fn,
    useLayoutEffect: (fn) => fn(),
    useEffect: (fn) => { const index = cursor++; if (!(index in slots)) { slots[index] = true; effects.push(fn); } },
  };
  class CaptionTranslationCancelledError extends Error {}
  const project = { captions: [{ id: 'c1', text: 'Hello' }], captionTracks: { translations: [{
    id: 'track', sourceLanguageTag: 'en', languageTag: 'fr', cues: [{ sourceCaptionId: 'c1', text: '', status: 'pending' }],
  }] } };
  const modules = {
    react,
    'react-native': { AppState: { addEventListener: (_event, fn) => { listener = fn; return { remove() {} }; } } },
    '@/lib/caption-languages': { canAutomaticallyTranslatePair: () => true, captionLanguageFamily: (v) => v },
    '@/lib/caption-tracks': { projectPrimaryCaptionLanguage: () => 'en',
      resolveCaptionPairs: () => [{ timelineVisible: true, source: project.captions[0], translation: project.captionTracks.translations[0].cues[0] }],
      setTranslationTrackProvider: (current) => current },
    '@/lib/video-timeline': { visibleTimelineCaptions: (v) => v },
    '@/lib/caption-translation-commit': { automaticTranslationCueWrites: () => [] },
    '@/lib/translation-attempt': { translationAttemptMessage: () => undefined,
      commitTranslationAttempt: (current) => ({ ...current }) },
    '@/services/caption-translation': { CaptionTranslationCancelledError,
      translateNaturalCaptionBatch: (options) => config.translate(options),
      cancelNaturalCaptionTranslation: () => config.stop?.() ?? Promise.resolve(true) },
  };
  const module = { exports: {} };
  runInNewContext(compiled.code, { module, exports: module.exports, require: (id) => {
    assert.ok(id in modules, `Unexpected dependency: ${id}`); return modules[id];
  }, Error, Symbol, Map, Set, Date });
  const render = () => {
    cursor = 0;
    controller = module.exports.useProjectCaptionTranslation({ getCurrentProject: () => project,
      commitProject: config.save ?? (async () => {}), commitManualEdits: async () => {} });
    while (effects.length) cleanups.push(effects.shift()());
    return controller;
  };
  render();
  return { render, background: () => listener('background'),
    unmount: () => cleanups.forEach((cleanup) => cleanup?.()), CaptionTranslationCancelledError };
}

test('background interruption reports native and accepted-save failures instead of pause copy', async () => {
  for (const saving of [false, true]) {
    const entered = deferred(), work = deferred(), save = deferred(), savingNow = deferred();
    const error = new Error(saving ? 'cancel checkpoint: disk full' : 'native cleanup failed');
    const fixture = await hookFixture({ save: () => { savingNow.resolve(); return save.promise; },
      translate: async (options) => {
        entered.resolve();
        if (saving) await options.onAcceptedBatch({ captions: new Map([['c1', 'Bonjour']]), needsReview: new Set() });
        else await work.promise;
      } });
    const result = fixture.render().refresh('track', ['c1']);
    await entered.promise;
    if (saving) await savingNow.promise;
    fixture.background();
    (saving ? save : work).reject(error);
    assert.equal(await result, false);
    assert.equal(fixture.render().error, error.message);
    assert.equal(fixture.render().retryAvailable, true);
  }
});

test('background typed cancellation retains pause and retry copy', async () => {
  const entered = deferred(), work = deferred();
  const fixture = await hookFixture({ translate: () => { entered.resolve(); return work.promise; } });
  const result = fixture.render().refresh('track', ['c1']);
  await entered.promise; fixture.background();
  work.reject(new fixture.CaptionTranslationCancelledError());
  assert.equal(await result, false);
  assert.match(fixture.render().error, /paused because/);
  assert.equal(fixture.render().retryAvailable, true);
});

for (const mode of ['background', 'unmount', 'explicit']) {
  test(`hook ${mode} consumes failed stop and holds ownership until stop settles`, async () => {
    const entered = deferred(), work = deferred(), stop = deferred();
    const error = new Error('stop dispatch failed');
    const fixture = await hookFixture({ stop: () => stop.promise,
      translate: () => { entered.resolve(); return work.promise; } });
    let finished = false;
    const result = fixture.render().refresh('track', ['c1']).then((value) => { finished = true; return value; });
    await entered.promise;
    let cancellation;
    if (mode === 'explicit') cancellation = fixture.render().cancel();
    else fixture[mode]();
    work.reject(new fixture.CaptionTranslationCancelledError());
    await tick();
    assert.equal(finished, false);
    stop.reject(error);
    if (cancellation) assert.equal(await cancellation, false);
    assert.equal(await result, false);
    if (mode !== 'unmount') {
      assert.equal(fixture.render().error, error.message);
      assert.equal(fixture.render().busy, false);
    }
  });
}
