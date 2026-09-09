import { moveAudioClip, trimAudioClip } from '@/lib/audio-timeline';
import { setTranslationCueTiming } from '@/lib/caption-tracks';
import { setCaptionTiming, setLayerTiming } from '@/lib/project-editor';
import type { TimelineTimingEdge } from '@/lib/timeline-item-timing';
import type { CaptionProject } from '@/types/project';

export type TimelineItemReference =
  | { kind: 'audio'; clipId: string }
  | { kind: 'caption'; captionId: string }
  | { kind: 'translation'; trackId: string; sourceCaptionId: string }
  | { kind: 'visual'; layerId: string };

export type { TimelineTimingEdge } from '@/lib/timeline-item-timing';

export function applyTimelineItemTiming(
  project: CaptionProject,
  item: TimelineItemReference,
  edge: TimelineTimingEdge,
  startMs: number,
  endMs: number,
  timelineDurationMs: number,
) {
  if (item.kind === 'audio') {
    return edge === 'move'
      ? moveAudioClip(project, item.clipId, startMs, timelineDurationMs)
      : trimAudioClip(project, item.clipId, edge, edge === 'start' ? startMs : endMs, timelineDurationMs);
  }
  if (item.kind === 'caption') {
    return setCaptionTiming(project, item.captionId, edge, startMs, endMs);
  }
  if (item.kind === 'translation') {
    return setTranslationCueTiming(
      project,
      item.trackId,
      item.sourceCaptionId,
      edge,
      startMs,
      endMs,
      new Date().toISOString(),
    );
  }
  return setLayerTiming(project, item.layerId, edge, startMs, endMs);
}
