import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

import { editorSelectionState, shouldOpenEditorTool } from '../src/lib/editor-selection.ts';
import { applyStylePatch, resolveCaptionStyle } from '../src/lib/style-resolver.ts';
import { DEFAULT_CAPTION_STYLE } from '../src/types/project.ts';
import { CaptionGenerationCancelledError } from '../src/services/caption-generation-session.ts';

// Execute the workspace's real callbacks and menu JSX with only native UI,
// persistence, and generation replaced. This catches selection guards and wiring.
const source = ts.createSourceFile('editor.tsx', readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map();
let captionMenu;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isArrowFunction(node.initializer)) {
    callbacks.set(node.name.getText(source), node.initializer.getText(source));
  }
  if (ts.isConditionalExpression(node) && node.condition.getText(source) === 'translationTrackSelected && selectedTranslationTrack'
    && node.whenTrue.getText(source).includes('tool:captions:translation')) {
    captionMenu = node.getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);

function evaluate(expression, context) {
  assert.ok(expression, 'The production callback or menu must exist');
  const { outputText } = ts.transpileModule(`(() => { return (${expression}); })();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
    fileName: 'callback.tsx',
  });
  return runInNewContext(outputText, context);
}

function fixture() {
  return {
    projectStyle: structuredClone(DEFAULT_CAPTION_STYLE),
    captions: ['first', 'second'].map((id) => ({
      id, text: id, startMs: 0, endMs: 1000, wordIds: [],
      styleOverride: { textColor: '#123456', fontSize: 80, italic: true, position: { x: 0.1 }, animation: { id: 'none' } },
    })),
    transcription: { words: [{ id: 'word', styleOverride: { textColor: '#654321', fontSize: 90, italic: true } }] },
    captionTracks: { translations: [] },
  };
}

function workspace(overrides = {}) {
  const state = { project: fixture(), tool: 'video', captionId: 'old', layerId: 'title', clipId: 'video', audioClipId: 'audio', translationTrackId: 'translation' };
  const calls = { undo: [], persisted: [], alerts: [], textStyles: [], pauses: 0 };
  const context = {
    projectRef: { current: state.project },
    workspaceMountedRef: { current: true },
    activeToolRef: { current: state.tool },
    activeTool: 'captions',
    selectedCaptionId: undefined,
    selectedTextLayer: undefined,
    translationTrackSelected: false,
    selectedTranslationTrack: undefined,
    animationScope: 'all',
    editorSelectionState,
    shouldOpenEditorTool,
    applyStylePatch,
    CaptionGenerationCancelledError,
    Error,
    transport: { pause: () => { calls.pauses += 1; } },
    Alert: { alert: (...args) => calls.alerts.push(args) },
    setProject: (next) => { state.project = typeof next === 'function' ? next(state.project) : next; },
    pushUndo: (before = context.projectRef.current) => calls.undo.push(before),
    persistProjectInBackground: (next) => calls.persisted.push(next),
    commitPersistedProject: async (next, commit) => { calls.persisted.push(next); commit(next); },
    findAnimationPreset: () => ({ intensity: 0.8, durationMs: 300 }),
    updateTextLayerStyle: (...args) => calls.textStyles.push(args),
    ...overrides,
  };
  for (const [setter, key] of Object.entries({
    setActiveTool: 'tool', setSelectedCaptionId: 'captionId', setSelectedLayerId: 'layerId',
    setSelectedClipId: 'clipId', setSelectedAudioClipId: 'audioClipId', setSelectedTranslationTrackId: 'translationTrackId',
    setError: 'error', setProgress: 'progress', setTranscriptionCancelling: 'cancelling', setPendingChange: 'pendingChange',
    setScriptEditorOpen: 'scriptEditorOpen',
  })) context[setter] = (value) => { state[key] = value; };
  const callback = (name) => evaluate(callbacks.get(name), context);
  context.openEditorTool = callback('openEditorTool');
  context.selectEditorObject = callback('selectEditorObject');
  return { state, calls, context, callback };
}

for (const tool of ['video', 'audio', 'stickers', 'captions']) {
  test(`successful generation selects the first cue and opens Captions from ${tool}`, async () => {
    const next = fixture();
    const w = workspace({ generateAndSaveProjectCaptions: async () => next });
    w.state.tool = tool;
    w.context.activeToolRef.current = tool;
    await w.callback('generateCaptions')('fast');
    assert.equal(w.state.project, next);
    assert.equal(w.state.captionId, 'first');
    assert.equal(w.state.tool, 'captions');
    assert.equal(w.state.layerId, 'captions');
    for (const key of ['clipId', 'audioClipId', 'translationTrackId']) assert.equal(w.state[key], undefined);
    assert.equal(w.calls.undo.length, 1);
    assert.equal(w.calls.alerts.length, 0);
    assert.equal(w.state.progress, undefined);
  });
}

for (const outcome of ['failure', 'cancellation', 'unmounted']) {
  test(`${outcome} generation does not change selection or menu`, async () => {
    const w = workspace({ generateAndSaveProjectCaptions: async () => {
      if (outcome === 'failure') throw new Error('Generation failed');
      if (outcome === 'cancellation') throw new CaptionGenerationCancelledError();
      w.context.workspaceMountedRef.current = false;
      return fixture();
    } });
    const before = w.state.project;
    await w.callback('generateCaptions')('fast');
    assert.equal(w.state.project, before);
    assert.equal(w.state.captionId, 'old');
    assert.equal(w.state.tool, 'video');
    assert.equal(w.calls.undo.length, 0);
    assert.equal(w.calls.alerts.length, outcome === 'failure' ? 1 : 0);
  });
}

test('empty generation opens Captions without inventing a selection', async () => {
  const next = { ...fixture(), captions: [] };
  const w = workspace({ generateAndSaveProjectCaptions: async () => next });
  await w.callback('generateCaptions')('fast');
  assert.equal(w.state.captionId, undefined);
  assert.equal(w.state.tool, 'captions');
  assert.equal(w.state.clipId, undefined);
});

function renderMenu(w, selectedCaption) {
  return evaluate(captionMenu, {
    ...w.context,
    selectedCaption,
    timelineCaptions: w.state.project.captions,
    React: { createElement: (type, props, ...children) => ({ type, props, children }) },
    PersistedHorizontalScroll: 'scroll', Action: 'action', chrome: { accent: '#FFFFFF' },
    beginEditCaption: w.callback('beginEditCaption'),
    openDualCaptionEditor: () => {},
    confirmDeleteCaption: () => {},
    setFontBrowserOpen: () => {},
    queueCaptionStyleChange: w.callback('queueCaptionStyleChange'),
    beginHistoryInteraction: () => w.calls.undo.push(w.context.projectRef.current),
    updateSharedCaptionTransform: w.callback('updateSharedCaptionTransform'),
    queueMicrotask: (fn) => fn(),
    finishHistoryInteraction: () => w.calls.persisted.push(w.context.projectRef.current),
  }).children.filter(Boolean).map((child) => child.props);
}

for (const selected of [false, true]) {
  test(`caption menu exposes editing and bulk actions with selected=${selected}, without Split/Join`, async () => {
    const w = workspace();
    w.context.timelineCaptions = w.state.project.captions;
    if (selected) w.context.selectedCaptionId = 'first';
    const actions = renderMenu(w, selected ? w.state.project.captions[0] : undefined);
    assert.ok(actions.every(({ label }) => !/split|join/i.test(label)));
    assert.equal(actions.some(({ label }) => label === 'Delete subtitle'), selected);
    const edit = actions.find(({ label }) => label === 'Edit captions');
    assert.equal(edit.disabled, false);
    edit.onPress();
    assert.equal(w.state.scriptEditorOpen, true);
    for (const label of ['Fonts', 'White', 'Lime', 'Active word', 'Uppercase', 'Reset all caption boxes']) {
      assert.ok(actions.some((action) => action.label === label && !action.disabled), label);
    }
    actions.find(({ label }) => label === 'Lime').onPress();
    w.context.pendingChange = w.state.pendingChange;
    await w.callback('chooseStyleScope')('all');
    for (const caption of w.state.project.captions) {
      assert.equal(resolveCaptionStyle(w.state.project.projectStyle, caption).textColor, '#DFFF35');
      assert.equal(caption.styleOverride.italic, true);
    }
    assert.equal(w.state.project.transcription.words[0].styleOverride.textColor, undefined);
    assert.equal(w.calls.persisted.length, 1);
    actions.find(({ label }) => label === 'Reset all caption boxes').onPress();
    for (const caption of w.state.project.captions) {
      const style = resolveCaptionStyle(w.state.project.projectStyle, caption);
      assert.equal(style.position.x, 0.5);
      assert.equal(style.position.y, 0.78);
      assert.equal(style.box.width, 0.86);
      assert.equal(style.fontSize, 48);
      assert.equal(style.italic, true);
    }
    assert.equal(w.state.project.transcription.words[0].styleOverride.fontSize, undefined);
    assert.equal(w.calls.persisted.length, 2);
    assert.equal(w.calls.undo.length, 2);
  });
}

test('empty caption menu disables Edit captions and hides deletion', () => {
  const w = workspace();
  w.state.project.captions = [];
  w.context.timelineCaptions = [];
  const actions = renderMenu(w);
  assert.equal(actions.find(({ label }) => label === 'Edit captions').disabled, true);
  assert.equal(actions.some(({ label }) => label === 'Delete subtitle'), false);
});

test('all-caption animation applies without a cue even with a previously selected text layer', () => {
  const w = workspace({ selectedTextLayer: { id: 'title' } });
  w.callback('chooseAnimation')('fade');
  for (const caption of w.state.project.captions) {
    assert.equal(resolveCaptionStyle(w.state.project.projectStyle, caption).animation.id, 'fade');
  }
  assert.equal(w.calls.textStyles.length, 0);
  assert.equal(w.calls.alerts.length, 0);
  assert.equal(w.calls.persisted.length, 1);
});

test('text animation still targets text in the Stickers menu', () => {
  const w = workspace({ activeTool: 'stickers', selectedTextLayer: { id: 'title' } });
  w.callback('chooseAnimation')('fade');
  assert.equal(w.calls.textStyles[0][0], 'title');
  assert.equal(w.calls.persisted.length, 0);
});

test('single-caption styling remains isolated and requires a caption ID', () => {
  const before = fixture();
  assert.equal(applyStylePatch(before, undefined, 'caption', { textColor: '#FFFFFF' }), before);
  const next = applyStylePatch(before, 'first', 'caption', { textColor: '#FFFFFF' });
  assert.equal(next.captions[0].styleOverride.textColor, '#FFFFFF');
  assert.equal(next.captions[1], before.captions[1]);
  assert.equal(next.projectStyle, before.projectStyle);
});
