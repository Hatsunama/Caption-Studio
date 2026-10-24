/** Half-open active cues win; equal boundary distances keep input order. */
export function captionAtTimelinePosition<T extends { id: string; startMs: number; endMs: number; timelineVisible?: boolean }>(
  captions: readonly T[], currentMs: number,
): T | undefined {
  if (!Number.isFinite(currentMs)) return undefined;
  let nearest: T | undefined;
  let distance = Infinity;
  for (const caption of captions) {
    if (caption.timelineVisible === false || !Number.isFinite(caption.startMs)
      || !Number.isFinite(caption.endMs) || caption.startMs < 0 || caption.endMs <= caption.startMs) continue;
    if (caption.startMs <= currentMs && currentMs < caption.endMs) return caption;
    const nextDistance = Math.min(Math.abs(currentMs - caption.startMs), Math.abs(currentMs - caption.endMs));
    if (nextDistance < distance) { nearest = caption; distance = nextDistance; }
  }
  return nearest;
}
