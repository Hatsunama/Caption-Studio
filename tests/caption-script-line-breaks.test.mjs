import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { splitCaptionScriptBlock, updateCaptionScriptInput, updateCaptionScriptText } from '../src/lib/caption-script.ts';
import { remapCaptionsToTimeline } from '../src/lib/video-timeline.ts';

const words = [
  { id: 'one', text: 'hello', startMs: 1_000, endMs: 1_200 },
  { id: 'two', text: 'world', startMs: 1_400, endMs: 2_000 },
];

function cue(overrides = {}) {
  return {
    id: 'cue', text: 'hello world', startMs: 1_000, endMs: 2_000,
    textMode: 'automatic', timingMode: 'source', timelineVisible: true,
    wordIds: words.map(({ id }) => id),
    sourceAnchor: { clipId: 'clip', sourceStartMs: 4_000, sourceEndMs: 6_000, wordIds: words.map(({ id }) => id) },
    styleOverride: { textColor: '#19D98B' },
    ...overrides,
  };
}

function input(captions, text, timedWords = words, captionId = 'cue') {
  let sequence = 0;
  return updateCaptionScriptInput(captions, captionId, text, timedWords, (current) => {
    let id;
    do { id = `split-${++sequence}`; } while (current.some((caption) => caption.id === id));
    return id;
  });
}

function assertIntegrity(original, captions) {
  assert.equal(captions[0].startMs, original.startMs);
  assert.equal(captions.at(-1).endMs, original.endMs);
  assert.equal(new Set(captions.map(({ id }) => id)).size, captions.length);
  assert.deepEqual(captions.flatMap(({ wordIds }) => wordIds), original.wordIds);
  for (let index = 0; index < captions.length; index += 1) {
    const caption = captions[index];
    assert.ok(caption.text.trim());
    assert.ok(Number.isFinite(caption.startMs) && Number.isFinite(caption.endMs));
    assert.ok(caption.endMs - caption.startMs >= 80);
    assert.equal(caption.textMode, 'manual');
    assert.deepEqual(caption.styleOverride, original.styleOverride);
    assert.equal(caption.timelineVisible, original.timelineVisible);
    if (index) assert.equal(captions[index - 1].endMs, caption.startMs);
    if (original.sourceAnchor) {
      const ratio = (original.sourceAnchor.sourceEndMs - original.sourceAnchor.sourceStartMs) / (original.endMs - original.startMs);
      assert.equal(caption.timingMode, 'source');
      assert.equal(caption.sourceAnchor.clipId, original.sourceAnchor.clipId);
      assert.deepEqual(caption.sourceAnchor.wordIds, caption.wordIds);
      assert.equal(caption.sourceAnchor.sourceStartMs, original.sourceAnchor.sourceStartMs + (caption.startMs - original.startMs) * ratio);
      assert.equal(caption.sourceAnchor.sourceEndMs, original.sourceAnchor.sourceStartMs + (caption.endMs - original.startMs) * ratio);
    } else {
      assert.equal(caption.timingMode, 'timeline');
      assert.equal(caption.sourceAnchor, undefined);
    }
  }
}

test('Enter splits at every interior position of a single word, with or without word timing', () => {
  for (const timedWords of [[], [words[0]]]) {
    const original = cue({ text: 'hello', wordIds: timedWords.map(({ id }) => id), sourceAnchor: undefined });
    for (let cursor = 1; cursor < original.text.length; cursor += 1) {
      const result = input([original], `${original.text.slice(0, cursor)}\n${original.text.slice(cursor)}`, timedWords);
      assert.deepEqual(result.captions.map(({ text }) => text), [original.text.slice(0, cursor), original.text.slice(cursor)]);
      assert.equal(result.focusedId, result.captions[1].id);
      assert.equal(result.captions[0].endMs, 1_000 + cursor * 200);
      assertIntegrity(original, result.captions);
    }
  }
});

