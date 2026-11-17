import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { applyTimelineStackOrder, reorderVisualTimelineLayer, setTimelineTrackOrder } from '../src/lib/timeline-tracks.ts';
import { buildTimelineRenderPlan } from '../src/lib/export-render-plan.ts';
import { serializeProjectSnapshot } from '../src/lib/project-schema.ts';
import { decodePersistedProject } from '../src/lib/project-codec.ts';

const source = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('editor.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function handler(name, context) {
  let value;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) value = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(value, `actual editor handler ${name} must exist`);
  const output = ts.transpileModule(`exports.call = ${value.getText(ast)};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {}; runInNewContext(output, { exports, ...context }); return exports.call;
}
function fixture(editable = true) {
  let current = createCaptionProject({ id: 'order-edit', name: 'Order', sources: [{ id: 'source',
    uri: 'file:///video.mp4', storageMode: 'copied', displayName: 'Video', durationMs: 5000,
    width: 1920, height: 1080, rotation: 0, frameRate: 30 }] });
  const image = id => ({ id, kind: 'image', name: id, visible: true, uri: `file:///${id}.png`,
    startMs: 0, endMs: 4000, position: { x: .5, y: .5 }, box: { width: .3, height: .3 }, rotation: 0, opacity: 1 });
  current.layers.push(image('back'), image('front'));
  const initial = current, undo = [], saves = [];
  const context = { project: initial, editorSession: { current: () => current, editable: () => editable },
    pushUndo: before => undo.push(before ?? current),
    setProject: next => { current = typeof next === 'function' ? next(current) : next; },
    persistProjectInBackground: () => saves.push(serializeProjectSnapshot(current)),
    applyTimelineStackOrder, reorderVisualTimelineLayer, setTimelineTrackOrder };
  return { context, initial, undo, saves, current: () => current,
    replace: next => { current = next; }, call: name => handler(name, context) };
}

test('actual editor group reorder changes saved render order with one undo and save', () => {
  const h = fixture(); h.call('reorderTimelineTracks')(['captions', 'images', 'video', 'audio']);
  assert.deepEqual(h.current().layers.map(layer => layer.id), ['back', 'front', 'captions']);
  assert.equal(h.undo.length, 1); assert.equal(h.undo[0], h.initial); assert.equal(h.saves.length, 1);
  const restored = decodePersistedProject(h.saves[0]);
  assert.deepEqual(buildTimelineRenderPlan(restored).layers.map(layer => layer.id), ['back', 'front', 'captions']);
  assert.deepEqual(restored.clips, h.initial.clips); assert.deepEqual(restored.captions, h.initial.captions);
});

test('actual editor item reorder changes the authoritative stack, undo snapshot and persisted export', () => {
  const h = fixture(), move = h.call('reorderTimelineLayer');
  move('back', 0);
  assert.deepEqual(h.current().layers.map(layer => layer.id), ['captions', 'front', 'back']);
  assert.deepEqual(buildTimelineRenderPlan(decodePersistedProject(h.saves[0])).layers.map(layer => layer.id), ['captions', 'front', 'back']);
  assert.equal(h.undo.length, 1); assert.equal(h.undo[0], h.initial); assert.equal(h.saves.length, 1);
  move('back', 0); assert.equal(h.saves.length, 1, 'unchanged drop has no extra history or save');
});

test('blocked sessions and retired project callbacks cannot reorder or save', () => {
  for (const name of ['reorderTimelineTracks', 'reorderTimelineLayer']) {
    const h = fixture(false), call = h.call(name);
    if (name === 'reorderTimelineLayer') call('back', 0); else call(['captions', 'images']);
    assert.equal(h.current(), h.initial); assert.deepEqual(h.undo, []); assert.deepEqual(h.saves, []);
    const live = fixture(), retired = live.call(name);
    const next = { ...live.initial, id: 'replacement' }; live.replace(next);
    if (name === 'reorderTimelineLayer') retired('back', 0); else retired(['captions', 'images']);
    assert.equal(live.current(), next); assert.deepEqual(live.undo, []); assert.deepEqual(live.saves, []);
  }
});
