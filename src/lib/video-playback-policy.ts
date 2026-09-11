import type { ClipTimelineEntry } from '@/lib/video-timeline';

export const CLIP_HANDOFF_PRIME_MS = 1_250;
export const CLIP_HANDOFF_BOUNDARY_TOLERANCE_MS = 48;

export type TimelinePlayerSlot = 0 | 1;

export type ClipHandoffPrime = {
  next: ClipTimelineEntry;
  remainingMs: number;
};

export function oppositeTimelineSlot(slot: TimelinePlayerSlot): TimelinePlayerSlot {
  return slot === 0 ? 1 : 0;
}

export function nextClipEntry(entries: readonly ClipTimelineEntry[], clipId: string) {
  const index = entries.findIndex((entry) => entry.clip.id === clipId);
  if (index < 0) return undefined;
  return entries[index + 1];
}

export function clipHandoffPrimeAt(
  entries: readonly ClipTimelineEntry[],
  activeClipId: string | undefined,
  timelineMs: number,
  playIntent: boolean,
  primeWindowMs = CLIP_HANDOFF_PRIME_MS,
): ClipHandoffPrime | undefined {
  if (!playIntent || !activeClipId) return undefined;
  const entry = entries.find((candidate) => candidate.clip.id === activeClipId);
  if (!entry) return undefined;
  const remainingMs = entry.endMs - timelineMs;
  if (remainingMs > primeWindowMs || remainingMs < -CLIP_HANDOFF_BOUNDARY_TOLERANCE_MS) return undefined;
  const next = nextClipEntry(entries, entry.clip.id);
  if (!next || next.startMs > entry.endMs + CLIP_HANDOFF_BOUNDARY_TOLERANCE_MS) return undefined;
  if (canContinueTimelineClip(entry, next)) return undefined;
  return { next, remainingMs: Math.max(0, remainingMs) };
}

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

export function canSeamlessSwapToClip(options: {
  primedClipId?: string;
  primedSourceId?: string;
  targetClipId: string;
  targetSourceId: string;
}) {
  return options.primedClipId === options.targetClipId
    && options.primedSourceId === options.targetSourceId;
}
