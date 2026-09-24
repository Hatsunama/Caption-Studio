export type TimelineInterval = { id: string; startMs: number; endMs: number };

export const MAX_TIMELINE_BODY_CUES = 256;
export const MAX_TIMELINE_DENSITY_BINS = 16;
export const MIN_TIMELINE_DENSITY_BIN_PX = 44;
const MIN_DRAWABLE_CUE_PX = 2;
const MAX_BODY_LANES = 12;

/** One index per content revision. Scroll/selection never sorts, filters, or
 * packs the full track. The index owns references, not copies of cue payloads. */
export function indexTimelineCues<T extends TimelineInterval>(cues: readonly T[]) {
  const ordered = [...cues].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const ends = ordered.map((cue) => cue.endMs).sort((a, b) => a - b);
  let size = 1;
  while (size < ordered.length) size *= 2;
  const maxEnd = new Float64Array(size * 2).fill(-Infinity);
  ordered.forEach((cue, i) => { maxEnd[size + i] = cue.endMs; });
  for (let i = size - 1; i > 0; i--) maxEnd[i] = Math.max(maxEnd[i * 2], maxEnd[i * 2 + 1]);
  return { ordered, ends, size, maxEnd, byId: new Map(ordered.map((cue, index) => [cue.id, index])) };
}

/** Inclusive intersections also retain zero-length cues. Max-end pruning finds
 * intervals that began before the viewport. A limited query visits at most
 * O((limit + 1) log n) nodes and never allocates the entire dense result. */
export function queryTimelineCues<T extends TimelineInterval>(
  index: ReturnType<typeof indexTimelineCues<T>>, startMs: number, endMs: number,
  limit = Infinity,
) {
  const cues: T[] = [];
  let probes = 0;
  function visit(node: number, left: number, right: number) {
    if (cues.length >= limit || left >= index.ordered.length) return;
    probes++;
    if (index.maxEnd[node] < startMs || index.ordered[left].startMs > endMs) return;
    if (right - left === 1) { cues.push(index.ordered[left]); return; }
    const middle = (left + right) >>> 1;
    visit(node * 2, left, middle);
    visit(node * 2 + 1, middle, right);
  }
  if (startMs <= endMs && limit > 0) visit(1, 0, index.size);
  return { cues, probes };
}

/** Counting uses two sorted endpoint ranks, even for 5000 coincident cues. */
export function countTimelineCues<T extends TimelineInterval>(
  index: ReturnType<typeof indexTimelineCues<T>>, startMs: number, endMs: number,
) {
  if (startMs > endMs) return 0;
  let low = 0, high = index.ordered.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (index.ordered[middle].startMs <= endMs) low = middle + 1;
    else high = middle;
  }
  const starts = low;
  low = 0; high = index.ends.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (index.ends[middle] < startMs) low = middle + 1;
    else high = middle;
  }
  return starts - low;
}

export function timelineCueChoices<T extends TimelineInterval>(
  index: ReturnType<typeof indexTimelineCues<T>>, startMs: number, endMs: number, offset: number,
) {
  const pageSize = 32;
  const start = Math.max(0, Math.floor(offset));
  const matches = queryTimelineCues(index, startMs, endMs, start + pageSize + 1).cues;
  return { cues: matches.slice(start, start + pageSize), hasMore: matches.length > start + pageSize };
}

export function timelineCuePage<T extends TimelineInterval>(
  index: ReturnType<typeof indexTimelineCues<T>>,
  durationMs: number,
  trackWidth: number,
  bounds: { left: number; right: number },
  selectedId?: string,
  pinSelected = false,
) {
  const startMs = bounds.left / trackWidth * durationMs;
  const endMs = bounds.right / trackWidth * durationMs;
  const query = queryTimelineCues(index, startMs, endMs, MAX_TIMELINE_BODY_CUES + 1);
  const selectedIndex = selectedId === undefined ? undefined : index.byId.get(selectedId);
  const selected = selectedIndex === undefined ? undefined : index.ordered[selectedIndex];
  const selectedIntersects = Boolean(selected && selected.startMs <= endMs && selected.endMs >= startMs);
  const crowded = query.cues.length > MAX_TIMELINE_BODY_CUES;
  const narrow = query.cues.length > MAX_TIMELINE_DENSITY_BINS && query.cues.some(
    (cue) => (cue.endMs - cue.startMs) / durationMs * trackWidth < MIN_DRAWABLE_CUE_PX,
  );
  const visibleLayout = crowded || narrow ? undefined : packTimelineLanes(query.cues);
  const overviewMode = crowded || narrow || (visibleLayout?.laneCount ?? 0) > MAX_BODY_LANES;
  const visibleBodies = overviewMode ? (selected && selectedIntersects ? [selected] : []) : query.cues;
  const bodies = pinSelected && selected && !visibleBodies.some((cue) => cue.id === selected.id)
    ? [...visibleBodies, selected]
    : visibleBodies;
  const layout = overviewMode
    ? { laneById: new Map(bodies.map((cue) => [cue.id, 0])), laneCount: 1 }
    : packTimelineLanes(bodies);
  const overview: { left: number; width: number; startMs: number; endMs: number }[] = [];
  if (overviewMode) {
    const bins = Math.max(1, Math.min(MAX_TIMELINE_DENSITY_BINS, Math.floor((bounds.right - bounds.left) / MIN_TIMELINE_DENSITY_BIN_PX)));
    for (let i = 0; i < bins; i++) {
      const left = bounds.left + (bounds.right - bounds.left) * i / bins;
      const right = bounds.left + (bounds.right - bounds.left) * (i + 1) / bins;
      const from = left / trackWidth * durationMs, to = right / trackWidth * durationMs;
      if (countTimelineCues(index, from, to)) overview.push({ left, width: right - left, startMs: from, endMs: to });
    }
  }
  return { bodies, overview, layout };
}

export function packTimelineLanes(intervals: TimelineInterval[]) {
  const laneEnds: number[] = [];
  const laneById = new Map<string, number>();
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

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
