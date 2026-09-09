export const MINIMUM_TIMELINE_ITEM_MS = 80;

export type TimelineTimingEdge = 'start' | 'end' | 'move';

export type TimelineRange = Readonly<{
  startMs: number;
  endMs: number;
}>;

export function editTimelineRange(
  current: TimelineRange,
  edge: TimelineTimingEdge,
  requestedStartMs: number,
  requestedEndMs: number,
  timelineDurationMs: number,
  minimumDurationMs = MINIMUM_TIMELINE_ITEM_MS,
): TimelineRange {
  if (
    !Number.isFinite(current.startMs)
    || !Number.isFinite(current.endMs)
    || !Number.isFinite(requestedStartMs)
    || !Number.isFinite(requestedEndMs)
    || !Number.isFinite(timelineDurationMs)
  ) return current;
  const timelineEndMs = Math.max(0, timelineDurationMs);
  const minimumMs = Math.max(1, minimumDurationMs);
  if (timelineEndMs < minimumMs) return current;
  const currentStartMs = clamp(current.startMs, 0, timelineEndMs - minimumMs);
  const currentEndMs = clamp(current.endMs, currentStartMs + minimumMs, timelineEndMs);
  if (edge === 'start') {
    return { startMs: clamp(requestedStartMs, 0, currentEndMs - minimumMs), endMs: currentEndMs };
  }
  if (edge === 'end') {
    return { startMs: currentStartMs, endMs: clamp(requestedEndMs, currentStartMs + minimumMs, timelineEndMs) };
  }
  const durationMs = currentEndMs - currentStartMs;
  const startMs = clamp(requestedStartMs, 0, timelineEndMs - durationMs);
  return { startMs, endMs: startMs + durationMs };
}

export function splitTimelineRange(
  current: TimelineRange,
  splitMs: number,
  minimumDurationMs = MINIMUM_TIMELINE_ITEM_MS,
) {
  const minimumMs = Math.max(1, minimumDurationMs);
  if (
    !Number.isFinite(current.startMs)
    || !Number.isFinite(current.endMs)
    || !Number.isFinite(splitMs)
    || splitMs - current.startMs < minimumMs
    || current.endMs - splitMs < minimumMs
  ) return null;
  return {
    left: { startMs: current.startMs, endMs: splitMs },
    right: { startMs: splitMs, endMs: current.endMs },
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
