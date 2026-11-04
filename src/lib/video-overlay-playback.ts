export function overlayPlaybackState(
  layer: Readonly<{ startMs: number; endMs: number; sourceStartMs: number; playbackRate: number }>,
  timelineMs: number,
  timelinePlaying: boolean,
) {
  const visible = timelineMs >= layer.startMs && timelineMs < layer.endMs;
  const seconds = Math.max(0, layer.sourceStartMs + Math.max(0, timelineMs - layer.startMs) * layer.playbackRate) / 1000;
  return { visible, seconds, playing: visible && timelinePlaying };
}
