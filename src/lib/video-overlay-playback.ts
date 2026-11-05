import { videoOverlaySegments } from '@/lib/video-overlay-segments';
import type { VideoClip, VideoVisualLayer } from '@/types/project';

export function overlayPlaybackState(
  layer: Readonly<{ startMs: number; endMs: number; sourceStartMs: number; playbackRate: number }> | VideoVisualLayer,
  timelineMs: number,
  timelinePlaying: boolean,
  clips?: VideoClip[],
) {
  if (clips && 'sourceDurationMs' in layer) {
    const segments = videoOverlaySegments(layer, clips, Number.POSITIVE_INFINITY);
    const active = segments.find((segment) => timelineMs >= segment.startMs && timelineMs < segment.endMs);
    const previous = [...segments].reverse().find((segment) => segment.endMs <= timelineMs);
    const seconds = (active
      ? active.sourceStartMs + (timelineMs - active.startMs) * layer.playbackRate
      : previous?.sourceEndMs ?? segments[0]?.sourceStartMs ?? layer.sourceStartMs) / 1000;
    return { visible: Boolean(active), seconds, playing: Boolean(active) && timelinePlaying };
  }
  const visible = timelineMs >= layer.startMs && timelineMs < layer.endMs;
  const seconds = Math.max(0, layer.sourceStartMs + Math.max(0, timelineMs - layer.startMs) * layer.playbackRate) / 1000;
  return { visible, seconds, playing: visible && timelinePlaying };
}
