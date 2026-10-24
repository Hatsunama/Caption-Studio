import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const cue = (id, startMs, endMs, extra = {}) => Object.freeze({ id, startMs, endMs, ...extra });
const load = () => import('../src/lib/caption-timeline-anchor.ts');
test('anchor selects active visible valid cues, half-open boundaries and nearest gap endpoints without mutation', async () => {
  const { captionAtTimelinePosition: at } = await load();
  const a = cue('a', 0, 100), b = cue('b', 300, 400), hidden = cue('hidden', 150, 250, { timelineVisible: false });
  const captions = Object.freeze([a, hidden, cue('bad', NaN, 999), cue('reversed', 900, 500), cue('zero', 200, 200), b]);
  assert.equal(at(captions, 50), a); assert.equal(at(captions, 350), b);
  assert.equal(at(captions, 190), a); assert.equal(at(captions, 220), b);
  assert.equal(at(captions, 200), a, 'equal gap distance keeps first array entry');
  assert.equal(at([a, cue('next', 100, 150)], 100)?.id, 'next');
  assert.equal(at(captions, -50), a); assert.equal(at(captions, 9999), b);
  assert.equal(at([], 10), undefined); assert.equal(at([hidden], 200), undefined);
  assert.equal(at(captions, NaN), undefined); assert.equal(at(captions, Infinity), undefined);
  assert.equal(at([b, a], 200), b, 'array order deterministically resolves ties');
  assert.equal(at([a, cue('overlap', 20, 80)], 50), a);
});

const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('editor.tsx', editor, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate) { let result; const walk = node => { if (predicate(node)) result = node; ts.forEachChild(node, walk); }; walk(ast); assert.ok(result); return result; }
function evaluate(expression, context) {
  const code = ts.transpileModule(`const result = (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return runInNewContext(`${code}\nresult`, context);
}
test('main initial cue follows paused shared clock over stale selection', async () => {
  const helpers = await load();
  const attribute = find(node => ts.isJsxAttribute(node) && node.name.getText(ast) === 'initialCaptionId');
  const a = cue('old', 0, 100), b = cue('late', 9000, 9500);
  assert.equal(evaluate(attribute.initializer.expression.getText(ast), { ...helpers, timelineCaptions: [a, b], currentMs: 9200, selectedCaptionId: a.id, activeCaption: a }), b.id);
});
test('main deleted selection fallback uses latest clock after async save', async () => {
  const helpers = await load(); let finish, selected;
  const captions = [cue('early', 0, 100), cue('late', 9000, 9500)];
  const captionTimelineMsRef = { current: 50 };
  const declaration = find(node => ts.isVariableDeclaration(node) && node.name.getText(ast) === 'commitCaptionScript');
  const commit = evaluate(declaration.initializer.getText(ast), {
    ...helpers, captionTimelineMsRef, currentMs: 50, selectedCaptionId: 'deleted',
    commitEditorProject: () => new Promise(resolve => { finish = resolve; }),
    replaceVisibleCaptionScript() {}, editorSession: { isCurrent: () => true },
    setSelectedCaptionId: value => { selected = value; }, changedPrimaryCaptionTextIds: () => [],
  });
  const saved = commit(captions); captionTimelineMsRef.current = 9200;
  finish({ before: {}, project: { captions, captionTracks: { translations: [] } } });
  assert.equal(await saved, true); assert.equal(selected, 'late');
});
