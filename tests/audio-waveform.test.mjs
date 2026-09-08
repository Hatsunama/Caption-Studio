import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDIO_WAVEFORM_VERSION,
  audioWaveformNeedsRefresh,
  audioWaveformPeakCount,
  audioWaveformWindow,
} from '../src/lib/audio-waveform.ts';

test('waveform resolution scales with source duration inside a bounded memory budget', () => {
  assert.equal(audioWaveformPeakCount(1_000), 128);
  assert.equal(audioWaveformPeakCount(332_000), 3_984);
  assert.equal(audioWaveformPeakCount(3_600_000), 4_096);
});

test('legacy and incomplete waveform caches are upgraded without invalidating current projects', () => {
  assert.equal(audioWaveformNeedsRefresh({ durationMs: 10_000, waveformPeaks: new Array(64).fill(0.5) }), true);
  assert.equal(audioWaveformNeedsRefresh({
    durationMs: 10_000,
    waveformPeaks: new Array(128).fill(0.5),
    waveformVersion: AUDIO_WAVEFORM_VERSION,
  }), false);
  assert.equal(audioWaveformNeedsRefresh({
    durationMs: 10_000,
    waveformPeaks: [...new Array(127).fill(0.5), Number.NaN],
    waveformVersion: AUDIO_WAVEFORM_VERSION,
  }), true);
});

test('visible waveform rendering is bounded and preserves transient peaks', () => {
  const peaks = new Array(4_096).fill(0.02);
  peaks[2_048] = 1;
  const window = audioWaveformWindow({
    peaks,
    sourceDurationMs: 4_096_000,
    sourceStartMs: 0,
    sourceEndMs: 4_096_000,
    clipStartMs: 1_000,
    clipEndMs: 4_097_000,
    visibleStartMs: 1_000,
    visibleEndMs: 4_097_000,
    renderedClipWidth: 2_000,
  });
  assert.equal(window.bars.length, 256);
  assert.equal(Math.max(...window.bars), 1);
  assert.equal(window.leftPx, 0);
  assert.equal(window.widthPx, 2_000);
});

test('viewport slicing maps timeline time back to the trimmed source interval', () => {
  const peaks = Array.from({ length: 1_000 }, (_, index) => index / 999);
  const window = audioWaveformWindow({
    peaks,
    sourceDurationMs: 10_000,
    sourceStartMs: 2_000,
    sourceEndMs: 8_000,
    clipStartMs: 1_000,
    clipEndMs: 7_000,
    visibleStartMs: 2_500,
    visibleEndMs: 5_500,
    renderedClipWidth: 600,
  });
  assert.equal(window.leftPx, 150);
  assert.equal(window.widthPx, 300);
  assert.ok(window.bars[0] > 0.34 && window.bars[0] < 0.36);
  assert.ok(window.bars.at(-1) > 0.64 && window.bars.at(-1) < 0.66);
});
