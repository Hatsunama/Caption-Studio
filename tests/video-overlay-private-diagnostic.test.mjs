// PRIVATE diagnostic branch only. Offline observation checks, never native-rendering proof.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL('..', import.meta.url));
const relative = 'src/components/editor/video-layer-overlay.tsx';
const ts = require(path.join(repo, 'node_modules/typescript'));
const source = fs.readFileSync(process.env.CAPTION_STUDIO_DIAGNOSTIC_SOURCE || path.join(repo, relative), 'utf8').replace(/\r\n/g, '\n');
const ast = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate) {
  let result;
  function visit(node) {
    if (!result && predicate(node)) result = node;
    if (!result) ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(result, 'actual source AST node exists');
  return result;
}
function evaluate(node, context) {
  const js = ts.transpileModule(`(${node.getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return vm.runInNewContext(js, context, { timeout: 1000 });
}
const probeArrow = find(node => ts.isVariableDeclaration(node) && node.name.getText(ast) === 'probe')
  .initializer.arguments[0];
assert.ok(ts.isArrowFunction(probeArrow));
function fixture(state = { seconds: 2, playing: false }) {
  const logs = [];
  const getterCalls = [];
  const subscriptions = new Map();
  const removed = [];
  const player = new Proxy({}, {
    get(_target, key) {
      if (key === 'addListener') return (name, callback) => {
        assert.equal(subscriptions.has(name), false, 'no extra subscriptions');
        subscriptions.set(name, callback);
        return { remove: () => removed.push(name) };
      };
      getterCalls.push(String(key));
      throw new Error(`native getter forbidden: ${String(key)}`);
    },
  });
  let monotonic = 100;
  const context = { player, state, probeRows: { current: 0 },
    performance: { now: () => ++monotonic }, console: { info: (...args) => logs.push(args) } };
  const probe = evaluate(probeArrow, context);
  context.probe = probe;
  return { logs, getterCalls, subscriptions, removed, context, probe };
}
function row(log) {
  assert.equal(log[0], 'CSOverlayEvent', 'new tag cannot be parsed as old CSOverlayDiag CSV');
  assert.equal(log.length, 2);
  const cells = log[1].split(',');
  assert.equal(cells.length, 7, 'event,row,monotonic,targetSeconds,desiredPlaying,extra1,extra2');
  for (const cell of cells) {
    assert.match(cell, /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i);
    assert.ok(Number.isFinite(Number(cell)));
  }
  return cells.map(Number);
}
test('actual probe logs with throwing native getters and makes zero getter calls', () => {
  const f = fixture();
  f.probe(6);
  assert.equal(f.logs.length, 1, `log required; native getter calls: ${f.getterCalls.join(',')}`);
  assert.deepEqual(f.getterCalls, []);
  assert.deepEqual(row(f.logs[0]), [6, 1, 101, 2, 0, 0, 0]);
});
test('actual probe caps at 120 rows and preserves monotonic row order', () => {
  const f = fixture({ seconds: 48, playing: true });
  for (let i = 0; i < 125; i++) f.probe(2);
  assert.equal(f.logs.length, 120);
  f.logs.forEach((log, i) => assert.deepEqual(row(log), [2, i + 1, 101 + i, 48, 1, 0, 0]));
  assert.deepEqual(f.getterCalls, []);
});
test('actual probe emits only finite numeric cells, including hostile/nonfinite inputs', () => {
  const secret = 'file:///private/secret-name.mp4';
  const f = fixture({ seconds: Infinity, playing: false });
  f.probe(5, NaN, secret);
  f.probe(secret, { uri: secret }, -Infinity);
  assert.equal(f.logs.length, 2);
  assert.deepEqual(row(f.logs[0]), [5, 1, 101, -1, 0, -1, -1]);
  assert.deepEqual(row(f.logs[1]), [-1, 2, 102, -1, 0, -1, -1]);
  assert.ok(!JSON.stringify(f.logs).includes(secret));
  assert.deepEqual(f.getterCalls, []);
});
test('actual subscription callback uses delivered status/duration and removes both listeners', () => {
  const f = fixture();
  const effect = find(node => ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
    && node.arguments[0].getText(ast).includes('addListener'));
  const cleanup = evaluate(effect.arguments[0], f.context)();
  assert.deepEqual([...f.subscriptions.keys()], ['statusChange', 'sourceLoad']);
  for (const status of ['idle', 'loading', 'readyToPlay', 'error', 'unknown']) {
    f.subscriptions.get('statusChange')({ status, error: { message: 'PRIVATE' } });
  }
  f.subscriptions.get('sourceLoad')({ duration: 12.5, videoSource: { uri: 'PRIVATE' } });
  cleanup();
  assert.deepEqual(f.removed, ['statusChange', 'sourceLoad']);
  assert.deepEqual(f.logs.map(log => { const r = row(log); return [r[0], r[5], r[6]]; }),
    [[1, 0, 0], [4, 0, 0], [4, 1, 0], [4, 2, 0], [4, 3, 0], [4, -1, 0], [5, 12.5, 0], [9, 0, 0]]);
  assert.ok(!JSON.stringify(f.logs).includes('PRIVATE'));
  assert.deepEqual(f.getterCalls, []);
});
test('actual VideoView callbacks log RN layout payload and first-frame event without getters', () => {
  const f = fixture();
  function handler(name) {
    const attr = find(node => ts.isJsxAttribute(node) && node.name.getText(ast) === name);
    return evaluate(attr.initializer.expression, f.context);
  }
  handler('onFirstFrameRender')();
  handler('onLayout')({ nativeEvent: { layout: { width: 320, height: 180, x: 99, y: 88 } } });
  assert.deepEqual(f.logs.map(log => { const r = row(log); return [r[0], r[5], r[6]]; }),
    [[6, 0, 0], [7, 320, 180]]);
  assert.deepEqual(f.getterCalls, []);
});
test('removing only diagnostics exactly recovers e8e0bf0 original application source', () => {
  const originalHash = 'dd1d2f81c5e8fdf59fa8012618514c1fba05f2b3a96e54deb5550aaad3fd0309';
  const recovered = source
    .replace("import { useCallback, useEffect, useRef } from 'react';", "import { useEffect } from 'react';")
    .replace(/  \/\/ PRIVATE numeric-only observation;[^]*?(?=\n  useEffect\(\(\) => \{\n    configureOverlayPlayer)/, '')
    .replace(/^    probe\([23]\);\n/gm, '')
    .replace('[player, state.playing, state.seconds, probe]', '[player, state.playing, state.seconds]')
    .replace(/ onFirstFrameRender=\{\(\) => probe\(6\)\}/, '')
    .replace(/ onLayout=\{[^\n]*?\} style=/, ' style=');
  assert.equal(createHash('sha256').update(recovered).digest('hex'), originalHash, 'all original logic, thresholds, geometry, props, suspension and VideoView preserved');
  assert.equal((source.match(/useRef\(/g) || []).length, 1);
  assert.equal((source.match(/addListener\(/g) || []).length, 2);
  assert.doesNotMatch(source, /setTimeout|setInterval|requestAnimationFrame/);
});
