import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { transformSync } from 'esbuild';

import { createPreviewSceneController } from '../src/lib/preview-scene-controller.ts';

function declaration(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `production declaration ${signature} must be found`);
  const opening = source.indexOf('{', start + signature.length);
  assert.ok(opening >= 0, `production declaration ${signature} must have a body`);
  let depth = 0;
  for (let index = opening; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`production declaration ${signature} must have a closing brace`);
}

const projectEditorSource = readFileSync(new URL('../src/lib/project-editor.ts', import.meta.url), 'utf8');
const isolatedProjectEditor = transformSync([
  declaration(projectEditorSource, 'function updateProject<'),
  declaration(projectEditorSource, 'export function duplicateVisualLayer('),
].join('\n'), { loader: 'ts', format: 'cjs' }).code;
const projectEditorModule = { exports: {} };
new Function('module', 'exports', isolatedProjectEditor)(projectEditorModule, projectEditorModule.exports);
const { duplicateVisualLayer } = projectEditorModule.exports;

const geometry = {
  position: { x: 0.5, y: 0.5 },
  box: { width: 0.3, height: 0.3 },
  rotation: 0,
  scale: 1,
  scaleX: 1,
  scaleY: 1,
};

function layer(kind, id) {
  return kind === 'image'
    ? { id, kind, name: id, visible: true, uri: 'file:///sticker.png', startMs: 0, endMs: 3000, ...geometry, opacity: 1 }
    : { id, kind, name: id, visible: true, text: id, startMs: 0, endMs: 3000, style: geometry };
}

test('Duplicate rejects a project already at the visual-layer limit without mutating it', () => {
  const layers = [{ id: 'captions', kind: 'captions', name: 'Captions', visible: true },
    ...Array.from({ length: 4999 }, (_, index) => ({ id: `image-${index}`, kind: 'image', name: 'Image' }))];
  const project = { layers, updatedAt: 'before' };
  const result = duplicateVisualLayer(project, 'image-0', 'image-copy');

  assert.ok(result === undefined, 'a 5,001st visual layer must be rejected before publication');
  assert.equal(project.layers, layers, 'the original layer array must remain untouched');
  assert.equal(project.layers.length, 5000);
  assert.equal(project.updatedAt, 'before');
  assert.equal(project.layers.some((item) => item.id === 'image-copy'), false);
});

for (const kind of ['image', 'text']) {
  test(`exactly overlapping ${kind} duplicates can each be selected by repeated preview taps`, () => {
    const original = layer(kind, 'original');
    const project = { layers: [{ id: 'captions', kind: 'captions' }, original], updatedAt: 'before' };
    const duplicated = duplicateVisualLayer(project, original.id, 'copy');
    assert.ok(duplicated);
    const targets = duplicated.project.layers.filter((item) => item.kind === kind)
      .map((item, order) => ({ key: item.id, selection: item.id, order,
        geometry: kind === 'text' ? item.style : item }));
    const selections = [];
    let selectedKey;
    const controller = createPreviewSceneController();
    const configure = () => controller.configure({
      targets, selectedKey, enabled: true,
      onSelect(id) { selectedKey = id; selections.push(id); },
      onClearSelection() { selectedKey = undefined; },
      onChange() {}, onDelete() {}, onInteractionStart() {}, onInteractionEnd() {},
    });
    controller.layout({ width: 400, height: 300 });
    configure();
    for (let tap = 0; tap < 2; tap++) {
      controller.grant([{ id: tap, x: 200, y: 150 }], { pageX: 0, pageY: 0 });
      controller.release();
      configure();
    }

    assert.deepEqual(selections, ['copy', 'original'],
      'a second tap at the same point must reach the object beneath the duplicate');
  });
}

test('UI Duplicate does not publish or select an optimistic copy when durable save fails', async (t) => {
  const source = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const duplicateSelectedVisual = async () => {');
  const end = source.indexOf('\n  const splitSelectedVisualAtPlayhead', start);
  assert.ok(start >= 0 && end > start, 'the production Duplicate handler must be found');
  const handler = source.slice(start, end);
  const initial = { layers: [{ id: 'captions', kind: 'captions' }, layer('image', 'original')], updatedAt: 'before' };
  let visible = initial;
  let selected = 'original';
  let undoCount = 0;
  let saveAttempts = 0;
  let saveError;
  const failedSave = async () => { saveAttempts++; throw new Error('disk full'); };
  const names = ['selectedLayer', 'editorSession', 'uniqueId', 'duplicateVisualLayer', 'pushUndo',
    'setProject', 'persistProjectInBackground', 'selectEditorObject', 'commitEditorProject'];
  const values = [initial.layers[1], { current: () => visible }, () => 'copy', duplicateVisualLayer,
    () => { undoCount++; }, (next) => { visible = typeof next === 'function' ? next(visible) : next; },
    () => { void failedSave().catch((error) => { saveError = error; }); },
    (object) => { selected = object.id; },
    async (operation) => {
      const next = operation(visible);
      if (!next) return null;
      try { await failedSave(); } catch (error) { saveError = error; throw error; }
      return { before: visible, project: next };
    }];
  const duplicate = new Function(...names, `${handler}\nreturn duplicateSelectedVisual;`)(...values);

  try { await duplicate(); } catch (error) { assert.match(error.message, /disk full/); }
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(saveAttempts > 0, 'Duplicate must attempt durable persistence');
  assert.match(saveError?.message ?? '', /disk full/, 'the failed durable save must be observed');
  await t.test('failed save leaves the published project unchanged', () => {
    assert.ok(visible === initial, 'failed save must leave the published project unchanged');
  });
  await t.test('failed save does not select an unsaved copy', () => {
    assert.equal(selected, 'original', 'failed save must not select an unsaved copy');
  });
  await t.test('failed save does not add an undo entry', () => {
    assert.equal(undoCount, 0, 'failed save must not add an undo entry for an unpublished copy');
  });
});
