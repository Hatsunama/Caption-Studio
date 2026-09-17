import assert from 'node:assert/strict';
import test from 'node:test';

import { canContinueTimelineClip } from '../src/lib/video-playback-policy.ts';
import {
  TIMELINE_PLAYER_BUFFER_OPTIONS,
  TRANSITION_PLAYER_BUFFER_OPTIONS,
  configureTimelinePlayer,
  configureTransitionPlayer,
} from '../src/services/video-player-runtime.ts';

test('editor playback has an explicit bounded Android buffer budget', () => {
  assert.equal(TIMELINE_PLAYER_BUFFER_OPTIONS.maxBufferBytes, 16 * 1024 * 1024);
  assert.equal(TRANSITION_PLAYER_BUFFER_OPTIONS.maxBufferBytes, 8 * 1024 * 1024);
  assert.ok(TRANSITION_PLAYER_BUFFER_OPTIONS.preferredForwardBufferDuration <= 1.25);
  assert.ok(
    TIMELINE_PLAYER_BUFFER_OPTIONS.maxBufferBytes
      + TRANSITION_PLAYER_BUFFER_OPTIONS.maxBufferBytes * 2
      <= 32 * 1024 * 1024,
  );
});

test('contiguous cuts on one source keep the active decoder and audio clock', () => {
  const current = {
    clip: { id: 'a', sourceId: 'camera', sourceStartMs: 0, sourceEndMs: 2_000 },
    gapStartMs: 0,
    startMs: 0,
    endMs: 2_000,
    afterGapEndMs: 2_000,
  };
  const next = {
    clip: { id: 'b', sourceId: 'camera', sourceStartMs: 2_000, sourceEndMs: 5_000 },
    gapStartMs: 2_000,
    startMs: 2_000,
    endMs: 5_000,
    afterGapEndMs: 5_000,
  };
  assert.equal(canContinueTimelineClip(current, next), true);
  assert.equal(canContinueTimelineClip(current, { ...next, clip: { ...next.clip, sourceStartMs: 2_500 } }), false);
});

test('timeline and transition players receive distinct lifecycle settings', () => {
  const timelinePlayer = {};
  configureTimelinePlayer(timelinePlayer);
  assert.deepEqual(timelinePlayer.bufferOptions, TIMELINE_PLAYER_BUFFER_OPTIONS);
  assert.equal(timelinePlayer.timeUpdateEventInterval, 0.05);

  const transitionPlayer = {};
  configureTransitionPlayer(transitionPlayer);
  assert.deepEqual(transitionPlayer.bufferOptions, TRANSITION_PLAYER_BUFFER_OPTIONS);
  assert.equal(transitionPlayer.timeUpdateEventInterval, 0);
  assert.equal(transitionPlayer.muted, true);
  assert.equal(transitionPlayer.volume, 0);
  assert.equal(transitionPlayer.loop, false);
});
