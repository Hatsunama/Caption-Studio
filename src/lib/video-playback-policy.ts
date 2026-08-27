import type { VideoPlayer } from 'expo-video';

export const TIMELINE_PLAYER_BUFFER_OPTIONS = Object.freeze({
  maxBufferBytes: 24 * 1024 * 1024,
  minBufferForPlayback: 0.5,
  preferredForwardBufferDuration: 4,
  prioritizeTimeOverSizeThreshold: false,
});

export const TRANSITION_PLAYER_BUFFER_OPTIONS = Object.freeze({
  maxBufferBytes: 12 * 1024 * 1024,
  minBufferForPlayback: 0.2,
  preferredForwardBufferDuration: 2.25,
  prioritizeTimeOverSizeThreshold: false,
});

export function configureTimelinePlayer(player: VideoPlayer) {
  player.bufferOptions = { ...TIMELINE_PLAYER_BUFFER_OPTIONS };
  player.timeUpdateEventInterval = 0.05;
}

export function configureTransitionPlayer(player: VideoPlayer) {
  player.bufferOptions = { ...TRANSITION_PLAYER_BUFFER_OPTIONS };
  player.loop = false;
  player.muted = true;
  player.volume = 0;
  player.timeUpdateEventInterval = 0;
}
