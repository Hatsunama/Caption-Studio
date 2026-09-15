import { audioClipEnd } from '@/lib/audio-timeline';
import { buildClipTimeline, timelineSegmentAt, totalClipDuration, type ClipTimelineEntry, type TimelineSegment } from '@/lib/video-timeline';
import type { CaptionProject } from '@/types/project';

/** Editable content owns the project extent, independently of the footage track.
 * Muting/hiding content does not shorten its editable timeline. Source content
 * hidden by a layout edit does not keep a deleted video interval alive.
 */
export function projectTimelineDuration(project: CaptionProject): number {
  let duration = totalClipDuration(project.clips ?? []);
  for (const clip of project.audioClips ?? []) duration = Math.max(duration, audioClipEnd(clip));
  for (const layer of project.layers ?? []) {
    if (layer.kind !== 'captions' && layer.timelineVisible !== false) duration = Math.max(duration, layer.endMs);
  }
  return Math.ceil(duration);
}

/** Missing footage inside the project extent is canvas, including its endpoint. */
export function projectTimelineSegmentAt(
  project: CaptionProject,
  timelineMs: number,
  entries: ClipTimelineEntry[] = buildClipTimeline(project.clips),
): TimelineSegment | undefined {
  const videoEndMs = entries.at(-1)?.afterGapEndMs ?? 0;
  const durationMs = projectTimelineDuration(project);
  if (durationMs > videoEndMs && timelineMs >= videoEndMs && timelineMs <= durationMs) {
    return { kind: 'gap', startMs: videoEndMs, endMs: durationMs };
  }
  return timelineSegmentAt(entries, timelineMs);
}
