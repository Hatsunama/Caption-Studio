import assert from 'node:assert/strict';
import test from 'node:test';
import { overlayPlaybackState } from '../src/lib/video-overlay-playback.ts';

test('overlay clock follows timeline trim and speed, and pauses outside its range', () => {
  const layer = { startMs: 4000, endMs: 7000, sourceStartMs: 1000, playbackRate: 2 };
  assert.deepEqual(overlayPlaybackState(layer, 4500, true), { visible: true, seconds: 2, playing: true });
  assert.deepEqual(overlayPlaybackState(layer, 7000, true), { visible: false, seconds: 7, playing: false });
  assert.deepEqual(overlayPlaybackState(layer, 5000, false), { visible: true, seconds: 3, playing: false });
});
