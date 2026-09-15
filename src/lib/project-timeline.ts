import { audioClipEnd } from '@/lib/audio-timeline';
import { buildClipTimeline, timelineSegmentAt, totalClipDuration, type ClipTimelineEntry, type TimelineSegment } from '@/lib/video-timeline';
import type { CaptionProject } from '@/types/project';

/** Editable content owns the project extent, independently of the footage track.
 * Muting/hiding content does not shorten its editable timeline. Source content
 * hidden by a layout edit does not keep a deleted video interval alive.
 */
export function projectTimelineDuration(project: CaptionProject): number {
  let duration = totalClipDuration(project.clips ?? []);
  const extend = (endMs: number) => {
    if (Number.isFinite(endMs) && endMs >= 0) duration = Math.max(duration, endMs);
  };
  for (const clip of project.audioClips ?? []) extend(audioClipEnd(clip));
  for (const layer of project.layers ?? []) {
    if (layer.kind !== 'captions' && layer.timelineVisible !== false) extend(layer.endMs);
  }
  const captionById = new Map((project.captions ?? []).map((caption) => [caption.id, caption]));
  for (const caption of project.captions ?? []) {
    if (caption.timelineVisible !== false) extend(caption.endMs);
  }
  for (const track of project.captionTracks?.translations ?? []) {
    for (const cue of track.cues) {
      const source = captionById.get(cue.sourceCaptionId);
      if (source && source.timelineVisible !== false && cue.timelineVisible !== false) {
        extend(cue.endMs ?? source.endMs);
      }
    }
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
