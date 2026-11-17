import assert from 'node:assert/strict';
import test from 'node:test';
import { alignWordsToSpeech } from '../src/lib/speech-alignment.ts';

test('a short word outside VAD is filtered rather than selected by a fabricated midpoint', () => {
  const word = { id: 'short', text: 'one', startMs: 1000, endMs: 1001 };
  assert.deepEqual(alignWordsToSpeech([word], [{ t0: 100.3, t1: 101 }], 8000), []);
});

test('actual short-word midpoint and positive clipped support remain usable', () => {
  const word = { id: 'short', text: 'one', startMs: 1000, endMs: 1001 };
  assert.deepEqual(alignWordsToSpeech([word], [{ t0: 100.025, t1: 100.075 }], 8000),
    [{ id: 'word-1', text: 'one', startMs: 1000.25, endMs: 1000.75 }]);
});