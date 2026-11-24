import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = process.env.CAPABILITY_SOURCE_ROOT
  ? path.resolve(process.env.CAPABILITY_SOURCE_ROOT) : fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(existsSync(path.join(root, p)) ? path.join(root, p)
  : path.join(process.env.CAPABILITY_BASELINE_ROOT ?? root, p), 'utf8');
const strip = (s) => stripTypeScriptTypes(s, { mode: 'transform' });
const withoutImports = (s) => s.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\r?\n/gm, '').replace(/\bexport /g, '');
const operation = { id: 'op', sourceLanguage: 'en', targetLanguage: 'es', captions: [{ id: 'cue', text: 'Hello' }] };
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Execute the production operation and its ownership/finally paths with
// dependency boundaries instrumented. No copied admission predicate is used.
function serviceHost(support) {
  const calls = [];
  const limits = { maxCaptionsPerBatch: 32, maxOperationsPerSession: 8, maxBatchesPerSession: 32,
    maxCaptionsPerSession: 100, maxCharactersPerCaption: 100, maxCaptionCharactersPerBatch: 100,
    maxCaptionCharactersPerSession: 1000 };
  const context = vm.createContext({
    Error, console, setInterval, clearInterval, calls,
    process: { env: {} },
    TRANSLATION_RELEASE_CONTRACT: { id: 'model', revision: 'r', promptVersion: 1, promptContract: 'contract' },
    CaptionTranslation: {
      limits, async isLocalTranslationSupported() { calls.push('capability'); return typeof support === 'function' ? support() : support; },
      addListener() { calls.push('subscribe'); return { remove() { calls.push('unsubscribe'); } }; },
    },
    canonicalCaptionLanguageTag: (v) => v, resolveCaptionLanguage: (tag) => ({ tag, automaticTranslation: true }),
    validateTranslationUnits: (v) => v, captionTextTail: () => '', captionTextHead: () => '',
    createTranslationBatches: (v) => [v], splitBatchesByContext: (v) => v,
  });
  vm.runInContext(strip(withoutImports(read('src/services/caption-translation.ts'))), context);
  vm.runInContext([
    "registerCaptionTranslationResources(() => { calls.push('resources'); return { ready: Promise.resolve(), restore: async () => calls.push('restore') }; });",
    "translateWithModelRecovery = async (_run, operations) => {",
    "calls.push('model'); calls.push('download'); calls.push('native');",
    "return { offline: true, backend: 'cpu', modelId: 'model', promptContract: 'contract', batchCount: operations.length,",
    "operations: operations.map(op => ({ id: op.id, sourceLanguage: op.sourceLanguage, targetLanguage: op.targetLanguage, batchCount: op.batches.length, captionCount: op.batches.flatMap(b => b.captions).length })),",
    "captions: operations.flatMap(op => op.batches.flatMap(b => b.captions.map(c => ({ id: c.id, text: 'Hola' })))) }; };",
    "validateNativeResult = (_expected, actual) => actual;",
    "reviewTranslatedCaptions = (_prepared, translatedById) => ({ translatedById, needsReview: new Set() });",
  ].join('\n'), context);
  return { calls, context, run: (options) => context.translateNaturalCaptionOperations(options) };
}

