import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
function load(path, mocks) {
  const source = readFileSync(new URL(path, root), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports, require: (id) => id in mocks ? mocks[id]
      : require(id.startsWith('@/') ? new URL(`src/${id.slice(2)}.ts`, root).pathname.replace(/^\/(.:)/, '$1') : id),
    setTimeout, clearTimeout, setInterval, clearInterval, AbortController, Error, performance,
  });
  return exports;
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function serviceHarness(nativeWork = async () => { throw new Error('model failed'); }) {
  const events = [];
  const contract = { id: 'model', promptContract: 'contract', sha256: 'hash', downloadBytes: 1, fileName: 'model' };
  class File {
    exists = true; size = 1; uri = 'model'; name = 'model'; parentDirectory = {};
    async text() { return 'hash'; }
  }
  const native = {
    limits: { maxCaptionsPerBatch: 32, maxOperationsPerSession: 8, maxBatchesPerSession: 32,
      maxCaptionsPerSession: 100, maxCharactersPerCaption: 100, maxCaptionCharactersPerBatch: 100,
      maxCaptionCharactersPerSession: 1000 },
    translateNaturalCaptions: (...args) => { events.push('model'); return nativeWork(...args); },
    cancelNaturalCaptionTranslation: async () => { events.push('cancel'); },
  };
  const service = load('src/services/caption-translation.ts', {
    'expo-file-system': { File, Directory: class {}, Paths: {} },
    'caption-media': {},
    'caption-translation': { __esModule: true, default: native, TRANSLATION_RELEASE_CONTRACT: contract },
    '@/services/storage-policy': {}, '@/services/verified-model-download': {},
  });
  const run = () => service.translateNaturalCaptionOperations({ operations: [
    { id: 'op', sourceLanguage: 'en', targetLanguage: 'es', captions: [{ id: 'cue', text: 'Hello' }] },
  ] });
  return { service, run, events };
}

test('cue counts drive progress even within the last batch; native text is never displayed', () => {
  const { service } = serviceHarness();
  const progress = service.captionTranslationProgress({ stage: 'translating', processedItems: 33,
    totalItems: 64, completedBatches: 1, totalBatches: 2, percent: 99, text: 'PRIVATE CAPTION' });
  assert.equal(progress.progress, 33 / 64);
  assert.match(progress.detail, /33 of 64 cues completed/);
  assert.doesNotMatch(progress.detail, /batch|PRIVATE/);
});

test('validation, retry, checkpoint restore and terminal stages retain truthful cue counts', () => {
  const { service } = serviceHarness();
  for (const [stage, label] of [['validating-output', /Validating.*retry/i], ['restoring', /Restoring/],
    ['cancelling', /Cancelling/], ['failed', /failed/i], ['completed', /completed/i]]) {
    const progress = service.captionTranslationProgress({ stage, processedItems: 7, totalItems: 8, percent: 100 });
    assert.match(progress.detail, label);
    assert.match(progress.detail, /7 of 8 cues completed/);
    assert.ok(progress.progress < 1);
  }
  assert.equal(service.captionTranslationProgress({ stage: 'completed', processedItems: 8, totalItems: 8 }).progress, 1);
  assert.equal(service.captionTranslationProgress({ stage: 'validating-output', processedItems: 8, totalItems: 8 }).progress, 0.99);
  assert.equal(service.captionTranslationProgress({ stage: 'translating', processedItems: NaN, totalItems: 0 }).progress, null);
  assert.ok(service.captionTranslationProgress({ stage: 'verifying-model', percent: 100 }).progress < 1);
});

test('model waits for decoder release and failure restores exactly once', async () => {
  const { service, run, events } = serviceHarness();
  const released = deferred();
  const unregister = service.registerCaptionTranslationResources(() => ({
    ready: released.promise, restore: async () => { events.push('restore'); },
  }));
  const operation = run();
  await flush();
  assert.deepEqual(events, []);
  released.resolve();
  await assert.rejects(operation, /model failed/);
  unregister();
  assert.deepEqual(events, ['model', 'restore']);
});

test('cancel during suspension skips the model and still restores once', async () => {
  const { service, run, events } = serviceHarness();
  const released = deferred();
  service.registerCaptionTranslationResources(() => ({ ready: released.promise,
    restore: async () => { events.push('restore'); } }));
  const operation = run();
  await service.cancelNaturalCaptionTranslation();
  released.resolve();
  await assert.rejects(operation, { name: 'CaptionTranslationCancelledError' });
  assert.deepEqual(events, ['cancel', 'restore']);
});

test('release failure restores ownership without starting inference', async () => {
  const { service, run, events } = serviceHarness();
  service.registerCaptionTranslationResources(() => ({ ready: Promise.reject(new Error('release failed')),
    restore: async () => { events.push('restore'); } }));
  await assert.rejects(run(), /release failed/);
  assert.deepEqual(events, ['restore']);
});

