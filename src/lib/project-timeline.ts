import { audioClipEnd } from '@/lib/audio-timeline';
import { buildClipTimeline, timelineSegmentAt, totalClipDuration, type ClipTimelineEntry, type TimelineSegment } from '@/lib/video-timeline';
import type { CaptionProject } from '@/types/project';

/** Editor reachability includes saved timed content, even when it is not exported. */
export function projectTimelineDuration(project: CaptionProject): number {
  if (project.clips?.length) return Math.ceil(totalClipDuration(project.clips));
  let duration = 0;
  const extend = (startMs: number, endMs: number) => {
    if (Number.isFinite(startMs) && Number.isFinite(endMs)
      && endMs > Math.max(0, startMs)) duration = Math.max(duration, endMs);
  };
  for (const clip of project.audioClips ?? []) extend(clip.startMs, audioClipEnd(clip));
  for (const layer of project.layers ?? []) {
    if (layer.kind !== 'captions') extend(layer.startMs, layer.endMs);
  }
  const captionById = new Map((project.captions ?? []).map((caption) => [caption.id, caption]));
  for (const caption of project.captions ?? []) extend(caption.startMs, caption.endMs);
  for (const track of project.captionTracks?.translations ?? []) {
    for (const cue of track.cues) {
      const source = captionById.get(cue.sourceCaptionId);
      if (source) extend(cue.startMs ?? source.startMs, cue.endMs ?? source.endMs);
    }
  }
  return Math.ceil(duration);
}

/** MP4 interval: footage wins; a canvas ends at its last effective visual or sound. */
export function projectRenderDuration(project: CaptionProject): number {
  if (project.clips?.length) return Math.ceil(totalClipDuration(project.clips));
  let duration = 0;
  const extend = (startMs: number, endMs: number) => {
    if (Number.isFinite(startMs) && Number.isFinite(endMs)
      && endMs > Math.max(0, startMs)) duration = Math.max(duration, endMs);
  };
  for (const clip of project.audioClips ?? []) {
    if (!clip.muted && clip.volume > 0) extend(clip.startMs, audioClipEnd(clip));
  }
  for (const layer of project.layers ?? []) {
    if (layer.kind === 'captions' || !layer.visible || layer.timelineVisible === false) continue;
    if (layer.kind === 'text' ? layer.text.trim() && (layer.style.opacity ?? 1) > 0
      : layer.uri?.trim() && layer.opacity > 0) extend(layer.startMs, layer.endMs);
  }
  const captionsEnabled = project.export?.burnCaptions !== false
    && project.layers?.some((layer) => layer.kind === 'captions' && layer.visible);
  if (!captionsEnabled) return Math.ceil(duration);
  const captionById = new Map((project.captions ?? []).map((caption) => [caption.id, caption]));
  for (const caption of project.captions ?? []) {
    if (caption.timelineVisible !== false && caption.text?.trim()
      && (caption.styleOverride?.opacity ?? project.projectStyle.opacity ?? 1) > 0) {
      extend(caption.startMs, caption.endMs);
    }
  }
  for (const track of project.captionTracks?.translations ?? []) {
    if (!track.visible) continue;
    for (const cue of track.cues) {
      const source = captionById.get(cue.sourceCaptionId);
      if (source && !cue.translationSkipped && (cue.timelineVisible ?? source.timelineVisible !== false)
        && (cue.text?.trim() || (cue.status === 'failed' && source.text?.trim()))
        && (cue.styleOverride?.opacity ?? track.styleOverride?.opacity
          ?? source.styleOverride?.opacity ?? project.projectStyle.opacity ?? 1) > 0) {
        extend(cue.startMs ?? source.startMs, cue.endMs ?? source.endMs);
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