for (const support of [false, undefined]) {
  test('shared service denies ' + support + ' before subscription/resources/model/native work', async () => {
    const host = serviceHost(support);
    let failure;
    try { await host.run({ operations: [operation], onAcceptedBatch: async () => {} }); } catch (error) { failure = error; }
    assert.equal(failure?.code, 'E_TRANSLATION_UNSUPPORTED', 'must fail with typed unsupported error');
    assert.deepEqual(host.calls, ['capability']);
  });
}
test('shared service awaits unresolved admission and releases ownership after denial', async () => {
  let resolve;
  const host = serviceHost(() => new Promise((yes) => { resolve = yes; }));
  const running = host.run({ operations: [operation], onAcceptedBatch: async () => {} });
  await tick();
  assert.deepEqual(host.calls, ['capability'], 'pending capability must suspend before side effects');
  resolve(false);
  await assert.rejects(running, { code: 'E_TRANSLATION_UNSUPPORTED' });
  const retry = host.run({ operations: [operation] });
  await tick(); resolve(false);
  await assert.rejects(retry, { code: 'E_TRANSLATION_UNSUPPORTED' });
});
test('supported service retains successful operation/resource cleanup', async () => {
  const host = serviceHost(true);
  const result = await host.run({ operations: [operation] });
  assert.equal(result.operations.get('op').get('cue'), 'Hola');
  assert.deepEqual(host.calls, ['capability', 'resources', 'model', 'download', 'native', 'restore']);
});
test('rejected capability query admits no resources and retains original retryable failure', async () => {
  const failure = new Error('native query temporarily unavailable');
  const host = serviceHost(() => { throw failure; });
  await assert.rejects(host.run({ operations: [operation] }), (e) => e === failure);
  assert.deepEqual(host.calls, ['capability']);
});
test('direct batch entry shares typed admission without acquiring any resources', async () => {
  const h = serviceHost(false);
  await assert.rejects(h.context.translateNaturalCaptionBatch(operation), { code: 'E_TRANSLATION_UNSUPPORTED' });
  assert.deepEqual(h.calls, ['capability']);
});
test('concurrent call cannot bypass pending admission', async () => {
  let resolve;
  const h = serviceHost(() => new Promise(yes => { resolve = yes; }));
  const first = h.run({ operations: [operation] });
  await assert.rejects(h.run({ operations: [operation] }), /already running/);
  resolve(false);
  await assert.rejects(first, { code: 'E_TRANSLATION_UNSUPPORTED' });
  assert.deepEqual(h.calls, ['capability']);
});

