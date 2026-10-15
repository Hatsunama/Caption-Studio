import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

function load(platform, native, version = 34) {
  const source = readFileSync(new URL('../src/services/timeline-haptics.ts', import.meta.url), 'utf8');
  const exports = {};
  let time = 1000;
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, Date: { now: () => time }, require: (name) => name === 'react-native' ? { Platform: { OS: platform, Version: version } } : native,
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

for (const version of [24, 26, 29, 30, 33, 34, 35, 36]) {
  test(`Android API ${version} selects a supported boundary effect and preserves throttling`, () => {
    const calls = [];
    const h = load('android', {
      AndroidHaptics: { Context_Click: 'select', Segment_Tick: 'segment', Clock_Tick: 'clock' },
      performAndroidHapticsAsync: async (kind) => calls.push(kind),
    }, version);
    h.pulse('selection'); h.pulse('boundary'); h.pulse('boundary');
    const expected = version >= 34 ? 'segment' : 'clock';
    assert.deepEqual(calls, ['select', expected]);
    h.advance(60); h.pulse('boundary');
    assert.deepEqual(calls, ['select', expected, expected]);
  });
}

test('a rejected older-Android boundary effect remains best-effort', async () => {
  const calls = [];
  const h = load('android', {
    AndroidHaptics: { Clock_Tick: 'clock' },
    performAndroidHapticsAsync(kind) { calls.push(kind); return Promise.reject(new Error('disabled')); },
  }, 24);
  assert.doesNotThrow(() => h.pulse('boundary'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['clock']);
});
