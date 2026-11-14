import assert from 'node:assert/strict';
import test from 'node:test';
import { coalesceWhisperWords } from '../src/lib/whisper-words.ts';
import { alignWordsToSpeech } from '../src/lib/speech-alignment.ts';
import { canonicalizeSourceWords } from '../src/lib/primary-caption-timing.ts';

const chain = (segments, speech = [{ t0: 0, t1: 1000 }]) =>
  canonicalizeSourceWords(alignWordsToSpeech(coalesceWhisperWords(segments), speech, 10000), 10000);
const error = /Whisper segment timing quality failure/;
for (const [name, t0, t1] of [
  ['zero', 400, 400], ['negative', -1, 1], ['decreasing', 4, 3],
  ['NaN start', NaN, 3], ['infinite end', 1, Infinity], ['infinite start', Infinity, Infinity],
  ['overflow', 1e308, 1.1e308],
]) test(`lexical ${name} parent rejects in every observer mode`, () => {
  for (const observer of [undefined, () => {}, () => { throw Error('observer'); }]) {
    assert.throws(() => coalesceWhisperWords([{ text: ' private', t0, t1 }], observer), error);
  }
});

test('invalid attached punctuation cannot create or extend an interval', () => {
  for (const text of [',', '!', 'piece']) assert.throws(() => coalesceWhisperWords([
    { text: ' hello', t0: 1, t1: 2 }, { text, t0: 2, t1: 2 },
  ]), error);
});

for (const text of ['a b', 'e\u0301\u00a0中ไทย 한😀', 'a b ' + 'c'.repeat(99), 'longword a b longword']) {
  test(`positive 10ms shared allocation and actual chain: ${text}`, () => {
    const segments = [{ text: ' ' + text, t0: 400, t1: 401 }];
    const events = [];
    const words = coalesceWhisperWords(segments, event => events.push(event));
    assert.deepEqual(chain(segments), words);
    assert.equal(words.map(w => w.text).join(''), text.normalize('NFC').replace(/\s/gu, ''));
    for (const [i, w] of words.entries()) {
      assert.ok(w.startMs >= 4000 && w.endMs <= 4010 && w.endMs > w.startMs);
      if (i) assert.equal(words[i - 1].endMs, w.startMs);
    }
    assert.ok(events.every(e => !e.startFloor && !e.segmentFloor && !e.wordFloor));
    assert.deepEqual(coalesceWhisperWords(segments, () => { throw Error('observer'); }), words);
  });
}

test('ordinary rounded timing, attachments, graphemes and filtered annotations stay exact', () => {
  assert.deepEqual(coalesceWhisperWords([
    { text: ' melan', t0: 100, t1: 120 }, { text: 'oma', t0: 120, t1: 145 },
    { text: ',', t0: 145, t1: 150 }, { text: ' a bb ccc', t0: 160, t1: 180 },
    { text: ' [noise]', t0: 0, t1: 0 },
  ]).map(({text,startMs,endMs}) => [text,startMs,endMs]),
  [['melanoma,',1000,1500],['a',1600,1633],['bb',1633,1700],['ccc',1700,1800]]);
  const events = [];
  coalesceWhisperWords([{ text: ' a bb', t0: 0, t1: 10 }], e => events.push(e));
  assert.equal(events[0].roundEnd, true);
});

test('fractional fallback is local and reports no rounding operations', () => {
  const events = [];
  const words = coalesceWhisperWords([{ text: ' a b ' + 'c'.repeat(99), t0: 400, t1: 401 },
    { text: ' ordinary words', t0: 500, t1: 600 }], e => events.push(e));
  assert.equal(words[1].startMs, 4000 + 10 / 101);
  assert.ok(events.slice(0,3).every(e => !e.roundStart && !e.roundEnd));
  assert.deepEqual(words.slice(3).map(w => [w.startMs,w.endMs]), [[5000,5615],[5615,6000]]);
});

test('unrepresentable distinct fractional boundaries fail without shifting or dropping text', () => {
  assert.throws(() => coalesceWhisperWords([{ text: ' a b ' + 'c'.repeat(99),
    t0: 1e15, t1: 1e15 + 0.125 }]), error);
});

test('submillisecond or rounded-escaping parents keep precise authentic endpoints', () => {
  for (const [t0, t1] of [[100, 100.01], [100.025, 100.085]]) {
    const events = [];
    const words = coalesceWhisperWords([{ text: ' a b', t0, t1 }], e => events.push(e));
    assert.equal(words[0].startMs, t0 * 10);
    assert.equal(words[1].endMs, t1 * 10);
    assert.equal(words[0].endMs, words[1].startMs);
    assert.ok(words.every(w => w.endMs > w.startMs && w.startMs >= t0 * 10 && w.endMs <= t1 * 10));
    assert.ok(events.every(e => !e.roundStart && !e.roundEnd && !e.startFloor && !e.segmentFloor && !e.wordFloor));
  }
});

test('positive native overlap still fails strictly after VAD clipping', () => {
  assert.throws(() => chain([{ text: ' a', t0: 90, t1: 140 },
    { text: ' b', t0: 100, t1: 150 }], [{ t0: 120, t1: 200 }]), /Source word timing quality failure/);
});

test('seeded ordered authentic parents retain bounded support through narrow VAD windows', () => {
  let seed = 657;
  const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32);
  for (let run = 0; run < 160; run++) {
    let cursor = 100;
    const parents = Array.from({length: 8}, (_, i) => {
      const t0 = cursor, t1 = t0 + 1 + Math.floor(random() * 5);
      cursor = t1 + Math.floor(random() * 3);
      return { text: [' a b ' + 'c'.repeat(99), ' 中ไทย', ' 👩‍👩‍👧‍👦 é'][i % 3], t0, t1 };
    });
    const raw = coalesceWhisperWords(parents);
    const left = 1000 + random() * (cursor * 10 - 1000);
    const right = Math.min(cursor * 10, left + 0.1 + random() * 25);
    const speech = [{ t0: left / 10, t1: right / 10 }];
    // Ordered, positive parents must not become invalid solely through VAD.
    // A manufactured short-word midpoint must not hide behind an allowed error.
    const accepted = chain(parents, speech);
    for (const [i, word] of accepted.entries()) {
      assert.ok(word.endMs > word.startMs && word.startMs >= 0 && word.endMs <= 10000);
      assert.ok(word.startMs >= speech[0].t0 * 10 && word.endMs <= speech[0].t1 * 10);
      assert.ok(raw.some(w => w.text === word.text && word.startMs >= w.startMs && word.endMs <= w.endMs));
      if (i) assert.ok(accepted[i-1].endMs <= word.startMs);
    }
  }
});
