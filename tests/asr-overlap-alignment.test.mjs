import assert from 'node:assert/strict';
import test from 'node:test';
import { coalesceWhisperWords } from '../src/lib/whisper-words.ts';
import { alignWordsToSpeech } from '../src/lib/speech-alignment.ts';
import { canonicalizeSourceWords } from '../src/lib/primary-caption-timing.ts';

for (const [name, segments, speech, expected] of [
  ['two tail onsets', [[790, 800], [795, 800]], [{ t0: 0, t1: 800 }], [[7900, 7950], [7950, 8000]]],
  ['three tail onsets', [[790, 800], [794, 800], [795, 800]], [{ t0: 0, t1: 800 }], [[7900, 7940], [7940, 7950], [7950, 8000]]],
  ['interior overlap', [[100, 200], [150, 250]], [{ t0: 0, t1: 800 }], [[1000, 1500], [1500, 2500]]],
  ['positive sub-10ms support', [[799, 800]], [{ t0: 0, t1: 799.5 }], [[7990, 7995]]],
  ['logical duration caps padded VAD', [[790, 805], [799.5, 805]], [{ t0: 0, t1: 810 }], [[7900, 7995], [7995, 8000]]],
]) {
  test(`real coalesce → align → canonical preserves ${name}`, () => {
    const raw = coalesceWhisperWords(segments.map(([t0, t1], index) => ({ text: ` Token${index}`, t0, t1 })));
    const output = canonicalizeSourceWords(alignWordsToSpeech(raw, speech, 8000), 8000);
    assert.equal(output.length, raw.length);
    assert.deepEqual(output.map(({ id, text, startMs }) => ({ id, text, startMs })), raw.map(({ id, text, startMs }) => ({ id, text, startMs })));
    assert.deepEqual(output.map(({ startMs, endMs }) => [startMs, endMs]), expected);
  });
}

for (const [name, segments, speech] of [
  ['equal onsets', [[100, 200], [100, 250]], [{ t0: 0, t1: 800 }]],
  ['decreasing onsets', [[150, 200], [100, 250]], [{ t0: 0, t1: 800 }]],
  ['accepted start outside source', [[801, 803]], [{ t0: 0, t1: 810 }]],
]) {
  test(`alignment explicitly rejects ${name}`, () => {
    const raw = coalesceWhisperWords(segments.map(([t0, t1], index) => ({ text: ` Token${index}`, t0, t1 })));
    assert.throws(() => alignWordsToSpeech(raw, speech, 8000), /Source word timing quality failure/);
  });
}

test('accepted intervals without positive support explicitly fail', () => {
  for (const [startMs, endMs] of [[800, 800], [800, 790]]) {
    assert.throws(() => alignWordsToSpeech([{ id: 'bad', text: 'Bad', startMs, endMs }], [{ t0: 0, t1: 100 }], 8000), /Source word timing quality failure/);
  }
});

test('VAD filtering and legitimate left-window clipping remain intact', () => {
  const raw = coalesceWhisperWords([
    { text: ' Silence', t0: 0, t1: 10 },
    { text: ' Left', t0: 90, t1: 130 },
    { text: ' Interior', t0: 150, t1: 180 },
    { text: ' Silence', t0: 300, t1: 320 },
  ]);
  const output = alignWordsToSpeech(raw, [{ t0: 100, t1: 200 }], 8000);
  assert.deepEqual(output.map(({ text, startMs, endMs }) => [text, startMs, endMs]), [['Left', 1000, 1300], ['Interior', 1500, 1800]]);
  assert.deepEqual(alignWordsToSpeech(raw, [], 8000), []);
});