const editor = read('src/app/editor.tsx');
function closure(name) {
  const start = editor.indexOf('  const ' + name + ' = ');
  assert.ok(start >= 0, name);
  const end = editor.indexOf('\n  const ', start + 1);
  return editor.slice(start, end < 0 ? undefined : end);
}
function editorHost(supported) {
  const calls = [];
  const track = { id: 'track', languageTag: 'es', displayName: 'Spanish', visible: true,
    cues: [{ sourceCaptionId: 'cue', text: 'Hola', reviewed: true, status: 'stale' }] };
  const project = { captions: [{ id: 'cue', text: 'Hello' }], captionTracks: { translations: [track] } };
  const context = vm.createContext({
    Error, calls, localTranslationSupported: supported, selectedTranslationTrack: track,
    primaryCaptionLanguage: 'en', timelineCaptions: project.captions,
    canOpenDualCaptions: (v) => v === true,
    canAutomaticallyTranslatePair: () => true,
    projectPrimaryCaptionLanguage: () => { calls.push('language'); return 'en'; },
    editorSession: { current: () => project, isCurrent: () => true },
    transport: { pause() { calls.push('pause'); } },
    setSelectedTranslationTrackId: () => calls.push('select'), setDualCaptionEditorOpen: () => calls.push('open'),
    setDualLanguagePickerOpen: () => calls.push('picker'), setError: () => calls.push('error'),
    beginEditCaption() {}, needsTranslationModelDownloadConsent: () => true,
    listDownloadedNaturalTranslationModel: async () => { calls.push('inventory'); return []; },
    naturalTranslationDownloadConsentMessage: () => 'download?',
    Alert: { alert(_title, _body, actions) { calls.push('popup'); actions?.find(a => /Download model|Replace \+ refresh/.test(a.text))?.onPress(); } },
    commitEditorProject: async (apply) => { calls.push('commit'); return { before: project, project: await apply(project) }; },
    selectedCaptionId: 'cue', setSelectedCaptionId() {}, captionTimelineMsRef: { current: 0 },
    replaceVisibleCaptionScript: (p, captions) => ({ ...p, captions }), changedPrimaryCaptionTextIds: () => ['cue'],
    workspaceMountedRef: { current: true }, setTranscriptionCancelling() {}, setProgress() {}, selectEditorObject() {},
    generateAndSaveProjectCaptions: async () => project, CaptionGenerationCancelledError: class extends Error {},
    prepareOptionalDualCaptionTrack: () => ({ project, trackId: track.id, automatic: true }),
    translationController: { refresh: async () => calls.push('refresh'), retry: async () => calls.push('retry'),
      synchronize: async () => { calls.push('manual-save'); return true; } },
  });
  const names = ['openDualCaptionEditor', 'confirmTranslationModelDownload', 'enableDualCaptions',
    'requestTranslationRefresh', 'offerTranslationRefresh', 'commitCaptionScript', 'saveDualCaptionEdits', 'generateCaptions'];
  const retryStart = editor.indexOf('onRetryError={() => {') + 'onRetryError={'.length;
  const retryEnd = editor.indexOf('\n        onBackRequestChange=', retryStart);
  const retry = editor.slice(retryStart, retryEnd).trim().replace(/}$/, '');
  vm.runInContext(strip(names.map(closure).join('\n') + '\nconst retryAction = ' + retry + ';'
    + '\n globalThis.api = { ' + names.join(', ') + ', retryAction };'), context);
  return { context, calls, track };
}
for (const supported of [false, undefined]) {
  for (const action of ['requestTranslationRefresh', 'offerTranslationRefresh', 'enableDualCaptions', 'confirmTranslationModelDownload', 'retryAction']) {
    test('editor ' + action + ' is silent for ' + supported + ' capability', async () => {
      const h = editorHost(supported);
      if (action === 'requestTranslationRefresh' || action === 'offerTranslationRefresh') {
        await h.context.api[action](['cue'], h.track);
      } else await h.context.api[action]('es');
      await tick();
      assert.deepEqual(h.calls, [], 'no consent, popup, resource work, or controller action');
    });
  }
  test('restored track remains open for manual editing with ' + supported + ' capability', () => {
    const h = editorHost(supported); h.context.api.openDualCaptionEditor();
    assert.ok(h.calls.includes('open')); assert.ok(!h.calls.includes('popup'));
    assert.ok(!h.calls.includes('refresh'));
  });
  test('caption edits still save without refresh popups with ' + supported + ' capability', async () => {
    const h = editorHost(supported);
    assert.equal(await h.context.api.commitCaptionScript([{ id: 'cue', text: 'New text' }]), true);
    assert.deepEqual(h.calls, ['commit']);
    h.calls.length = 0;
    assert.equal(await h.context.api.saveDualCaptionEdits([{ sourceCaptionId: 'cue', primaryText: 'New text',
      translatedText: 'Hola', primaryChanged: true }]), true);
    assert.deepEqual(h.calls, ['manual-save']);
  });
  test('regeneration does not trigger translation or consent with ' + supported + ' capability', async () => {
    const h = editorHost(supported);
    await h.context.api.generateCaptions(); await tick();
    assert.deepEqual(h.calls, ['error', 'commit']);
  });
}
test('supported editor still routes refresh through consent and controller', async () => {
  const h = editorHost(true);
  h.track.cues[0].reviewed = false;
  h.context.api.requestTranslationRefresh(['cue'], h.track);
  await tick();
  assert.deepEqual(h.calls, ['language', 'inventory', 'popup', 'select', 'open', 'refresh']);
});
test('actual editor automatic and retry props disable false/unresolved and preserve true', () => {
  const expression = (name, next) => {
    const start = editor.indexOf(name + '={') + name.length + 2;
    return editor.slice(start, editor.indexOf(next, start)).trim().replace(/}$/, '');
  };
  for (const supported of [false, undefined, true]) {
    const h = editorHost(supported);
    h.context.translationController.retryAvailable = true;
    assert.equal(vm.runInContext(expression('automaticTranslation', '\n        busy='), h.context), supported === true);
    assert.equal(vm.runInContext(expression('retryErrorAvailable', '\n        onDismissError='), h.context), supported === true);
    const action = editor.split('\n').find(line => line.includes('<Action label="Refresh this translation"'));
    const disabled = action.match(/disabled=\{([^}]+)\}/)?.[1] ?? 'false';
    assert.equal(vm.runInContext(disabled, h.context), supported !== true);
  }
});

