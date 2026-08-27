import assert from 'node:assert/strict';
import test from 'node:test';

import { Buffer } from '../src/shims/safe-buffer.ts';

test('Hermes safe-buffer shim round-trips UTF-8 and base64 audio bytes', () => {
  const utf8 = Buffer.from('字幕 🎙️');
  assert.equal(utf8.toString('utf8'), '字幕 🎙️');
  const encoded = utf8.toString('base64');
  assert.deepEqual([...Buffer.from(encoded, 'base64')], [...utf8]);
});

test('Hermes safe-buffer shim copies arrays, views, and rejects corrupt base64', () => {
  const source = new Uint16Array([0x0201, 0x0403]);
  assert.deepEqual([...Buffer.from(source)], [1, 2, 3, 4]);
  assert.deepEqual([...Buffer.from(source.buffer)], [1, 2, 3, 4]);
  assert.deepEqual([...Buffer.from([1, 2, 255])], [1, 2, 255]);
  assert.throws(() => Buffer.from('not base64!', 'base64'), /Invalid base64/);
});
