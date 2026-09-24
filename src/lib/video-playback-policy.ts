import type { ClipTimelineEntry } from '@/lib/video-timeline';

export const CLIP_HANDOFF_BOUNDARY_TOLERANCE_MS = 48;

export function shouldApplyTimelineSeek(currentSeconds: number, targetSeconds: number) {
  return !Number.isFinite(currentSeconds)
    || !Number.isFinite(targetSeconds)
    || Math.abs(currentSeconds - targetSeconds) > 0.001;
}

export function canContinueTimelineClip(
  current: ClipTimelineEntry,
  next: ClipTimelineEntry | undefined,
) {
  return Boolean(
    next
    && current.clip.sourceId === next.clip.sourceId
    && (current.clip.transitionAfter?.type == null || current.clip.transitionAfter.type === 'none')
    && current.clip.gapAfterMs === 0
    && next.clip.gapBeforeMs === 0
    && Math.abs(current.clip.sourceEndMs - next.clip.sourceStartMs) <= 1
    && current.endMs === next.startMs,
  );
}

export function canContinuePreparedTimelineClip(
  current: ClipTimelineEntry,
  next: ClipTimelineEntry,
  slot: {
    sourceId?: string;
    playbackUri?: string;
    preparedClipId?: string;
    firstFrameReady: boolean;
    readiness: string;
    preparation?: unknown;
  },
  playbackUri: string,
  player: { status: string; currentTime: number },
  targetMs: number,
) {
  return canContinueTimelineClip(current, next)
    && Math.abs(targetMs - next.startMs) <= 1
    && slot.sourceId === next.clip.sourceId
    && slot.playbackUri === playbackUri
    && slot.preparedClipId === current.clip.id
    && slot.firstFrameReady
    && slot.readiness === 'ready'
    && !slot.preparation
    && player.status === 'readyToPlay'
    && Number.isFinite(player.currentTime)
    && Math.abs(player.currentTime * 1_000 - next.clip.sourceStartMs) <= 250;
}
