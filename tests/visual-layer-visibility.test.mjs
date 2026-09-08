import assert from 'node:assert/strict';
import test from 'node:test';

import { visualLayerVisibleAtTime } from '../src/lib/visual-layer-visibility.ts';

const layer = Object.freeze({ visible: true, startMs: 1_000, endMs: 4_000 });

test('visual layers render only inside their half-open timeline interval', () => {
  assert.equal(visualLayerVisibleAtTime(layer, 999), false);
  assert.equal(visualLayerVisibleAtTime(layer, 1_000), true);
  assert.equal(visualLayerVisibleAtTime(layer, 3_999), true);
  assert.equal(visualLayerVisibleAtTime(layer, 4_000), false);
});

test('selection and playback state cannot override visual-layer timing', () => {
  assert.equal(visualLayerVisibleAtTime(layer, 8_000), false);
  assert.equal(visualLayerVisibleAtTime({ ...layer, visible: false }, 2_000), false);
  assert.equal(visualLayerVisibleAtTime(layer, Number.NaN), false);
});
