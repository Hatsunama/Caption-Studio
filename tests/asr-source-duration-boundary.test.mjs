import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

// Execute both real production modules. The only double is an unused caption
// layout dependency; calling it fails so timing tests cannot silently use it.
const context = vm.createContext({
  captionLayoutText() { throw new Error('unused dependency called'); },
});
for (const file of ['primary-caption-timing', 'speech-alignment']) {
  const url = new URL('../src/lib/' + file + '.ts', import.meta.url);
  const executable = stripTypeScriptTypes(readFileSync(url, 'utf8'))
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];[ \t]*/gm, '')
    .replace(/^export /gm, '');
  vm.runInContext(executable, context, { filename: url.href });
}
const align = context.alignWordsToSpeech;
const canonical = context.hasCanonicalSourceWords;
const plain = value => JSON.parse(JSON.stringify(value));
const word = (startMs, endMs, text = 'spoken') => ({ id: 'native-id', text, startMs, endMs });
const vad = [{ t0: 1137, t1: 1203 }];

function expectWords(input, speech, duration, expected) {
  const before = structuredClone(input), failures = [];
  const result = align(input, speech, duration, d => failures.push(d));
  assert.deepEqual(plain(result), expected);
  assert.deepEqual(input, before, 'input must remain unchanged');
  assert.deepEqual(failures, []);
  assert.equal(canonical(result), true);
}

test('12s reported boundary: retain previous word and exclude only unsupported tail', () => {
  expectWords([word(11590, 12000, 'previous'), word(12000, 12087, 'tail')], vad, 12000,
    [{ id: 'word-1', text: 'previous', startMs: 11590, endMs: 12000 }]);
});

test('crossing-positive and fractional support survive with canonical nonoverlap', () => {
  expectWords([word(11590, 12087, 'first'), word(11999.75, 12087, 'last'), word(12000, 12087)], vad, 12000,
    [{ id: 'word-1', text: 'first', startMs: 11590, endMs: 11999.75 },
      { id: 'word-2', text: 'last', startMs: 11999.75, endMs: 12000 }]);
});

test('intersection includes VAD: a crossing word with only out-of-video VAD support is excluded', () => {
  expectWords([word(11990, 12087)], [{ t0: 1200, t1: 1203 }], 12000, []);
  expectWords([word(12010, 12087)], vad, 12000, []);
});

test('unspecified duration still uses the VAD endpoint', () => {
  expectWords([word(11590, 12000), word(12000, 12087)], vad, undefined,
    [{ id: 'word-1', text: 'spoken', startMs: 11590, endMs: 12000 },
      { id: 'word-2', text: 'spoken', startMs: 12000, endMs: 12030 }]);
});

test('ordinary VAD selection, clipping, text/IDs, order, and overlap resolution', () => {
  expectWords([word(500, 600, 'silence'), word(900, 1300, ' Hello '), word(1200, 1500, 'world')],
    [{ t0: 100, t1: 140 }], 2000,
    [{ id: 'word-1', text: ' Hello ', startMs: 1000, endMs: 1200 },
      { id: 'word-2', text: 'world', startMs: 1200, endMs: 1400 }]);
  expectWords([word(1000, 1001)], [{ t0: 100.3, t1: 101 }], 8000, []);
  expectWords([word(1000, 1001)], [{ t0: 100.025, t1: 100.075 }], 8000,
    [{ id: 'word-1', text: 'spoken', startMs: 1000.25, endMs: 1000.75 }]);
  expectWords([word(0, 100)], [], 0, []);
  // Existing selector does not select NaN endpoints; preserve that behavior.
  expectWords([word(12000, NaN), word(NaN, 12087), word(12000, Infinity)], vad, 12000, []);
});

test('invalid explicit durations still reject, even with only tail words', () => {
  for (const duration of [0, -1, NaN, Infinity, -Infinity]) {
    const failures = [];
    assert.throws(() => align([word(12000, 12087)], vad, duration, d => failures.push(d)),
      { message: 'Source word timing quality failure: invalid source duration' });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].rejected.invalidDuration, true);
    assert.equal(failures[0].currentOrigin, null);
  }
});

test('malformed, nonfinite, zero, reversed, equal-onset, and decreasing support still reject', () => {
  for (const words of [
    [word(12000, 12087, ' ')],
    [word(12000, 12000)], [word(12000, 11999)],
    [word(11900, 12000), word(11900, 12000)],
    [word(11950, 12000), word(11900, 12000)],
  ]) {
    const failures = [];
    assert.throws(() => align(words, vad, 12000, d => failures.push(d)), /Source word timing quality failure/);
    assert.equal(failures.length, 1);
  }
});

test('selected nonfinite endpoint retains its canonical rejection', () => {
  assert.throws(() => align([word(11900, Infinity)], vad, 11900),
    { message: 'Source word timing quality failure for word-1' });
});

test('later genuine failure maps accepted indices back past VAD and source-tail filtering', () => {
  const failures = [];
  const words = [word(100, 200), word(12000, 12087), word(11400, 11500),
    word(11600, 11800), word(11600, 11900)];
  assert.throws(() => align(words, vad, 12000, d => failures.push(d)),
    { message: 'Source word timing quality failure for word-2' });
  assert.equal(failures.length, 1);
  const d = plain(failures[0]);
  assert.equal(d.acceptedIndex, 1);
  assert.equal(d.acceptedCount, 3);
  assert.deepEqual(d.previous, { startMs: 11400, endMs: 11500 });
  assert.equal(d.rejected.nonpositiveCappedSupport, true);
  for (const [origin, index, endMs] of [[d.currentOrigin, 3, 11800], [d.nextOrigin, 4, 11900]]) {
    assert.equal(origin.coalescedIndex, index);
    assert.equal(origin.windowIndex, 0);
    assert.deepEqual(origin.window, { startMs: 11370, endMs: 12030 });
    assert.deepEqual(origin.before, { startMs: 11600, endMs });
    assert.deepEqual(origin.after, origin.before);
  }
});