test('deleting the space between words then pressing Enter preserves the requested boundary', () => {
  const original = cue();
  const joined = updateCaptionScriptText([original], 'cue', 'helloworld');
  for (const cursor of [2, 5, 7]) {
    const result = input(joined, `${joined[0].text.slice(0, cursor)}\n${joined[0].text.slice(cursor)}`);
    assert.deepEqual(result.captions.map(({ text }) => text), [joined[0].text.slice(0, cursor), joined[0].text.slice(cursor)]);
    assert.equal(result.captions[0].endMs, 1_000 + cursor * 100);
    assertIntegrity(original, result.captions);
  }
  assert.equal(original.text, 'hello world');
});

test('manual within-word splits use proportional timing even when other spoken boundaries exist', () => {
  const original = cue();
  const result = splitCaptionScriptBlock([original], 'cue', 2, words, 'right');
  assert.ok(result);
  assert.deepEqual(result.captions.map(({ text }) => text), ['he', 'llo world']);
  assert.equal(result.captions[0].endMs, 1_000 + 1_000 * 2 / 11);
  assertIntegrity(original, result.captions);
});

test('existing spoken-word splits keep word timing and consume only boundary spacing', () => {
  const original = cue();
  for (const text of ['hello\n world', 'hello \nworld', 'hello\nworld']) {
    const result = input([original], text);
    assert.deepEqual(result.captions.map(({ text }) => text), ['hello', 'world']);
    // Replacing a selected space with Enter leaves no spoken boundary in the
    // edited text, so its timing is proportional rather than word-snapped.
    assert.equal(result.captions[0].endMs, text === 'hello\nworld' ? 1_500 : 1_300);
    assertIntegrity(original, result.captions);
  }
});

test('missing word timing never drops or duplicates caption and source-anchor word references', () => {
  const original = cue({ wordIds: ['one', 'missing', 'two'] });
  original.sourceAnchor.wordIds = [...original.wordIds];
  for (const timedWords of [[], words]) {
    const result = input([original], 'he\nllo world', timedWords);
    assertIntegrity(original, result.captions);
  }
});

test('splits preserve unrelated captions, source words, styling, and existing whitespace', () => {
  const original = cue({ text: 'hello  wide\nworld' });
  const neighbor = cue({ id: 'neighbor', startMs: 3_000, endMs: 4_000 });
  const captions = [original, neighbor];
  const snapshot = structuredClone({ captions, words });
  const result = input(captions, 'he\nllo  wide\nworld');
  assert.deepEqual(result.captions.slice(0, 2).map(({ text }) => text), ['he', 'llo  wide\nworld']);
  assert.equal(result.captions[2], neighbor);
  assert.deepEqual({ captions, words }, snapshot);
  assertIntegrity(original, result.captions.slice(0, 2));
});

test('source-anchored fragments retain their text and boundaries after timeline remapping', () => {
  const original = cue();
  const result = input([original], 'he\nllo world');
  const remapped = remapCaptionsToTimeline(result.captions, [{
    id: 'clip', sourceId: 'source', sourceStartMs: 2_000, sourceEndMs: 8_000,
    playbackRate: 2, gapBeforeMs: 0, gapAfterMs: 0,
  }], words);
  for (let index = 0; index < remapped.length; index += 1) {
    const { startMs, endMs, ...content } = remapped[index];
    const { startMs: expectedStart, endMs: expectedEnd, ...expectedContent } = result.captions[index];
    assert.deepEqual(content, expectedContent);
    assert.ok(Math.abs(startMs - expectedStart) < 1e-9);
    assert.ok(Math.abs(endMs - expectedEnd) < 1e-9);
  }
  assert.equal(remapped[0].endMs, remapped[1].startMs);
});

test('replacing selected text with Enter preserves exactly the remaining content', () => {
  const original = cue();
  const result = input([original], 'hel\norld');
  assert.deepEqual(result.captions.map(({ text }) => text), ['hel', 'orld']);
  assertIntegrity(original, result.captions);
});

