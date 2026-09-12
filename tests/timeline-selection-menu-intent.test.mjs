import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function loadSelectionModule() {
  const source = readFileSync(new URL('../src/lib/editor-selection.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const module = { exports: {} };
  runInNewContext(outputText, { module, exports: module.exports });
  return module.exports;
}

const { editorLayerSelection, editorSelectionState, shouldOpenEditorTool } = loadSelectionModule();
const plain = (value) => JSON.parse(JSON.stringify(value));

const project = {
  captionTracks: { translations: [{ id: 'zh', pairs: [] }] },
  layers: [
    { id: 'captions', kind: 'captions' },
    { id: 'title', kind: 'text' },
    { id: 'logo', kind: 'image' },
  ],
};

const cases = [
  { selection: { kind: 'video', id: 'video-1' }, tool: 'video', layerId: undefined, clipId: 'video-1' },
  { selection: { kind: 'audio', id: 'audio-1' }, tool: 'audio', layerId: undefined, clipId: undefined },
  { selection: { kind: 'captions', captionId: 'caption-1' }, tool: 'captions', layerId: 'captions', clipId: undefined },
  { selection: { kind: 'translation', id: 'zh', captionId: 'caption-1' }, tool: 'captions', layerId: 'zh', clipId: undefined },
  { selection: { kind: 'text', id: 'title' }, tool: 'stickers', layerId: 'title', clipId: undefined },
  { selection: { kind: 'image', id: 'logo' }, tool: 'stickers', layerId: 'logo', clipId: undefined },
];

for (const scenario of cases) {
  test(`${scenario.selection.kind} selection opens ${scenario.tool}`, () => {
    const state = editorSelectionState(scenario.selection);
    assert.equal(state.tool, scenario.tool);
    assert.equal(state.layerId, scenario.layerId);
    assert.equal(state.clipId, scenario.clipId);
  });
}

test('semantic timeline layers resolve without sticker fallback', () => {
  assert.deepEqual(plain(editorLayerSelection(project, 'captions', 'caption-1')), { kind: 'captions', captionId: 'caption-1' });
  assert.deepEqual(plain(editorLayerSelection(project, 'zh', 'caption-1')), { kind: 'translation', id: 'zh', captionId: 'caption-1' });
  assert.deepEqual(plain(editorLayerSelection(project, 'title')), { kind: 'text', id: 'title' });
  assert.deepEqual(plain(editorLayerSelection(project, 'logo')), { kind: 'image', id: 'logo' });
  assert.equal(editorLayerSelection(project, 'missing'), undefined);
});

test('same-menu selections never request a remount', () => {
  for (const tool of ['captions', 'stickers', 'video', 'audio']) {
    assert.equal(shouldOpenEditorTool(tool, tool), false);
  }
  assert.equal(shouldOpenEditorTool('captions', 'stickers'), true);
  assert.equal(shouldOpenEditorTool('stickers', 'video'), true);
});

test('timeline callbacks use the shared selection boundary', () => {
  const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
  assert.match(editor, /onSelectLayer=\{selectEditorLayer\}/);
  assert.match(editor, /onSelectCaption=\{\(caption\) => selectEditorObject\(/);
  assert.match(editor, /onSelectTranslationCaption=\{\(trackId, pair\) => selectEditorObject\(/);
  assert.match(editor, /onSelectClip=\{\(clipId\) => selectEditorObject\(/);
  assert.match(editor, /onSelectAudioClip=\{\(clipId\) => selectEditorObject\(/);
  assert.match(editor, /if \(!shouldOpenEditorTool\(activeToolRef\.current, tool\)\) return;/);
});
