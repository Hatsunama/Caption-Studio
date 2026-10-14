import assert from 'node:assert/strict';
import test from 'node:test';

import { timelineTouchIntent } from '../src/lib/timeline-touch-intent.ts';

test('touch jitter through eight pixels on either axis remains pending', () => {
  for (const [dx, dy] of [[0, 0], [8, 0], [0, -8], [8, 8], [-8, -8]]) {
    assert.equal(timelineTouchIntent(dx, dy), 'pending', `${dx}, ${dy}`);
  }
});

test('horizontal intent requires slop and at least 1.5 times the vertical displacement', () => {
  for (const sign of [-1, 1]) {
    assert.equal(timelineTouchIntent(sign * 8.01, 0), 'horizontal');
    assert.equal(timelineTouchIntent(sign * 12, 8), 'horizontal');
    assert.equal(timelineTouchIntent(sign * 12, -8), 'horizontal');
    assert.equal(timelineTouchIntent(sign * 11.99, 8), 'pending');
  }
});

test('vertical intent gives scrolling the same threshold in either direction', () => {
  for (const sign of [-1, 1]) {
    assert.equal(timelineTouchIntent(0, sign * 8.01), 'vertical');
    assert.equal(timelineTouchIntent(8, sign * 12), 'vertical');
    assert.equal(timelineTouchIntent(-8, sign * 12), 'vertical');
    assert.equal(timelineTouchIntent(8, sign * 11.99), 'pending');
  }
});

test('ambiguous diagonals remain pending even well outside slop', () => {
  for (const [dx, dy] of [[12, 11], [11, 12], [-100, 100], [100, -90]]) {
    assert.equal(timelineTouchIntent(dx, dy), 'pending');
  }
});

test('invalid coordinates cannot claim an axis', () => {
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assert.equal(timelineTouchIntent(invalid, 0), 'pending');
    assert.equal(timelineTouchIntent(0, invalid), 'pending');
    assert.equal(timelineTouchIntent(invalid, invalid), 'pending');
  }
});

test('classification is pure; the responder owns axis locking and handle-only reorder', () => {
  assert.equal(timelineTouchIntent(0, 20), 'vertical');
  assert.equal(timelineTouchIntent(20, 0), 'horizontal');
  assert.equal(timelineTouchIntent(0, 0), 'pending');
});