// Execute the actual hook using a deterministic React host. No install needed.
function controllerHost(failure, interrupted = false) {
  const state = [], refs = [], effects = [];
  let si = 0, ri = 0, onState;
  const project = { captions: [{ id: 'cue', text: 'Hello' }], captionTracks: {
    translations: [{ id: 'track', sourceLanguageTag: 'en', languageTag: 'es', cues: [] }] } };
  const source = withoutImports(read('src/hooks/use-project-caption-translation.ts'));
  const context = vm.createContext({
    Error, console,
    useRef: (initial) => refs[ri++] ?? (refs[ri - 1] = { current: initial }),
    useState: (initial) => { const i = si++; if (!(i in state)) state[i] = initial; return [state[i], v => { state[i] = v; }]; },
    useCallback: (fn) => fn, useEffect: (fn) => effects.push(fn), useLayoutEffect: (fn) => fn(),
    AppState: { addEventListener: (_name, fn) => { onState = fn; return { remove() {} }; } },
    CaptionTranslationCancelledError: class CaptionTranslationCancelledError extends Error {},
    isCaptionTranslationUnsupportedError: serviceHost(true).context.isCaptionTranslationUnsupportedError,
    captionLanguageFamily: (v) => v, canAutomaticallyTranslatePair: () => true,
    projectPrimaryCaptionLanguage: () => 'en', visibleTimelineCaptions: (v) => v,
    resolveCaptionPairs: () => [{ timelineVisible: true, source: project.captions[0] }],
    translateNaturalCaptionBatch: async () => {
      if (interrupted) { onState('background'); throw new context.CaptionTranslationCancelledError(); }
      throw failure;
    },
    cancelNaturalCaptionTranslation: async () => true,
  });
  vm.runInContext(strip(source), context);
  const options = { getCurrentProject: () => project, commitProject: async () => {}, commitManualEdits: async () => {} };
  const render = () => { si = 0; ri = 0; return context.useProjectCaptionTranslation(options); };
  const api = render(); effects.forEach(fn => fn());
  return { api, render };
}
test('controller does not advertise or execute futile unsupported Retry', async () => {
  const h = controllerHost(Object.assign(new Error('unsupported'), { code: 'E_TRANSLATION_UNSUPPORTED' }));
  assert.equal(await h.api.refresh('track', ['cue']), false);
  assert.equal(h.render().retryAvailable, false);
  assert.equal(await h.render().retry(), false);
});
test('controller keeps transient network Retry', async () => {
  const h = controllerHost(new Error('network transfer failed'));
  await h.api.refresh('track', ['cue']);
  assert.equal(h.render().retryAvailable, true);
});
test('controller recognizes unsupported failures wrapped by accepted-batch reporting', async () => {
  const native = Object.assign(new Error('unsupported'), { code: 'E_TRANSLATION_UNSUPPORTED' });
  const h = controllerHost(new Error('One batch saved. Refresh to retry unfinished captions.', { cause: native }));
  await h.api.refresh('track', ['cue']);
  assert.equal(h.render().retryAvailable, false);
  assert.equal(await h.render().retry(), false);
});
test('controller keeps foreground interruption Retry', async () => {
  const h = controllerHost(undefined, true);
  await h.api.refresh('track', ['cue']);
  assert.equal(h.render().retryAvailable, true);
});
test('unsupported classification ignores message text and terminates cyclic causes', () => {
  const h = serviceHost(true);
  const error = new Error('unsupported wording alone is transient'); error.cause = error;
  assert.equal(h.context.isCaptionTranslationUnsupportedError(error), false);
  assert.equal(h.context.isCaptionTranslationUnsupportedError({ code: 'E_TRANSLATION_FAILED' }), false);
});
