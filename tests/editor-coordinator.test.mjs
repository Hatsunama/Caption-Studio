import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

import { createCaptionProject } from '../src/lib/project-factory.ts';
import { resolveEditorRuntimePolicy } from '../src/lib/editor-runtime-policy.ts';

const requireLocal = createRequire(import.meta.url);
const source = readFileSync(process.env.CAPTION_EDITOR_SOURCE
  ?? new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('editor.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const workspace = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'EditorWorkspace');
const returnNode = workspace.body.statements.find(ts.isReturnStatement);
// Execute the complete workspace. Capture its actual event handlers before JSX
// returns; production code has no test exports or alternate implementation.
const captured = [
  'project', 'editorSession', 'scriptEditorOpen', 'setProject', 'setPendingChange',
  'setSelectedLayerId', 'setSelectedCaptionId', 'setEditingLayerId', 'setEditingText',
  'setScriptDraftCaptions', 'setScriptKeyboardOpen', 'setFontBrowserOpen',
  'commitCaptionScript', 'commitTextLayerText', 'chooseStyleScope', 'queueCaptionStyleChange',
  'setCanvasPreset', 'generateCaptions', 'addVideosToTimeline', 'addAudio', 'addProjectVideoAudio',
  'beginEditCaption', 'updateSharedCaptionTransform', 'beginHistoryInteraction',
  'finishHistoryInteraction', 'undo', 'redo', 'persistProjectInBackground',
].join(', ');
const instrumented = source.slice(0, returnNode.getStart(ast))
  + '__capture({' + captured + '});\n'
  + source.slice(returnNode.getStart(ast))
  + '\nexports.Workspace = EditorWorkspace; exports.createSession = createEditorSession; exports.fitRect = fitRect;\n';
const compiled = ts.transpileModule(instrumented, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  fileName: 'editor.tsx',
}).outputText;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture() {
  const project = createCaptionProject({
    id: 'editor-test', name: 'Original',
    sources: [{
      id: 'video', uri: 'file:///test/video.mp4', displayName: 'Video', storageMode: 'copied',
      width: 1080, height: 1920, rotation: 0, frameRate: 30, durationMs: 6000,
    }],
  });
  project.lifecycle.status = 'saved';
  project.captions = [0, 1000, 3000].map((startMs, index) => ({
    id: 'cue-' + index, text: 'Primary ' + index, startMs, endMs: startMs + 1000, wordIds: [],
  }));
  project.captionTracks.translations = [{
    id: 'fr', kind: 'translation', sourceTrackId: 'captions', sourceLanguageTag: 'en',
    languageTag: 'fr', displayName: 'French', visible: true, origin: 'manual', provider: { id: 'manual' },
    cues: project.captions.map((cue, index) => ({
      id: 'fr:' + cue.id, sourceCaptionId: cue.id, sourceTextSnapshot: cue.text,
      text: 'Secondary ' + index, reviewed: true, status: 'reviewed',
      startMs: [500, 3000, 4000][index], endMs: [2500, 3500, 5000][index],
      translationSkipped: index === 2, timelineVisible: true,
    })),
  }];
  return project;
}

function mount(initialProject = fixture()) {
  const slots = [], pendingWrites = [], listeners = new Map();
  let cursor = 0, dirty = true, effects = [], tree, actions, appState = 'active', disk = initialProject;
  const calls = { writes: [], alerts: [], audio: [], synchronizations: [], plays: 0, pauses: 0, exits: [], selections: [] };
  let translationOptions, waveform;
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory, deps) => {
    const index = cursor++;
    if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { value: factory(), deps };
    return slots[index].value;
  };
  const react = {
    useMemo: memo, useCallback: (callback, deps) => memo(() => callback, deps),
    useRef: (value) => memo(() => ({ current: value }), []),
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (value) => {
        const next = typeof value === 'function' ? value(slots[index].value) : value;
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true; }
      }];
    },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) effects.push(() => {
        slots[index]?.cleanup?.();
        slots[index] = { deps, cleanup: callback() };
      });
    },
  };
  const transport = {
    currentMs: 600, isPlaying: false, players: ['a', 'b'], activeSlot: 0, phase: 'ready', isGap: false,
    pause() { transport.isPlaying = false; calls.pauses += 1; dirty = true; },
    play() { transport.isPlaying = true; calls.plays += 1; dirty = true; },
    seek(ms) { transport.currentMs = ms; dirty = true; },
    synchronizeProject(project) { calls.synchronizations.push(project); },
  };
  const write = async (next) => {
    calls.writes.push(next);
    const gate = pendingWrites.shift();
    if (gate) await gate.promise;
    disk = next;
    return next;
  };
  const services = {
    checkpointEditorProject: write,
    saveEditorDraft: async (latest) => { calls.exits.push(['save', latest]); return write(latest); },
    discardEditorSession: async (_initial, latest) => { calls.exits.push(['discard', latest]); disk = _initial; },
    cancelProjectCaptionGeneration: async () => true, cancelProjectVideoExport: async () => {},
    validateProjectSources: async () => {},
    TRANSCRIPTION_MODEL_OPTIONS: [], NATURAL_TRANSLATION_MODEL_LABEL: 'Test',
    ProjectPersistenceError: class ProjectPersistenceError extends Error {},
    CaptionGenerationCancelledError: class CaptionGenerationCancelledError extends Error {},
    VideoExportCancelledError: class VideoExportCancelledError extends Error {},
    changedPrimaryCaptionTextIds: (before, next) => next.captions.filter((cue) =>
      before.captions.find((old) => old.id === cue.id)?.text !== cue.text).map((cue) => cue.id),
  };
  const navigation = {
    addListener(name, callback) { listeners.set(name, callback); return () => listeners.delete(name); },
    dispatch(action) { calls.exits.push(['dispatch', action]); },
  };
  const hooks = {
    useTimelineVideoController: () => transport,
    useTimelineAudioController: (project, ms, playing, admitted) => calls.audio.push({ project, ms, playing, admitted }),
    useProjectAudioWaveforms: (_project, admitted, callback) => { waveform = { admitted, callback }; },
    useProjectCaptionTranslation: (options) => {
      translationOptions = options;
      return { busy: false, cancelling: false, refresh: async () => true, cancel: async () => {} };
    },
    useForegroundOperation: () => ({}),
    useEditorRuntimePolicy: (blockingUi) => resolveEditorRuntimePolicy({ appState, blockingUi }),
  };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const native = Object.fromEntries(['ActivityIndicator', 'Modal', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View'].map((name) => [name, name]));
  native.Alert = { alert: (...args) => calls.alerts.push(args) };
  native.useWindowDimensions = () => ({ width: 360, height: 800 });
  const exports = {};
  runInNewContext(compiled, {
    exports, Error, setTimeout, clearTimeout, queueMicrotask, __capture: (value) => { actions = value; },
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === 'react-native') return native;
      if (name === 'expo-router') return { useNavigation: () => navigation };
      if (name === 'expo-video') return { VideoView: 'VideoView' };
      if (name === 'react-native-safe-area-context') return { useSafeAreaInsets: () => ({ bottom: 0 }) };
      if (name.startsWith('@/components/')) return new Proxy({}, { get: (_object, key) => key });
      if (name.startsWith('@/hooks/')) return hooks;
      if (name.startsWith('@/services/')) return services;
      if (name === '@/lib/ui-theme') return { chrome: { radius: { md: 8, pill: 16 } } };
      if (name === '@/lib/font-catalog') return {};
      if (name.startsWith('@/lib/')) return requireLocal('../src/lib/' + name.slice('@/lib/'.length) + '.ts');
      throw new Error('Unexpected workspace dependency: ' + name);
    },
  });
  function render() {
    let passes = 0;
    do {
      assert.ok(++passes < 25, 'workspace must settle');
      dirty = false; cursor = 0; effects = [];
      tree = exports.Workspace({ initialProject });
      for (const effect of effects) effect();
    } while (dirty);
  }
  function all(predicate, node = tree, result = []) {
    if (!node || typeof node !== 'object') return result;
    if (Array.isArray(node)) { for (const child of node) all(predicate, child, result); return result; }
    if (predicate(node)) result.push(node);
    all(predicate, node.props?.children ?? null, result);
    return result;
  }
  render();
  return {
    calls, services, transport, exports, render, all,
    get actions() { return actions; }, get project() { return actions.editorSession.current(); },
    get disk() { return disk; }, set disk(value) { disk = value; },
    get waveform() { return waveform; }, get translation() { return translationOptions; },
    holdWrite() { const gate = deferred(); pendingWrites.push(gate); return gate; },
    async flush() { await tick(); render(); await tick(); render(); },
    appState(value) { appState = value; render(); },
    exit(decision) {
      listeners.get('beforeRemove')({ preventDefault() {}, data: { action: { type: 'GO_BACK' } } });
      const label = decision === 'save' ? 'Save draft' : 'Discard';
      calls.alerts.at(-1)[2].find((button) => button.text === label).onPress();
      render();
    },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

test('queued publications derive from the latest durable revision and serialize their writes', async () => {
  const h = mount(), gate = h.holdWrite(), session = h.actions.editorSession;
  const baselines = [];
  const first = session.commit((before) => ({ ...before, name: 'First' }));
  const second = session.commit((before) => { baselines.push(before.name); return { ...before, name: 'Second' }; });
  await h.flush();
  assert.equal(h.project.name, 'Original', 'no publication before persistence');
  assert.equal(h.calls.writes.length, 1);
  assert.deepEqual(baselines, []);
  gate.resolve();
  const [oldReceipt, receipt] = await Promise.all([first, second]);
  assert.deepEqual(baselines, ['First']);
  assert.equal(session.isCurrent(oldReceipt), false);
  assert.equal(session.isCurrent(receipt), true);
  assert.equal(h.disk.name, 'Second');
  assert.equal(h.project.updatedAt, receipt.before.updatedAt, 'ordering does not depend on timestamp uniqueness');
  h.actions.undo(); await h.flush();
  assert.equal(h.project.name, 'First');
  h.actions.undo(); await h.flush();
  assert.equal(h.project.name, 'Original');
});

for (const fail of [false, true]) {
  test('an awaited ' + (fail ? 'failed' : 'successful') + ' write cannot roll back a newer gesture or its history', async () => {
    const h = mount(), gate = h.holdWrite(), session = h.actions.editorSession;
    const pending = session.commit((before) => ({ ...before, name: 'Stale' }));
    const rejected = assert.rejects(pending, fail ? /storage failed/ : /Newer edits were kept/);
    await h.flush();
    h.actions.beginHistoryInteraction();
    h.actions.updateSharedCaptionTransform({ fontSize: 64 });
    h.actions.finishHistoryInteraction();
    const newer = h.project;
    if (fail) gate.reject(new Error('storage failed')); else gate.resolve();
    await rejected; await h.flush();
    assert.equal(h.project, newer);
    assert.equal(h.disk, newer, 'the latest revision also owns the durable checkpoint');
    h.actions.undo(); await h.flush();
    assert.equal(h.project.name, 'Original');
    assert.notEqual(h.project.projectStyle.fontSize, 64);
    h.actions.redo(); await h.flush();
    assert.equal(h.project, newer, 'failed async actions do not clear newer redo history');
  });
}

test('reverting to the same project object still invalidates an in-flight publication', async () => {
  const h = mount(), initial = h.project, gate = h.holdWrite();
  const pending = h.actions.editorSession.commit((before) => ({ ...before, name: 'Stale' }));
  const rejected = assert.rejects(pending, /Newer edits were kept/);
  await h.flush();
  h.actions.setProject({ ...initial, name: 'Intervening edit' });
  h.actions.setProject(initial);
  gate.resolve(); await rejected;
  assert.equal(h.project, initial);
  assert.equal(h.disk, initial);
});

test('background checkpoints drain newer revisions before the next project workflow starts', async () => {
  const h = mount(), session = h.actions.editorSession, gate = h.holdWrite();
  const checkpoint = session.checkpoint();
  await h.flush();
  session.update((before) => ({ ...before, name: 'Latest gesture' }));
  let startedWith;
  const pending = session.commit((before) => { startedWith = before; return { ...before, name: 'After gesture' }; });
  gate.resolve(); await checkpoint; await pending;
  assert.equal(startedWith.name, 'Latest gesture');
  assert.deepEqual(h.calls.writes.map((project) => project.name), ['Original', 'Latest gesture', 'After gesture']);
});

test('a workflow that checkpoints and then fails restores the current session and releases the queue', async () => {
  const h = mount(), session = h.actions.editorSession, initial = h.project;
  await assert.rejects(session.commit(async (before) => {
    h.disk = { ...before, name: 'Partial generation' };
    throw new Error('generation failed');
  }, true), /generation failed/);
  assert.equal(h.disk, initial);
  await session.commit((before) => ({ ...before, name: 'Retry' }));
  assert.equal(h.project.name, 'Retry');
});

for (const decision of ['save', 'discard']) {
  test(decision + ' drains accepted publications, freezes new edits, and closes the session before navigation', async () => {
    const h = mount(), gate = h.holdWrite(), session = h.actions.editorSession;
    const pending = session.commit((before) => ({ ...before, name: 'Queued edit' }));
    await h.flush();
    h.exit(decision);
    session.update((before) => ({ ...before, name: 'Too late' }));
    await assert.rejects(session.commit((before) => ({ ...before, name: 'Rejected' })), /leaving the editor/);
    assert.equal(h.calls.exits.length, 0);
    gate.resolve(); await pending; await h.flush();
    assert.equal(h.calls.exits[0][0], decision);
    assert.equal(h.calls.exits[0][1].name, 'Queued edit');
    assert.equal(h.calls.exits[1][0], 'dispatch');
    const writes = h.calls.writes.length;
    session.update((before) => ({ ...before, name: 'Resurrect' }));
    await session.checkpoint();
    assert.equal(h.calls.writes.length, writes, 'no checkpoint may resurrect a discarded session');
  });
}

test('failed exit keeps the session editable and can be retried', async () => {
  const h = mount();
  h.services.saveEditorDraft = async () => { throw new Error('full disk'); };
  h.exit('save'); await h.flush();
  assert.equal(h.actions.editorSession.editable(), true);
  assert.equal(h.calls.exits.length, 0);
  h.actions.setProject((before) => ({ ...before, name: 'Still editing' }));
  h.services.saveEditorDraft = async (latest) => latest;
  h.exit('save'); await h.flush();
  assert.equal(h.project.name, 'Still editing');
  assert.equal(h.calls.exits.at(-1)[0], 'dispatch');
});

test('unmount invalidates queued work and an in-flight receipt even if the session is reactivated', async () => {
  const h = mount(), gate = h.holdWrite(), initial = h.project, session = h.actions.editorSession;
  const first = session.commit((before) => ({ ...before, name: 'Late' }));
  const rejectedFirst = assert.rejects(first, /session has closed/);
  let ran = false;
  const second = session.commit((before) => { ran = true; return before; });
  const rejectedSecond = assert.rejects(second, /session has closed/);
  await h.flush(); h.unmount(); session.activate(); gate.resolve();
  await Promise.all([rejectedFirst, rejectedSecond]);
  assert.equal(ran, false);
  assert.equal(h.project, initial);
});

const persistedActions = {
  canvas: (h) => h.actions.setCanvasPreset('square'),
  'caption style': (h) => {
    h.actions.setPendingChange({ label: 'Color', patch: { textColor: '#ABCDEF' } }); h.render();
    return h.actions.chooseStyleScope('all');
  },
  'translation style': (h) => {
    h.actions.setSelectedLayerId('fr'); h.render();
    return h.actions.queueCaptionStyleChange('Color', { textColor: '#ABCDEF' });
  },
  'primary script': (h) => {
    h.actions.beginEditCaption(); h.render();
    return h.actions.commitCaptionScript(h.project.captions.map((cue) => ({ ...cue, text: 'Saved draft' })));
  },
  'dual translation': (h) => h.translation.commitProject(h.project, { ...h.project, name: 'Translated' }),
  'text layer': (h) => {
    h.actions.setEditingLayerId('title'); h.actions.setEditingText('New title'); h.render();
    return h.actions.commitTextLayerText();
  },
};
for (const [label, invoke] of Object.entries(persistedActions)) {
  test('actual ' + label + ' handler cannot republish a snapshot over a newer project edit', async () => {
    const project = fixture();
    project.layers.push({
      id: 'title', kind: 'text', name: 'Title', text: 'Old title', startMs: 0, endMs: 5000,
      style: project.projectStyle, visible: true,
    });
    const h = mount(project), gate = h.holdWrite();
    const pending = Promise.resolve(invoke(h)).catch(() => {});
    await h.flush();
    assert.equal(h.calls.writes.length, 1, 'the production handler must reach persistence');
    h.actions.updateSharedCaptionTransform({ fontSize: 72 });
    const newer = h.project;
    gate.resolve(); await pending; await h.flush();
    assert.equal(h.project, newer);
    assert.equal(h.disk, newer);
    if (label === 'primary script') assert.equal(h.actions.scriptEditorOpen, true, 'conflict must leave the draft editor open');
  });
}

for (const kind of ['videos', 'audio', 'extracted audio', 'generation']) {
  test('actual ' + kind + ' workflow is serialized and cannot overwrite edits made while it persists', async () => {
    const h = mount(), gate = deferred();
    const operation = async (before) => {
      await gate.promise;
      const next = { ...before, name: 'Imported snapshot' };
      h.disk = next; // These existing workflows persist internally.
      return kind === 'audio' || kind === 'extracted audio' ? { project: next, clip: { id: 'new' } } : next;
    };
    Object.assign(h.services, {
      appendVideosToProject: operation, appendAudioToProject: operation,
      appendProjectVideoAudioToProject: operation, generateAndSaveProjectCaptions: operation,
    });
    const pending = kind === 'videos' ? h.actions.addVideosToTimeline()
      : kind === 'audio' ? h.actions.addAudio('audio-file')
        : kind === 'extracted audio' ? h.actions.addProjectVideoAudio('video')
          : h.actions.generateCaptions('fast');
    await h.flush();
    h.actions.updateSharedCaptionTransform({ fontSize: 68 });
    const newer = h.project;
    const queued = h.actions.editorSession.commit((before) => ({ ...before, name: 'Next action' }));
    gate.resolve(); await pending; await queued; await h.flush();
    assert.equal(h.project.projectStyle, newer.projectStyle);
    assert.equal(h.project.name, 'Next action');
    assert.equal(h.disk, h.project);
    assert.deepEqual(h.calls.synchronizations, [], 'late import must not retarget transport');
    assert.ok(h.calls.alerts.some((alert) => String(alert[1]).includes('Newer edits were kept')));
  });
}

test('waveform publication participates in the same revision check as user edits', async () => {
  const project = fixture();
  project.audioSources = [{ id: 'audio', uri: 'file:///test/audio.m4a', storageMode: 'copied' }];
  const h = mount(project), gate = h.holdWrite(), session = h.actions.editorSession;
  const pending = session.commit((before) => ({ ...before, name: 'Stale' }));
  const rejected = assert.rejects(pending, /Newer edits were kept/);
  await h.flush();
  h.waveform.callback({ sourceId: 'audio', sourceUri: 'file:///test/audio.m4a', waveformPeaks: [0.2, 0.8], waveformVersion: 2 });
  gate.resolve(); await rejected; await h.flush();
  assert.deepEqual(plain(h.project.audioSources[0].waveformPeaks), [0.2, 0.8]);
  assert.equal(h.disk, h.project);
});

test('portrait, square and landscape preview geometry share the positive actual ratio', () => {
  for (const [width, height] of [[9, 16], [1, 1], [16, 9]]) {
    const project = fixture();
    project.canvas = { ...project.canvas, aspectWidth: width, aspectHeight: height };
    const h = mount(project);
    for (const keyboard of [false, true]) {
      h.actions.beginEditCaption(); h.actions.setScriptKeyboardOpen(keyboard); h.render();
      const transition = h.all((node) => node.type === 'VideoTransitionOverlay')[0].props;
      assert.ok(Math.abs(transition.width / transition.height - width / height) < 1e-10);
      const canvas = h.all((node) => node.type === 'View' && node.props.style?.borderRadius === 20)[0].props.style;
      assert.equal(canvas.width, transition.width);
      assert.equal(canvas.height, transition.height);
    }
  }
  const h = mount();
  for (const ratio of [0, -1, Infinity, NaN]) {
    assert.deepEqual(plain(h.exports.fitRect(ratio, 100, 200)), { width: 100, height: 100 });
  }
  assert.deepEqual(plain(h.exports.fitRect(9 / 16, 100, -5)), { width: 0, height: 0 });
});

function captions(h) {
  return h.all((node) => node.type === 'CaptionOverlay' && node.props.caption).map((node) => node.props);
}

test('primary and secondary preview intervals resolve independently at boundaries, gaps and paused seeks', () => {
  const h = mount();
  h.actions.setSelectedCaptionId('cue-2'); h.render();
  for (const [ms, expected] of [
    [499, ['Primary 0']], [500, ['Primary 0', 'Secondary 0']],
    [1000, ['Primary 1', 'Secondary 0']], [2000, ['Secondary 0']],
    [2499, ['Secondary 0']], [2500, []], [3000, ['Primary 2', 'Secondary 1']],
    [3500, ['Primary 2']], [4000, []],
  ]) {
    for (const playing of [false, true]) {
      h.transport.currentMs = ms; h.transport.isPlaying = playing; h.render();
      assert.deepEqual(captions(h).map((overlay) => overlay.caption.text), expected, String(ms) + ' playing=' + playing);
    }
  }
});

test('primary script editing keeps independently timed secondary captions below live drafts, splits and joins', () => {
  const h = mount(), savedCaptions = plain(h.project.captions);
  h.actions.beginEditCaption(); h.render();
  for (const text of ['Live draft', 'Split draft', 'Joined draft', '']) {
    const draft = [{ id: 'draft-only-id', text, startMs: 1800, endMs: 2600, wordIds: [] }];
    h.actions.setScriptDraftCaptions(draft); h.actions.setSelectedCaptionId('draft-only-id');
    for (const playing of [false, true]) {
      h.transport.currentMs = 2100; h.transport.isPlaying = playing; h.render();
      const overlays = captions(h);
      assert.deepEqual(overlays.map((overlay) => overlay.caption.text), [text, 'Secondary 0']);
      const secondary = overlays[1];
      assert.equal(secondary.caption.startMs, 500);
      assert.equal(secondary.caption.endMs, 2500);
      assert.ok(secondary.projectStyle.position.y > overlays[0].projectStyle.position.y);
    }
  }
  assert.deepEqual(plain(h.project.captions), savedCaptions, 'draft preview never persists the primary script');
  assert.equal(h.calls.writes.length, 0);
  h.transport.currentMs = 2500; h.render();
  assert.equal(captions(h).some((overlay) => overlay.caption.text === 'Secondary 0'), false);
  h.actions.setProject((before) => ({
    ...before, captionTracks: { ...before.captionTracks,
      translations: before.captionTracks.translations.map((track) => ({ ...track, visible: false })) },
  }));
  h.transport.currentMs = 2100; h.render();
  assert.equal(captions(h).length, 1, 'hidden secondary tracks stay hidden in the script editor');
});

test('script Play/Pause admits companion audio and transitions together, including with the keyboard open', () => {
  const h = mount();
  h.actions.beginEditCaption(); h.render();
  for (const keyboard of [false, true]) {
    h.actions.setScriptKeyboardOpen(keyboard); h.render();
    const play = h.all((node) => node.props.accessibilityLabel === 'Play video')[0];
    assert.equal(play.props.disabled, false);
    play.props.onPress(); h.render();
    assert.equal(h.transport.isPlaying, true);
    assert.equal(h.calls.audio.at(-1).admitted, true);
    assert.equal(h.calls.audio.at(-1).playing, true);
    const transition = h.all((node) => node.type === 'VideoTransitionOverlay')[0].props;
    assert.equal(transition.admitted, true);
    assert.equal(transition.isPlaying, true);
    assert.equal(h.waveform.admitted, false, 'script playback does not admit background waveform extraction');
    h.all((node) => node.props.accessibilityLabel === 'Pause video')[0].props.onPress(); h.render();
    assert.equal(h.transport.isPlaying, false);
    assert.equal(h.calls.audio.at(-1).playing, false);
  }
  h.transport.play(); h.render(); h.appState('background');
  assert.equal(h.transport.isPlaying, false);
  const blockedPlay = h.all((node) => node.props.accessibilityLabel === 'Play video')[0];
  assert.equal(blockedPlay.props.disabled, true);
  blockedPlay.props.onPress(); h.render();
  assert.equal(h.transport.isPlaying, false);
  assert.equal(h.calls.audio.at(-1).admitted, false);
  assert.equal(h.all((node) => node.type === 'VideoTransitionOverlay')[0].props.admitted, false);
  h.appState('active'); h.actions.setFontBrowserOpen(true); h.render();
  assert.equal(h.all((node) => node.props.accessibilityLabel === 'Play video')[0].props.disabled, true);
});
