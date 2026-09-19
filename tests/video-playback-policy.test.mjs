import assert from 'node:assert/strict';
import test from 'node:test';

import { canContinueTimelineClip, shouldApplyTimelineSeek } from '../src/lib/video-playback-policy.ts';
import {
  TIMELINE_PLAYER_BUFFER_OPTIONS,
  configureTimelinePlayer,
} from '../src/services/video-player-runtime.ts';

test('editor playback has an explicit bounded Android buffer budget', () => {
  assert.equal(TIMELINE_PLAYER_BUFFER_OPTIONS.maxBufferBytes, 16 * 1024 * 1024);
  assert.ok(
    TIMELINE_PLAYER_BUFFER_OPTIONS.maxBufferBytes * 2
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

test('explicit seeks compare with the player position rather than a stale requested position', () => {
  assert.equal(shouldApplyTimelineSeek(15, 10), true);
  assert.equal(shouldApplyTimelineSeek(10, 10), false);
  assert.equal(shouldApplyTimelineSeek(Number.NaN, 10), true);
});

test('both persistent timeline players receive the same bounded lifecycle settings', () => {
  const firstPlayer = {};
  const secondPlayer = {};
  configureTimelinePlayer(firstPlayer);
  configureTimelinePlayer(secondPlayer);
  assert.deepEqual(firstPlayer.bufferOptions, TIMELINE_PLAYER_BUFFER_OPTIONS);
  assert.deepEqual(secondPlayer.bufferOptions, TIMELINE_PLAYER_BUFFER_OPTIONS);
  assert.equal(firstPlayer.timeUpdateEventInterval, 0.05);
  assert.equal(secondPlayer.timeUpdateEventInterval, 0.05);
});