test('multiple pasted line breaks and repeated Enter create unique contiguous captions', () => {
  const original = cue({ text: 'helloworld' });
  const first = input([original], 'he\nllo\nworld');
  assert.deepEqual(first.captions.map(({ text }) => text), ['he', 'llo', 'world']);
  assert.equal(first.focusedId, first.captions[2].id);
  assertIntegrity(original, first.captions);
  const second = input(first.captions, 'wo\nrld', words, first.focusedId);
  assert.deepEqual(second.captions.map(({ text }) => text), ['he', 'llo', 'wo', 'rld']);
  assertIntegrity(original, second.captions);
});

test('Enter keeps literal edge and blank lines without creating empty timed captions', () => {
  for (const text of ['\nhello', 'hello\n', '\n', '\n\nhello']) {
    const original = cue({ text: 'hello' });
    const result = input([original], text);
    assert.equal(result.captions.length, 1);
    assert.deepEqual(result.captions[0], { ...original, text, textMode: 'manual' });
    assert.equal(result.focusedId, 'cue');
  }
  const result = input([cue({ text: 'hello' })], 'he\n\nllo');
  assert.deepEqual(result.captions.map(({ text }) => text), ['he\n', 'llo']);
});

test('short cues retain newlines and subsequent edits instead of losing text or retrying old breaks', () => {
  const original = cue({ endMs: 1_159 });
  const first = input([original], 'he\nllo world');
  assert.deepEqual(first.captions, [{ ...original, text: 'he\nllo world', textMode: 'manual' }]);
  const longer = [{ ...first.captions[0], endMs: 2_000 }];
  for (const text of ['he\nllo world!', 'he\nllo worl', 'hello world']) {
    const result = input(longer, text);
    assert.equal(result.captions.length, 1);
    assert.equal(result.captions[0].text, text);
  }
});

test('minimum-duration splits are clamped and invalid splits cannot damage captions', () => {
  const original = cue({ text: 'hello', startMs: 0, endMs: 160, sourceAnchor: undefined });
  const result = input([original], 'h\nello');
  assert.deepEqual(result.captions.map(({ startMs, endMs }) => [startMs, endMs]), [[0, 80], [80, 160]]);
  assertIntegrity(original, result.captions);
  for (const cursor of [0, 5, -1, 100, NaN, Infinity]) {
    assert.equal(splitCaptionScriptBlock([original], 'cue', cursor, words, 'right'), null);
  }
  assert.equal(splitCaptionScriptBlock([original], 'cue', 2, words, 'cue'), null);
  assert.equal(splitCaptionScriptBlock([original], 'absent', 2, words, 'right'), null);
  for (const endMs of [159, 0, NaN, Infinity]) {
    assert.equal(splitCaptionScriptBlock([{ ...original, endMs }], 'cue', 2, words, 'right'), null);
  }
});

test('manual line boundaries preserve surrogate pairs, combining marks, and joined emoji', () => {
  for (const cluster of ['\u{20BB7}', 'e\u0301', '\u{1F469}\u{1F3FD}\u200D\u{1F4BB}']) {
    const original = cue({ text: `a${cluster}b`, wordIds: [], sourceAnchor: undefined });
    for (const cursor of [1, 1 + cluster.length]) {
      const result = input([original], `${original.text.slice(0, cursor)}\n${original.text.slice(cursor)}`, []);
      assert.deepEqual(result.captions.map(({ text }) => text), [original.text.slice(0, cursor), original.text.slice(cursor)]);
      assertIntegrity(original, result.captions);
    }
    for (let cursor = 2; cursor < 1 + cluster.length; cursor += 1) {
      const result = input([original], `${original.text.slice(0, cursor)}\n${original.text.slice(cursor)}`, []);
      assert.equal(result.captions.map(({ text }) => text).join(''), original.text);
      assert.ok(result.captions.some(({ text }) => text.includes(cluster)));
    }
  }
});

test('the TextInput handler uses the tested input mutation instead of rejecting within-word Enter', () => {
  const source = readFileSync(new URL('../src/components/editor/script-editor.tsx', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('const updateText ='), source.indexOf('const mergeWithPrevious ='));
  assert.match(source, /onChangeText=\{\(text\) => updateText\(item, text\)\}/);
  assert.match(handler, /updateCaptionScriptInput\(/);
  assert.doesNotMatch(handler, /between two words|text\.replace\(/);
});
