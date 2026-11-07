import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function harness() {
  const calls = [], pending = [], exported = {};
  const timers = new Set();
  const native = { configureVideoPlaybackWindow(...args) { calls.push(['start', ...args]);
    return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
    async cancelVideoPlaybackWindow(...args) { calls.push(['cancel', ...args]); } };
  const code = ts.transpileModule(readFileSync(new URL('../src/services/video-playback-window.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  vm.runInNewContext(code, { exports: exported, Error,
    setTimeout(fn) { timers.add(fn); return fn; }, clearTimeout(fn) { timers.delete(fn); },
    require: () => ({ __esModule: true, default: native }) });
  return { configure: exported.configureVideoPlaybackWindow, calls, pending, timers };
}

test('abort cancels exactly its request, unsubscribes, and late completion cannot settle a newer request', async () => {
  const h = harness(), player = {}, first = new AbortController(), second = new AbortController();
  let listeners = 0;
  const add = first.signal.addEventListener.bind(first.signal), remove = first.signal.removeEventListener.bind(first.signal);
  first.signal.addEventListener = (...args) => { listeners++; add(...args); };
  first.signal.removeEventListener = (...args) => { listeners--; remove(...args); };
  const old = h.configure(player, 'uri', 1, 6385, 1000.25, 5000, first.signal);
  const rejected = assert.rejects(old, { name: 'AbortError' });
  first.abort(); await rejected; assert.equal(listeners, 0);
  const next = h.configure(player, 'uri', 2, 6385, 2000, 4000, second.signal);
  h.pending[0].resolve(); await Promise.resolve();
  assert.deepEqual(h.calls.filter(c => c[0] === 'cancel'), [['cancel', player, 1]]);
  assert.equal(h.calls.at(-1)[4], 6385);
  assert.equal(h.calls.at(-1)[5], 2000);
  h.pending[1].resolve(); await next; second.abort();
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls.filter(c => c[0] === 'cancel').length, 1);
});

test('already aborted signal never submits configuration; rejection removes listener', async () => {
  const h = harness(), c = new AbortController(); c.abort();
  await assert.rejects(h.configure({}, 'uri', 3, 6385, 1000.25, 5000, c.signal), { name: 'AbortError' });
  assert.equal(h.calls.length, 0);
  const signal = new AbortController();
  const result = h.configure({}, 'uri', 4, 6385, 1000.25, 5000, signal.signal);
  h.pending[0].reject(new Error('native failure')); await assert.rejects(result, /native failure/);
  signal.abort(); assert.equal(h.calls.filter(c => c[0] === 'cancel').length, 0);
});

test('timeout cancels only the matching request and rejects once despite late native resolution', async () => {
  const h = harness(), c = new AbortController(), player = {};
  const result = h.configure(player, 'uri', 9, 6385, 1000, 17, c.signal);
  const rejected = assert.rejects(result, /timed out/);
  for (const timer of [...h.timers]) timer();
  await rejected; h.pending[0].resolve(); c.abort(); await Promise.resolve();
  assert.deepEqual(h.calls.filter(c => c[0] === 'cancel'), [['cancel', player, 9]]);
  assert.equal(h.timers.size, 0);
});

test('invalid timeout, request identity or bound never reaches native code', async () => {
  const h = harness(), signal = new AbortController().signal;
  for (const timeout of [0, 5001, 1.5, NaN]) await assert.rejects(h.configure({}, 'uri', 1, 6385, 1000, timeout, signal));
  for (const end of [0, -1, 6385.5, Infinity]) await assert.rejects(h.configure({}, 'uri', 1, end, 0, 5000, signal));
  await assert.rejects(h.configure({}, 'uri', Number.MAX_SAFE_INTEGER + 1, 6385, 1000.25, 5000, signal));
  assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 0);
});

test('only finite positive integer ends and finite in-window targets cross native boundary', async () => {
  const h = harness(), signal = new AbortController().signal;
  for (const end of [undefined, null, NaN, Infinity, 0, -1, 6385.5])
    await assert.rejects(h.configure({}, 'uri', 1, end, 0, 5000, signal));
  for (const target of [undefined, null, NaN, Infinity, -1, 6385, 6386])
    await assert.rejects(h.configure({}, 'uri', 1, 6385, target, 5000, signal));
  assert.equal(h.calls.length, 0);
  const ready = h.configure({}, 'uri', 2, 6385, 6384.125, 5000, signal);
  assert.equal(h.calls[0][5], 6384.125); assert.equal(h.calls[0][6], 5000);
  h.pending[0].resolve(); await ready;
});
