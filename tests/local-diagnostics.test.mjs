import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeProcessExitReason,
  mergeBoundedExitRecords,
  sanitizeProcessExitRecord,
} from '../src/lib/diagnostic-redaction.ts';

test('process exit reasons decode into safe local categories', () => {
  assert.equal(decodeProcessExitReason(5), 'Native crash');
  assert.equal(decodeProcessExitReason(6), 'App not responding');
  assert.equal(decodeProcessExitReason(999), 'Unknown system exit');
});

test('diagnostics never retain native descriptions or user content', () => {
  const record = sanitizeProcessExitRecord({
    timestampMs: 1234,
    reason: 5,
    description: 'file:///private/My Project/video.mp4 caption secret words',
    pssKb: 20,
    rssKb: 30,
  });
  assert.equal(record?.description, 'Native crash');
  assert.doesNotMatch(JSON.stringify(record), /My Project|video\.mp4|secret words|file:\/\//);
});

test('diagnostics are deduplicated, newest first, and bounded', () => {
  const input = Array.from({ length: 30 }, (_, index) => ({
    timestampMs: 1000 + index,
    reason: 5,
    status: 6,
  }));
  const records = mergeBoundedExitRecords(input.slice(0, 3), [...input, input[29]], 20);
  assert.equal(records.length, 20);
  assert.equal(records[0].timestampMs, 1029);
  assert.equal(records.at(-1)?.timestampMs, 1010);
});
