import type { VideoPlayer } from 'expo-video';

export const TIMELINE_PLAYER_BUFFER_OPTIONS = Object.freeze({
  maxBufferBytes: 16 * 1024 * 1024,
  minBufferForPlayback: 0.5,
  preferredForwardBufferDuration: 3,
  prioritizeTimeOverSizeThreshold: false,
});

export function configureTimelinePlayer(player: VideoPlayer) {
  player.bufferOptions = { ...TIMELINE_PLAYER_BUFFER_OPTIONS };
  player.timeUpdateEventInterval = 0.05;
}
