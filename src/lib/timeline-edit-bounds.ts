import { editCanvasTimelineRange, editTimelineRange, MINIMUM_TIMELINE_ITEM_MS, type TimelineRange, type TimelineTimingEdge } from '@/lib/timeline-item-timing';
import { totalClipDuration } from '@/lib/video-timeline';
import type { CaptionProject } from '@/types/project';

export function videoFootageEndMs(project: CaptionProject): number | undefined {
  return project.clips.length ? totalClipDuration(project.clips) : undefined;
}

export function timelineArtifactEditLimit(project: CaptionProject, canvasDurationMs: number): number {
  return videoFootageEndMs(project) ?? (Number.isFinite(canvasDurationMs) ? Math.max(0, canvasDurationMs) : 0);
}

export function editProjectTimelineRange(
  project: CaptionProject,
  current: TimelineRange,
  edge: TimelineTimingEdge,
  requestedStartMs: number,
  requestedEndMs: number,
): TimelineRange {
  const footageEndMs = videoFootageEndMs(project);
  if (footageEndMs === undefined) {
    return editCanvasTimelineRange(current, edge, requestedStartMs, requestedEndMs);
  }
  if (footageEndMs < MINIMUM_TIMELINE_ITEM_MS) return current;
  return editTimelineRange(current, edge, requestedStartMs, requestedEndMs, footageEndMs);
}
