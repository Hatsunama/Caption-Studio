import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  captionAnimationClock,
  captionAnimationState,
  isActiveWordHighlightAnimation,
  isWordTimedAnimation,
  realWordAnimationProgress,
} from '../src/lib/animation-timing.ts';
import { ANIMATION_PRESETS } from '../src/lib/animation-presets.ts';

const fixture = readFileSync(
  new URL('../modules/caption-media/android/src/test/resources/caption-animation-contract.csv', import.meta.url),
  'utf8',
).trim().split(/\r?\n/).slice(1).map((line) => {
  const [id, ...values] = line.split(',');
  return { id, values: values.map(Number) };
});

test('caption animation clock starts at the caption and keeps a continuous caption phase', () => {
  const atStart = captionAnimationClock({ currentMs: 1_000, captionStartMs: 1_000, captionEndMs: 3_000, animationDurationMs: 400 });
  const afterTwoCycles = captionAnimationClock({ currentMs: 1_900, captionStartMs: 1_000, captionEndMs: 3_000, animationDurationMs: 400 });
  assert.deepEqual(atStart, { entryProgress: 0, phase: 0 });
  assert.deepEqual(afterTwoCycles, { entryProgress: 1, phase: 2.25 });
});

test('preview phrase states match the native shared contract fixture', () => {
  const clock = captionAnimationClock({ currentMs: 1_050, captionStartMs: 1_000, captionEndMs: 3_000, animationDurationMs: 400 });
  assert.deepEqual(clock, { entryProgress: 0.125, phase: 0.125 });
  for (const row of fixture) {
    const state = captionAnimationState(row.id, clock, 0.5);
    const actual = [state.translateX, state.translateY, state.scaleX, state.scaleY, state.rotation, state.opacity, state.glow];
    actual.forEach((value, index) => assert.ok(Math.abs(value - row.values[index]) < 0.00001, `${row.id} field ${index}: ${value}`));
  }
});

test('all 33 effects have one timing domain and all phrase effects have contract fixtures', () => {
  const fixtureIds = new Set(fixture.map((row) => row.id));
  assert.equal(ANIMATION_PRESETS.length, 33);
  for (const preset of ANIMATION_PRESETS) {
    if (preset.id === 'none') continue;
    assert.equal(isWordTimedAnimation(preset.id) || fixtureIds.has(preset.id), true, preset.id);
    assert.equal(isWordTimedAnimation(preset.id) && fixtureIds.has(preset.id), false, preset.id);
  }
  assert.equal(fixtureIds.size, 17);
});

test('word timing never falls back to a caption clock or an invalid word window', () => {
  assert.equal(realWordAnimationProgress(1_150, { startMs: 1_100, endMs: 1_300 }), 0.25);
  assert.equal(realWordAnimationProgress(1_050, { startMs: 1_100, endMs: 1_300 }), undefined);
  assert.equal(realWordAnimationProgress(1_300, { startMs: 1_100, endMs: 1_300 }), undefined);
  assert.equal(realWordAnimationProgress(1_150), undefined);
  assert.equal(realWordAnimationProgress(1_150, { startMs: 1_100, endMs: 1_100 }), undefined);
});

test('only spoken-word effects can apply the active-word color contract', () => {
  assert.equal(isActiveWordHighlightAnimation('active-word'), true);
  assert.equal(isActiveWordHighlightAnimation('emoji-burst'), true);
  assert.equal(isActiveWordHighlightAnimation('single-word'), false);
  assert.equal(isActiveWordHighlightAnimation('heartbeat'), false);
});
