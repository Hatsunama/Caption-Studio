import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TIMELINE_PLAYER_BUFFER_OPTIONS,
  TRANSITION_PLAYER_BUFFER_OPTIONS,
  configureTimelinePlayer,
  configureTransitionPlayer,
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
