import type { ClipTimelineEntry } from '@/lib/video-timeline';

export const CLIP_HANDOFF_BOUNDARY_TOLERANCE_MS = 48;

export function canContinueTimelineClip(
  current: ClipTimelineEntry,
  next: ClipTimelineEntry | undefined,
) {
  return Boolean(
    next
    && current.clip.sourceId === next.clip.sourceId
    && Math.abs(current.clip.sourceEndMs - next.clip.sourceStartMs) <= 1
    && Math.abs(current.endMs - next.startMs) <= CLIP_HANDOFF_BOUNDARY_TOLERANCE_MS,
  );
}
