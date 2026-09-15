export const MINIMUM_TIMELINE_ITEM_MS = 80;

export type TimelineTimingEdge = 'start' | 'end' | 'move';

export type TimelineRange = Readonly<{
  startMs: number;
  endMs: number;
}>;

/** Explicit caption/text edits own their extent; footage is not an upper bound. */
export function editCanvasTimelineRange(
  current: TimelineRange,
  edge: TimelineTimingEdge,
  requestedStartMs: number,
  requestedEndMs: number,
): TimelineRange {
  const minimumMs = MINIMUM_TIMELINE_ITEM_MS;
  const finiteStart = Number.isFinite(current.startMs) ? current.startMs : 0;
  const finiteEnd = Number.isFinite(current.endMs) ? current.endMs : finiteStart + minimumMs;
  const currentStart = Math.max(0, finiteStart);
  const currentEnd = Math.max(currentStart + minimumMs, finiteEnd);
  const requestedStart = Number.isFinite(requestedStartMs) ? requestedStartMs : currentStart;
  const requestedEnd = Number.isFinite(requestedEndMs) ? requestedEndMs : currentEnd;
  const startMs = edge === 'start'
    ? clamp(requestedStart, 0, currentEnd - minimumMs)
    : edge === 'move' ? Math.max(0, requestedStart) : currentStart;
  const endMs = edge === 'start' ? currentEnd
    : edge === 'move' ? startMs + Math.max(minimumMs, finiteEnd - finiteStart)
      : Math.max(requestedEnd, currentStart + minimumMs);
  // Reject overflow/precision loss rather than persisting an unusable interval.
  if (!Number.isFinite(endMs) || endMs > Number.MAX_SAFE_INTEGER || endMs - startMs < minimumMs) {
    throw new Error('Timeline timing exceeds the supported range.');
  }
  return { startMs, endMs };
}

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
