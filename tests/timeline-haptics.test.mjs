import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

function load(platform, native) {
  const source = readFileSync(new URL('../src/services/timeline-haptics.ts', import.meta.url), 'utf8');
  const exports = {};
  let time = 1000;
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, Date: { now: () => time }, require: (name) => name === 'react-native' ? { Platform: { OS: platform } } : native,
  });
  return { pulse: exports.timelineHaptic, advance(ms) { time += ms; } };
}

test('Android uses platform touch feedback and boundary ticks without a per-frame vibration storm', () => {
  const calls = [];
  const h = load('android', { AndroidHaptics: { Context_Click: 'select', Segment_Tick: 'tick' },
    performAndroidHapticsAsync: async (kind) => calls.push(kind) });
  h.pulse('selection'); h.pulse('selection');
  h.pulse('boundary'); h.pulse('boundary');
  assert.deepEqual(calls, ['select', 'tick']);
  h.advance(100); h.pulse('boundary');
  assert.deepEqual(calls, ['select', 'tick', 'tick']);
});

test('unsupported or rejected haptics never interrupt an editor action', async () => {
  const h = load('android', { AndroidHaptics: {}, performAndroidHapticsAsync: () => Promise.reject(new Error('disabled')) });
  assert.doesNotThrow(() => h.pulse('boundary'));
  await new Promise((resolve) => setImmediate(resolve));
  const sync = load('android', { AndroidHaptics: {}, performAndroidHapticsAsync() { throw new Error('unavailable'); } });
  assert.doesNotThrow(() => sync.pulse('selection'));
});

test('non-Android platforms retain lightweight selection feedback', () => {
  let calls = 0;
  const h = load('ios', { selectionAsync: async () => { calls++; } });
  h.pulse('selection'); h.advance(100); h.pulse('boundary');
  assert.equal(calls, 2);
});
