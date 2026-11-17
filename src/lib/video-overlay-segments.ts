import { projectVideoSourceSegments } from '@/lib/video-timeline';
import type { VideoClip, VideoVisualLayer } from '@/types/project';

export type VideoOverlaySegment = {
  startMs: number;
  endMs: number;
  sourceStartMs: number;
  sourceEndMs: number;
};

/** Map each owned source interval separately so owner gaps cannot consume overlay media. */
export function videoOverlaySegments(layer: VideoVisualLayer, clips: VideoClip[], durationMs: number): VideoOverlaySegment[] {
  if (layer.timelineVisible === false) return [];
  if (layer.timingMode === 'timeline' || !layer.sourceAnchors?.length) {
    const startMs = Math.max(0, layer.startMs);
    const sourceStartMs = layer.sourceStartMs + (startMs - layer.startMs) * layer.playbackRate;
    const endMs = Math.min(durationMs, layer.endMs,
      startMs + Math.max(0, layer.sourceDurationMs - sourceStartMs) / layer.playbackRate);
    return endMs > startMs ? [{ startMs, endMs, sourceStartMs,
      sourceEndMs: sourceStartMs + (endMs - startMs) * layer.playbackRate }] : [];
  }
  return projectVideoSourceSegments(layer, clips, durationMs);
}
