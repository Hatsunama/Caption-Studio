import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Diagnostic-branch preflight only. These checks do not prove frame PTS.
const source = readFileSync(new URL('../src/hooks/use-timeline-video-controller.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('controller.ts', source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'traceTailPreview');
const budget = ast.statements.find(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(item => item.name.getText(ast) === 'tailPreviewDiagnosticBudget'));
assert.ok(declaration && budget, 'isolated diagnostic declarations must exist');
const compiled = ts.transpileModule(`${budget.getText(ast)}\nexport ${declaration.getText(ast)}`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function logger(info) {
  const exports = {};
  vm.runInNewContext(compiled, { exports, console: { info } });
  return exports.traceTailPreview;
}

test('isolated preview trace is scalar-only, finite and bounded to 64 records', () => {
  const records = [], trace = logger((...record) => records.push(record));
  const player = { currentTime: 6.385, duration: 8, uri: 'must-never-log-private-uri' };
  for (let i = 0; i < 100; i++) trace(1, 0, i, player, 6385, NaN, Infinity);
  assert.equal(records.length, 64);
  assert.deepEqual(records[0], ['CS_TAIL_PREVIEW', 1, 0, 0, 6385, 8000, 6385, -1, -1]);
  assert.ok(records.every(record => record.slice(1).every(value => typeof value === 'number' && Number.isFinite(value))));
  assert.ok(!JSON.stringify(records).includes(player.uri));
});

test('isolated trace failures and disposed native getters cannot escape', () => {
  const broken = logger(() => { throw new Error('logging unavailable'); });
  assert.doesNotThrow(() => broken(0, 0, 1, { currentTime: 0, duration: 8 }, 0));
  const disposed = logger(() => { throw new Error('must not log disposed values'); });
  assert.doesNotThrow(() => disposed(0, 0, 1, { get currentTime() { throw new Error('disposed'); } }));
});
