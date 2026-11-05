import { buildClipTimeline, timelineTimeAt } from '@/lib/video-timeline';
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
  const entries = new Map(buildClipTimeline(clips).map((entry) => [entry.clip.id, entry]));
  let elapsedMs = 0;
  const originMs = layer.sourceStartAtAnchorMs ?? layer.sourceStartMs;
  const mediaEndMs = layer.mediaEndMs ?? layer.sourceDurationMs;
  return layer.sourceAnchors.flatMap((anchor) => {
    const entry = entries.get(anchor.clipId);
    const rate = entry?.clip.playbackRate ?? 1;
    const anchorElapsedMs = (anchor.sourceEndMs - anchor.sourceStartMs) / rate;
    const startSourceMs = entry ? Math.max(anchor.sourceStartMs, entry.clip.sourceStartMs) : 0;
    const endSourceMs = entry ? Math.min(anchor.sourceEndMs, entry.clip.sourceEndMs) : 0;
    const sourceStartMs = originMs + (elapsedMs + (startSourceMs - anchor.sourceStartMs) / rate) * layer.playbackRate;
    elapsedMs += anchorElapsedMs;
    if (!entry || endSourceMs <= startSourceMs || sourceStartMs >= mediaEndMs) return [];
    const startMs = timelineTimeAt(entry, startSourceMs);
    const endMs = Math.min(durationMs, timelineTimeAt(entry, endSourceMs),
      startMs + (mediaEndMs - sourceStartMs) / layer.playbackRate);
    return endMs > startMs ? [{ startMs, endMs, sourceStartMs,
      sourceEndMs: sourceStartMs + (endMs - startMs) * layer.playbackRate }] : [];
  });
}
