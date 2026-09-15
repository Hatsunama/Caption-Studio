export type TimelineInterval = { id: string; startMs: number; endMs: number };

export const TIMELINE_MARKER_WIDTH = 44;
export const TIMELINE_MARKER_HEIGHT = 44;

/** Tiny cues get owned selection lanes below all actual time-interval bodies.
 * Pack the marker rectangles in pixels so adjacent/overlapping cues cannot
 * intercept one another, even at minimum zoom or either track boundary. */
export function packTimelineMarkers(intervals: TimelineInterval[], durationMs: number, trackWidth: number) {
  const width = Math.min(TIMELINE_MARKER_WIDTH, trackWidth);
  const markers = intervals.filter((cue) => (cue.endMs - cue.startMs) / durationMs * trackWidth < TIMELINE_MARKER_WIDTH)
    .map((cue) => {
      const left = Math.max(0, Math.min(cue.startMs / durationMs * trackWidth - width / 2, trackWidth - width));
      return { id: cue.id, startMs: left, endMs: left + width };
    });
  const layout = packTimelineLanes(markers);
  return {
    laneCount: markers.length ? layout.laneCount : 0,
    byId: new Map(markers.map((marker) => [marker.id, {
      left: marker.startMs, width, lane: layout.laneById.get(marker.id)!,
    }])),
  };
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
