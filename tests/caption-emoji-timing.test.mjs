import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ANIMATION_PRESETS } from '../src/lib/animation-presets.ts';
import { captionCueEmojis, captionCueProgress } from '../src/lib/caption-emoji-animation.ts';
import { reactionEmojis } from '../src/lib/emoji-reactions.ts';
import { mergeCaptionScriptBlock, splitCaptionScriptBlock, splitCaptionScriptBlockAtTime, updateCaptionScriptText } from '../src/lib/caption-script.ts';
import { createTextLayer, setCaptionTexts, setCaptionTiming, setLayerTiming, setTextLayerText } from '../src/lib/project-editor.ts';

const cue = () => ({
  id: 'cue', text: 'camera money', startMs: 1_000, endMs: 5_000,
  wordIds: ['old-camera', 'old-money'],
  styleOverride: { animation: { id: 'emoji-burst', durationMs: 680 } },
});
const project = () => ({
  captions: [cue()], layers: [], updatedAt: 'before',
  clips: [{ id: 'clip', sourceId: 'source', sourceStartMs: 0, sourceEndMs: 10_000,
    playbackRate: 1, gapBeforeMs: 0, gapAfterMs: 0 }],
});

function assertFullCueCycle(caption) {
  const duration = caption.endMs - caption.startMs;
  assert.ok(duration > 0);
  assert.equal(captionCueProgress(caption.startMs, caption), 0);
  for (const fraction of [0.25, 0.5, 0.75, 0.999]) {
    assert.ok(Math.abs(captionCueProgress(caption.startMs + duration * fraction, caption) - fraction) < 1e-9);
  }
  assert.equal(captionCueProgress(caption.endMs, caption), undefined);
}

test('emoji cue progress matches the Android contract at boundaries and short/long durations', () => {
  const rows = readFileSync(new URL('../modules/caption-media/android/src/test/resources/caption-emoji-timing-contract.csv', import.meta.url), 'utf8').trim().split(/\r?\n/).slice(1);
  for (const row of rows) {
    const [current, start, end, expected] = row.split(',');
    const actual = captionCueProgress(Number(current), { startMs: Number(start), endMs: Number(end) });
    assert.equal(actual, expected === 'hidden' ? undefined : Number(expected), row);
  }
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assert.equal(captionCueProgress(invalid, cue()), undefined);
    assert.equal(captionCueProgress(2_000, { ...cue(), startMs: invalid }), undefined);
    assert.equal(captionCueProgress(2_000, { ...cue(), endMs: invalid }), undefined);
  }
});

test('all three emoji effects use cue timing and only two stable semantic particles', () => {
  const presets = ANIMATION_PRESETS.filter(({ group }) => group === 'emoji');
  assert.deepEqual(presets.map(({ id }) => id), ['emoji-burst', 'emoji-orbit', 'emoji-rain']);
  for (const preset of presets) {
    assert.equal(preset.timing, 'cue');
    assertFullCueCycle({ ...cue(), styleOverride: { animation: preset } });
  }
  assert.deepEqual(captionCueEmojis('the camera and money'), reactionEmojis('camera').slice(0, 2));
  assert.deepEqual(captionCueEmojis('camera camera camera'), reactionEmojis('camera').slice(0, 2));
  assert.deepEqual(captionCueEmojis('\u6253\u5f00\u76f8\u673a\u7684'), reactionEmojis('camera').slice(0, 2));
  assert.deepEqual(captionCueEmojis('unknown filler'), []);
  assert.deepEqual(captionCueEmojis(''), []);
});

test('caption text edits refresh reactions without depending on old word timing or preset duration', () => {
  const edited = setCaptionTexts(project(), { cue: 'money' }).captions[0];
  assertFullCueCycle(edited);
  assert.deepEqual(captionCueEmojis(edited.text), reactionEmojis('money').slice(0, 2));
  const scriptEdited = updateCaptionScriptText([edited], 'cue', 'sad')[0];
  assertFullCueCycle(scriptEdited);
  assert.deepEqual(captionCueEmojis(scriptEdited.text), reactionEmojis('sad').slice(0, 2));
});

test('start/end trims and moves immediately use the edited cue interval', () => {
  let edited = setCaptionTiming(project(), 'cue', 'end', 1_000, 9_000);
  assert.equal(captionCueProgress(3_000, edited.captions[0]), 0.25);
  edited = setCaptionTiming(edited, 'cue', 'start', 3_000, 9_000);
  assert.equal(captionCueProgress(6_000, edited.captions[0]), 0.5);
  edited = setCaptionTiming(edited, 'cue', 'move', 0, 6_000);
  assert.equal(captionCueProgress(3_000, edited.captions[0]), 0.5);
  assertFullCueCycle(edited.captions[0]);
});

test('cursor/time splits and joins each derive a new full cue cycle', () => {
  const words = [{ id: 'old-camera', text: 'camera', startMs: 1_000, endMs: 2_000 },
    { id: 'old-money', text: 'money', startMs: 2_500, endMs: 5_000 }];
  const results = [
    splitCaptionScriptBlock([cue()], 'cue', 7, words, 'right'),
    splitCaptionScriptBlockAtTime([cue()], 'cue', 3_000, [], 'right'),
  ];
  for (const result of results) {
    assert.ok(result);
    assert.equal(result.captions.length, 2);
    result.captions.forEach(assertFullCueCycle);
    assert.deepEqual(captionCueEmojis(result.captions[1].text), reactionEmojis('money').slice(0, 2));
    const joined = mergeCaptionScriptBlock(result.captions, 'right');
    assert.ok(joined);
    assert.equal(joined.captions.length, 1);
    assertFullCueCycle(joined.captions[0]);
    assert.equal(captionCueProgress(3_000, joined.captions[0]), 0.5);
  }
});

test('new text without word IDs and subsequent text/timing edits have a complete cue cycle', () => {
  const inserted = createTextLayer(project(), 'text', 2_000, 10_000);
  let edited = setTextLayerText(inserted.project, 'text', 'camera');
  assertFullCueCycle(edited.layers[0]);
  assert.deepEqual(captionCueEmojis(edited.layers[0].text), reactionEmojis('camera').slice(0, 2));
  edited = setLayerTiming(edited, 'text', 'end', 2_000, 8_000);
  assert.equal(captionCueProgress(5_000, edited.layers[0]), 0.5);
  assertFullCueCycle(edited.layers[0]);
  assertFullCueCycle({ ...cue(), id: 'new-caption', wordIds: [], text: 'money' });
});
