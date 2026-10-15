import assert from 'node:assert/strict';
import test from 'node:test';
import { createTimelineBoundaryFeedback } from '../src/lib/timeline-boundary-feedback.ts';

function fixture(start = 0, end = 200, boundaries = [100], tolerance = 5) {
  let calls = 0;
  const feedback = createTimelineBoundaryFeedback(() => { calls += 1; });
  feedback.begin(start, end, boundaries, tolerance);
  return { feedback, count: () => calls };
}

test('touches the tolerance edge and suppresses jitter until leaving it', () => {
  const { feedback, count } = fixture();
  for (const start of [94, 95, 99, 101, 98, 105, 100]) feedback.update(start, 200);
  assert.equal(count(), 1);
  feedback.update(106, 200);
  assert.equal(count(), 1, 'leaving the range does not buzz');
  feedback.update(105, 200);
  assert.equal(count(), 2, 'reentry rearms the boundary');
});

test('catches exact touch, crossing and large overshoot at zero tolerance', () => {
  for (const target of [100, 101, 1000]) {
    const { feedback, count } = fixture(0, 200, [100], 0);
    feedback.update(target, 200);
    assert.equal(count(), 1, `target ${target}`);
    feedback.update(target, 200);
    assert.equal(count(), 1);
  }
});

test('catches reverse overshoots and rearms after an overshoot', () => {
  const { feedback, count } = fixture(150, 300);
  feedback.update(50, 300);
  assert.equal(count(), 1);
  feedback.update(150, 300);
  assert.equal(count(), 2);
});

test('coincident and multiple crossed boundaries produce one callback per update', () => {
  const { feedback, count } = fixture(0, 200, [100, 100, 50, 150, 50]);
  feedback.update(175, 200);
  assert.equal(count(), 1);
});

test('both moving endpoints are tracked even when the first one triggers', () => {
  const { feedback, count } = fixture(0, 200, [100, 300]);
  feedback.update(100, 300);
  assert.equal(count(), 1);
  feedback.update(101, 301);
  assert.equal(count(), 1, 'both endpoints must have been latched');
  feedback.update(101, 306);
  feedback.update(101, 300);
  assert.equal(count(), 2, 'end endpoint rearms independently');
});

test('stationary aligned endpoint does not trigger unrelated motion', () => {
  const { feedback, count } = fixture(0, 100);
  feedback.update(10, 100);
  feedback.update(20, 100);
  feedback.update(20, 100);
  assert.equal(count(), 0);
});

test('unchanged applied positions and repeated clamped updates do not buzz', () => {
  const { feedback, count } = fixture();
  feedback.update(0, 200);
  feedback.update(100, 200);
  for (let index = 0; index < 20; index += 1) feedback.update(100, 200);
  assert.equal(count(), 1);
});

test('initial alignment stays quiet on departure and permits later recross', () => {
  const { feedback, count } = fixture(100, 200);
  feedback.update(102, 200);
  feedback.update(106, 200);
  assert.equal(count(), 0);
  feedback.update(90, 200);
  assert.equal(count(), 1);
});

test('sorts, deduplicates and filters a snapshot without mutating caller input', () => {
  const boundaries = [300, NaN, 100, Infinity, 100, -Infinity, 0];
  const original = [...boundaries];
  const { feedback, count } = fixture(-20, 400, boundaries, 0);
  assert.deepEqual(boundaries, original);
  boundaries.fill(999);
  feedback.update(1, 400);
  assert.equal(count(), 1, 'zero boundary survives snapshot normalization');
  feedback.update(101, 400);
  assert.equal(count(), 2);
});

test('empty and entirely invalid boundaries remain quiet', () => {
  for (const boundaries of [[], [NaN, Infinity, -Infinity]]) {
    const { feedback, count } = fixture(0, 200, Object.freeze(boundaries));
    feedback.update(1000, -1000);
    assert.equal(count(), 0);
  }
});

test('negative and nonfinite tolerances behave as zero tolerance', () => {
  for (const tolerance of [-5, NaN, Infinity, -Infinity]) {
    const { feedback, count } = fixture(0, 200, [100], tolerance);
    feedback.update(99, 200);
    assert.equal(count(), 0);
    feedback.update(100, 200);
    assert.equal(count(), 1);
  }
});

test('invalid updates do not poison the last valid applied endpoints', () => {
  const { feedback, count } = fixture();
  feedback.update(NaN, 200);
  feedback.update(100, Infinity);
  assert.equal(count(), 0);
  feedback.update(150, 200);
  assert.equal(count(), 1);
});

test('reset cancels observation and begin starts fresh with replacement boundaries', () => {
  const { feedback, count } = fixture();
  feedback.update(100, 200);
  feedback.reset();
  feedback.reset();
  feedback.update(0, 200);
  assert.equal(count(), 1);
  feedback.begin(0, 200, [50], 0);
  feedback.update(50, 200);
  assert.equal(count(), 2);
  feedback.begin(0, 200, [75], 0);
  feedback.update(50, 200);
  assert.equal(count(), 2);
  feedback.update(75, 200);
  assert.equal(count(), 3);
});

test('update before begin and invalid begin are inactive until a valid restart', () => {
  let calls = 0;
  const feedback = createTimelineBoundaryFeedback(() => { calls += 1; });
  feedback.update(100, 200);
  feedback.begin(0, 200, [100], 0);
  feedback.begin(NaN, 200, [100], 0);
  feedback.update(150, 200);
  feedback.begin(0, Infinity, [100], 0);
  feedback.update(150, 200);
  assert.equal(calls, 0);
  feedback.begin(0, 200, [100], 0);
  feedback.update(100, 200);
  assert.equal(calls, 1);
});
