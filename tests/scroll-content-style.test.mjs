import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Execute the actual pure projection comparator; native application is tested
// separately. Explicit undefined keys can clear different base style values.
const source = readFileSync(new URL('../src/components/spring-scroll-content.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('spring-scroll-content.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'sameContentStyle');
assert.ok(declaration);
const exports = {};
runInNewContext(ts.transpileModule(declaration.getText(tree), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports });
const same = exports.sameContentStyle;

test('different explicit undefined keys cannot hide different native base-property clears', () => {
  assert.equal(same({ opacity: undefined }, { width: undefined }), false);
  assert.equal(same({ width: undefined }, { opacity: undefined }), false);
});
test('fresh filtered objects with identical values do not cause projection feedback', () => {
  const transform = [{ translateY: 7 }];
  assert.equal(same({ transform, opacity: 0.4 }, { opacity: 0.4, transform }), true);
  assert.equal(same({ opacity: undefined }, { opacity: undefined }), true);
});
test('changed values, omitted keys and changed compound values remain observable', () => {
  assert.equal(same({ opacity: 0.4 }, { opacity: 0.5 }), false);
  assert.equal(same({ opacity: undefined }, {}), false);
  assert.equal(same({ transform: [{ translateY: 7 }] }, { transform: [{ translateY: 7 }] }), false);
});
test('missing and unchanged snapshots are stable', () => {
  const style = { opacity: 0.4 };
  assert.equal(same(style, style), true);
  assert.equal(same(undefined, undefined), true);
  assert.equal(same(undefined, style), false);
  assert.equal(same(style, undefined), false);
});
