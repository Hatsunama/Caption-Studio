export type TimelineInterval = { id: string; startMs: number; endMs: number };

export const TIMELINE_MARKER_WIDTH = 44;
export const TIMELINE_MARKER_HEIGHT = 44;
export const MAX_TIMELINE_PAGE_CUES = 4;

/** One index per content revision. Scroll/selection never sorts, filters, or
 * packs the full track. The index owns references, not copies of cue payloads. */
export function indexTimelineCues<T extends TimelineInterval>(cues: readonly T[]) {
  const ordered = [...cues].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id));
  return { ordered, byId: new Map(ordered.map((cue, index) => [cue.id, index])) };
}

export function timelineCuePage<T extends TimelineInterval>(
  index: ReturnType<typeof indexTimelineCues<T>>,
  durationMs: number,
  trackWidth: number,
  bounds: { left: number; right: number },
  selectedId?: string,
) {
  const capacity = Math.min(MAX_TIMELINE_PAGE_CUES, Math.floor((bounds.right - bounds.left) / TIMELINE_MARKER_WIDTH));
  let low = 0, high = index.ordered.length, probes = 0;
  const startMs = bounds.left / trackWidth * durationMs;
  const endMs = bounds.right / trackWidth * durationMs;
  while (low < high) {
    const middle = (low + high) >>> 1;
    probes++;
    if (index.ordered[middle].startMs < startMs) low = middle + 1;
    else high = middle;
  }
  const selectedIndex = selectedId === undefined ? undefined : index.byId.get(selectedId);
  const selected = selectedIndex === undefined ? undefined : index.ordered[selectedIndex];
  const anchor = selected && selected.startMs <= endMs && selected.endMs >= startMs
    ? selectedIndex! : Math.min(low, index.ordered.length - 1);
  const first = capacity > 0 ? Math.max(0, Math.floor(anchor / capacity) * capacity) : 0;
  const cues = index.ordered.slice(first, first + capacity);
  const layout = packTimelineLanes(cues);
  // Cards describe chronological order, not expanded time intervals. Their
  // separate row has disjoint 44px targets even for coincident zero-length cues.
  const markers = new Map(cues.map((cue, offset) => [cue.id, {
    left: bounds.left + offset * TIMELINE_MARKER_WIDTH,
    width: TIMELINE_MARKER_WIDTH, top: layout.laneCount * 32 + 3,
  }]));
  return { cues, first, capacity, layout, markers, probes, height: layout.laneCount * 32 + TIMELINE_MARKER_HEIGHT + 8 };
}

export function packTimelineLanes(intervals: TimelineInterval[]) {
  const laneEnds: number[] = [];
  const laneById = new Map<string, number>();
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id));

  for (const interval of sorted) {
    let lane = laneEnds.findIndex((endMs) => interval.startMs >= endMs);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(interval.endMs);
    } else {
      laneEnds[lane] = interval.endMs;
    }
    laneById.set(interval.id, lane);
  }

  return { laneById, laneCount: Math.max(1, laneEnds.length) };
}
