import { clipPlaybackVolume, type ClipTimelineEntry } from '@/lib/video-timeline';
import type { VideoTransitionPreviewWindow } from '@/lib/video-transition-preview';

/** Transport ownership does not determine audibility. Covers retain each clip's
 * original clock; composites use the existing retimed video clock in both legs.
 */
export function transitionClipPlaybackVolume(
  entry: ClipTimelineEntry,
  timelineMs: number,
  window?: VideoTransitionPreviewWindow,
): number {
  const volume = clipPlaybackVolume(entry.clip, timelineMs - entry.startMs);
  if (!window || timelineMs < window.startMs || timelineMs > window.endMs) return volume;
  const outgoing = window.outgoing?.clipId === entry.clip.id;
  const incoming = window.incoming?.clipId === entry.clip.id;
  if (!outgoing && !incoming) return volume;
  const start = window.mode === 'cover' && incoming ? window.boundaryMs : window.startMs;
  const end = window.mode === 'cover' && outgoing ? window.boundaryMs : window.endMs;
  const phase = Math.max(0, Math.min(1, (timelineMs - start) / Math.max(1, end - start)));
  // Exact endpoint zeros also determine mute state, rather than cos(pi/2) noise.
  const gain = outgoing ? phase >= 1 ? 0 : Math.cos(phase * Math.PI / 2)
    : phase <= 0 ? 0 : Math.sin(phase * Math.PI / 2);
  return volume * gain;
}