test('success preserves translated result ownership and restores once', async () => {
  const { service, run, events } = serviceHarness(async (_uri, request) => {
    assert.equal(request.reuseCheckpoints, true);
    assert.equal(request.repairUnusableOutputs, true);
    return { offline: true, backend: 'cpu', modelId: 'model', promptContract: 'contract', batchCount: 1,
      operations: [{ id: 'op', sourceLanguage: 'en', targetLanguage: 'es', captionCount: 1, batchCount: 1 }],
      captions: [{ id: 'c1', text: 'Hola' }] };
  });
  service.registerCaptionTranslationResources(() => ({ ready: Promise.resolve(),
    restore: async () => { events.push('restore'); } }));
  assert.equal((await run()).operations.get('op').get('cue'), 'Hola');
  assert.deepEqual(events, ['model', 'restore']);
});

// Minimal hook host exercises the real controller with fake native players.
// State changes commit only on render(), matching the surface-detachment barrier.
function videoHarness() {
  const cells = [], cleanups = [], effects = [];
  let cursor = 0, playerCursor = 0, admitted = true;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const effect = (fn, deps) => {
    const index = cursor++;
    if (!same(cells[index], deps)) {
      cells[index] = deps;
      effects.push(() => { cleanups[index]?.(); cleanups[index] = fn(); });
    }
  };
  const react = {
    useRef(value) { const i = cursor++; return cells[i] ??= { current: value }; },
    useState(value) { const i = cursor++; if (!(i in cells)) cells[i] = value;
      return [cells[i], (next) => { cells[i] = typeof next === 'function' ? next(cells[i]) : next; }]; },
    useMemo(fn, deps) { const i = cursor++; if (!same(cells[i]?.deps, deps)) cells[i] = { deps, value: fn() }; return cells[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect: effect, useLayoutEffect: effect,
  };
  const events = [];
  const players = [0, 1].map((slot) => ({ pause() { events.push(`pause:${slot}`); },
    async replaceAsync(uri) { events.push(`replace:${slot}:${uri}`); }, play() { events.push(`play:${slot}`); } }));
  const project = { clips: [], sources: [] };
  const controller = load('src/hooks/use-timeline-video-controller.ts', {
    react, expo: { useEventListener() {} },
    'expo-video': { useVideoPlayer: () => players[playerCursor++] },
    '@/services/video-player-runtime': { configureTimelinePlayer() {} },
    '@/lib/project-timeline': { projectTimelineDuration: () => 10_000,
      projectTimelineSegmentAt: () => ({ kind: 'gap', endMs: 10_000 }) },
    '@/lib/video-timeline': { buildClipTimeline: () => [] },
  });
  let transport;
  const render = () => { cursor = 0; playerCursor = 0;
    transport = controller.useTimelineVideoController(project, () => {}, admitted);
    while (effects.length) effects.shift()();
    return transport; };
  render();
  return { render, events, players, project, background() { admitted = false; render(); },
    foreground() { admitted = true; render(); }, unmount() { for (const cleanup of cleanups) cleanup?.(); } };
}

test('suspension detaches surfaces and unloads both decoders, restoring the same paused position once', async () => {
  const host = videoHarness();
  host.render().seek(1234);
  const lease = host.render().suspendForTranslation();
  await flush();
  assert.equal(host.events.filter((event) => event.startsWith('replace')).length, 0);
  let transport = host.render();
  assert.equal(transport.previewResourcesSuspended, true);
  await lease.ready;
  assert.deepEqual(host.events.filter((event) => event.startsWith('replace')), ['replace:0:null', 'replace:1:null']);
  transport.play(); transport.seek(9876);
  await lease.restore(); await lease.restore();
  transport = host.render();
  assert.equal(transport.currentMs, 1234);
  assert.equal(transport.isPlaying, false);
  assert.equal(transport.previewResourcesSuspended, false);
  assert.equal(host.events.some((event) => event.startsWith('play')), false);
  assert.deepEqual(host.project, { clips: [], sources: [] });
  host.unmount();
});

test('background restoration stays suspended until foreground; unmount cannot revive players', async () => {
  const host = videoHarness();
  host.render().seek(4567);
  const lease = host.render().suspendForTranslation();
  host.render(); await lease.ready;
  host.background(); await lease.restore();
  assert.equal(host.render().phase, 'suspended');
  host.foreground();
  assert.equal(host.render().currentMs, 4567);
  assert.equal(host.render().isPlaying, false);
  const next = host.render().suspendForTranslation();
  host.unmount();
  const count = host.events.length;
  await next.ready; await next.restore(); await lease.restore();
  assert.equal(host.events.length, count);
});
