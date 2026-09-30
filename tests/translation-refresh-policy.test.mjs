import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { createEnglishChineseCaptionTrack, setTranslationCueSkipped, updatePairedCaptionText } from '../src/lib/caption-tracks.ts';

const root = new URL('../', import.meta.url);
const require = createRequire(import.meta.url);
const compile = (path) => ts.transpileModule(readFileSync(new URL(path, root), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const serviceCode = compile('src/services/caption-translation.ts');
const hookCode = compile('src/hooks/use-project-caption-translation.ts');
const localRequire = (id) => require(id.startsWith('@/')
  ? fileURLToPath(new URL(`src/${id.slice(2)}.ts`, root)) : id);

function serviceHarness(setting) {
  const requests = [];
  const contract = { id: 'model', promptContract: 'contract', sha256: 'hash', downloadBytes: 1, fileName: 'model' };
  class File {
    exists = true; size = 1; uri = 'model'; name = 'model'; parentDirectory = {};
    lastModified = 200; creationTime = 100;
    async text() { return JSON.stringify({ schemaVersion: 1, fileName: this.name,
      sizeBytes: this.size, sha256: contract.sha256, modifiedAtMs: this.lastModified,
      createdAtMs: this.creationTime }); }
  }
  const native = {
    limits: { maxCaptionsPerBatch: 32, maxOperationsPerSession: 8, maxBatchesPerSession: 32,
      maxCaptionsPerSession: 100, maxCharactersPerCaption: 100, maxCaptionCharactersPerBatch: 100,
      maxCaptionCharactersPerSession: 1000 },
    async translateNaturalCaptions(_uri, request) {
      requests.push(request);
      return { offline: true, backend: 'cpu', initializationFallback: false,
        benchmarkNoCheckpoints: setting === 'cpu', modelId: 'model', promptContract: 'contract',
        batchCount: request.operations.length, batchMetrics: [],
        operations: request.operations.map((op) => ({ id: op.id, sourceLanguage: op.sourceLanguage,
          targetLanguage: op.targetLanguage, captionCount: op.batches.flatMap((b) => b.captions).length,
          batchCount: op.batches.length })),
        captions: request.operations.flatMap((op) => op.batches.flatMap((b) => b.captions.map((c) => ({ id: c.id, text: 'Hola' })))),
      };
    },
  };
  const mocks = {
    'expo-file-system': { File, Directory: class {}, Paths: {} }, 'caption-media': {},
    'caption-translation': { __esModule: true, default: native, TRANSLATION_RELEASE_CONTRACT: contract },
    '@/services/storage-policy': {}, '@/services/verified-model-download': {},
  };
  const exports = {};
  vm.runInNewContext(serviceCode, { exports, setInterval, clearInterval, Error,
    process: { env: { EXPO_PUBLIC_TRANSLATION_BENCHMARK_BACKEND: setting } }, console: { info() {} },
    require: (id) => id in mocks ? mocks[id] : localRequire(id),
  });
  return { exports, requests };
}

const operation = { id: 'op', sourceLanguage: 'en', targetLanguage: 'es', captions: [{ id: 'cue', text: 'Hello' }] };

test('explicit refresh bypasses checkpoint reads through both service entry points and keeps writes enabled', async () => {
  for (const entry of ['translateNaturalCaptionBatch', 'translateNaturalCaptionOperations']) {
    const host = serviceHarness();
    await host.exports[entry]({ ...operation, operations: [operation], checkpointPolicy: 'refresh' });
    assert.equal(host.requests[0].reuseCheckpoints, false, entry);
    assert.equal(host.requests[0].benchmarkNoCheckpoints, false, 'refresh must retain checkpoint writes');
    assert.equal(host.requests[0].repairUnusableOutputs, true);
  }
});

test('resume and default requests reuse checkpoints; benchmark still disables all checkpoints', async () => {
  for (const checkpointPolicy of [undefined, 'resume']) {
    const host = serviceHarness();
    await host.exports.translateNaturalCaptionOperations({ operations: [operation], checkpointPolicy });
    assert.equal(host.requests[0].reuseCheckpoints, true);
    assert.equal(host.requests[0].benchmarkNoCheckpoints, false);
  }
  const host = serviceHarness('cpu');
  await host.exports.translateNaturalCaptionOperations({ operations: [operation], checkpointPolicy: 'resume' });
  assert.equal(host.requests[0].reuseCheckpoints, false);
  assert.equal(host.requests[0].benchmarkNoCheckpoints, true);
});

function fixture() {
  let project = createCaptionProject({ id: 'p', name: 'Refresh', sources: [{ id: 'v', uri: 'file:///video.mp4',
    storageMode: 'copied', displayName: 'video.mp4', durationMs: 6000, width: 1080, height: 1920,
    rotation: 0, frameRate: 30 }] });
  project.transcription.language = 'en';
  project.captions = ['Hello world', 'See you later', 'Good morning'].map((text, i) => ({
    id: `c${i + 1}`, text, startMs: i * 1500, endMs: (i + 1) * 1500, wordIds: [],
  }));
  project = createEnglishChineseCaptionTrack(project, { c1: '\u4f60\u597d' });
  return setTranslationCueSkipped(project, 'translation-zh-Hans', 'c3', true);
}

function hookHarness(initial, translate) {
  let project = initial;
  const requests = [];
  const exports = {};
  const service = { CaptionTranslationCancelledError: class extends Error {},
    cancelNaturalCaptionTranslation: async () => false,
    translateNaturalCaptionBatch: async (options) => { requests.push(options); return translate(options, requests.length); },
  };
  const react = { useRef: (value) => ({ current: value }), useState: () => [undefined, () => {}],
    useCallback: (fn) => fn, useLayoutEffect: (fn) => fn(), useEffect: (fn) => fn() };
  vm.runInNewContext(hookCode, { exports, Error,
    require: (id) => id === 'react' ? react : id === 'react-native' ? { AppState: { addEventListener: () => ({ remove() {} }) } }
      : id === '@/services/caption-translation' ? service : localRequire(id),
  });
  const controller = exports.useProjectCaptionTranslation({ getCurrentProject: () => project,
    commitProject: async (_baseline, next) => { project = next; }, commitManualEdits: async () => {} });
  return { controller, requests, getProject: () => project,
    edit: (apply) => { project = apply(project); } };
}

for (const ids of [['c1'], ['c1', 'c2', 'c3']]) {
  test(`hook propagates refresh intent for ${ids.length === 1 ? 'selected' : 'all'} cues and preserves skips`, async () => {
    const initial = fixture();
    const host = hookHarness(initial, async () => { throw new Error('temporary failure'); });
    await host.controller.refresh('translation-zh-Hans', ids);
    assert.equal(host.requests[0].checkpointPolicy, 'refresh');
    assert.deepEqual(Array.from(host.requests[0].captions, (c) => c.id), ids.filter((id) => id !== 'c3'));
    assert.equal(host.getProject(), initial, 'a failed refresh cannot discard accepted text');
  });
}

test('retry resumes only unfinished cues, preserving accepted batches and later human edits', async () => {
  const host = hookHarness(fixture(), async (options, call) => {
    if (call === 1) {
      await options.onAcceptedBatch({ captions: new Map([['c1', '\u4f60\u597d\u4e16\u754c']]),
        needsReview: new Set(), provider: { id: 'litertlm', modelId: 'model', modelRevision: 'revision', promptVersion: 1 } });
      throw new Error('interrupted after accepted batch');
    }
  });
  await host.controller.refresh('translation-zh-Hans', ['c1', 'c2', 'c3']);
  assert.equal(host.getProject().captionTracks.translations[0].cues[0].text, '\u4f60\u597d\u4e16\u754c');
  await host.controller.retry();
  assert.equal(host.requests[1].checkpointPolicy, 'resume');
  assert.deepEqual(Array.from(host.requests[1].captions, (c) => c.id), ['c2']);
  host.edit((p) => updatePairedCaptionText(p, { trackId: 'translation-zh-Hans', sourceCaptionId: 'c2',
    translatedText: '\u4eba\u5de5\u7ffb\u8bd1', translationStatus: 'reviewed' }));
  await host.controller.retry();
  assert.equal(host.requests.length, 2, 'resume cannot retranslate an accepted human edit');
});
