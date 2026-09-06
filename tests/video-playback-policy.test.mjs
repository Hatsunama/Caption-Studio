import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLIP_HANDOFF_PRIME_MS,
  TIMELINE_PLAYER_BUFFER_OPTIONS,
  TRANSITION_PLAYER_BUFFER_OPTIONS,
  canSeamlessSwapToClip,
  clipHandoffPrimeAt,
  configureTimelinePlayer,
  configureTransitionPlayer,
  nextClipEntry,
  oppositeTimelineSlot,
} from '../src/lib/video-playback-policy.ts';

test('editor playback has an explicit bounded Android buffer budget', () => {
  assert.equal(TIMELINE_PLAYER_BUFFER_OPTIONS.maxBufferBytes, 24 * 1024 * 1024);
  assert.equal(TRANSITION_PLAYER_BUFFER_OPTIONS.maxBufferBytes, 12 * 1024 * 1024);
  assert.ok(TRANSITION_PLAYER_BUFFER_OPTIONS.preferredForwardBufferDuration <= 2.25);
  assert.ok(
    TIMELINE_PLAYER_BUFFER_OPTIONS.maxBufferBytes
      + TRANSITION_PLAYER_BUFFER_OPTIONS.maxBufferBytes * 2
      <= 48 * 1024 * 1024,
  );
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

test('clip handoff primes only the adjacent next source near the boundary', () => {
  const entries = [
    { clip: { id: 'a' }, gapStartMs: 0, startMs: 0, endMs: 2_000, afterGapEndMs: 2_000 },
    { clip: { id: 'b' }, gapStartMs: 2_000, startMs: 2_000, endMs: 5_000, afterGapEndMs: 5_000 },
  ];
  assert.equal(nextClipEntry(entries, 'a')?.clip.id, 'b');
  assert.equal(oppositeTimelineSlot(0), 1);
  assert.equal(oppositeTimelineSlot(1), 0);
  assert.equal(clipHandoffPrimeAt(entries, 'a', 500, true), undefined);
  const prime = clipHandoffPrimeAt(entries, 'a', 2_000 - CLIP_HANDOFF_PRIME_MS + 10, true);
  assert.equal(prime?.next.clip.id, 'b');
  assert.equal(clipHandoffPrimeAt(entries, 'a', 1_900, false), undefined);
  assert.equal(
    canSeamlessSwapToClip({
      primedClipId: 'b',
      primedSourceId: 'cam',
      targetClipId: 'b',
      targetSourceId: 'cam',
    }),
    true,
  );
  assert.equal(
    canSeamlessSwapToClip({
      primedClipId: 'b',
      primedSourceId: 'cam',
      targetClipId: 'b',
      targetSourceId: 'screen',
    }),
    false,
  );
});
