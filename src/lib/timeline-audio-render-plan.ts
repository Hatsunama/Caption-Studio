import { buildClipTimeline, totalClipDuration } from '@/lib/video-timeline';
import type { CaptionProject } from '@/types/project';

export const TIMELINE_AUDIO_RENDER_PLAN_VERSION = 1 as const;

export type TimelineAudioRenderSegment = {
  id: string;
  sourceUri: string;
  timelineStartMs: number;
  timelineEndMs: number;
  sourceStartMs: number;
  sourceEndMs: number;
  playbackRate: number;
  volume: number;
  muted: boolean;
};

export type TimelineAudioRenderPlan = {
  version: typeof TIMELINE_AUDIO_RENDER_PLAN_VERSION;
  durationMs: number;
  videoClips: TimelineAudioRenderSegment[];
  audioClips: TimelineAudioRenderSegment[];
};

export function buildTimelineAudioRenderPlan(project: CaptionProject): TimelineAudioRenderPlan {
  const durationMs = totalClipDuration(project.clips);
  const videoSourceById = new Map(project.sources.map((source) => [source.id, source]));
  const audioSourceById = new Map(project.audioSources.map((source) => [source.id, source]));
  const videoClips = buildClipTimeline(project.clips).flatMap((entry) => {
    const source = videoSourceById.get(entry.clip.sourceId);
    if (!source || entry.endMs <= entry.startMs) return [];
    return [{
      id: entry.clip.id,
      sourceUri: source.uri,
      timelineStartMs: entry.startMs,
      timelineEndMs: entry.endMs,
      sourceStartMs: entry.clip.sourceStartMs,
      sourceEndMs: entry.clip.sourceEndMs,
      playbackRate: entry.clip.playbackRate,
      volume: entry.clip.volume,
      muted: entry.clip.muted,
    }];
  });
  const audioClips = project.audioClips.flatMap((clip) => {
    const source = audioSourceById.get(clip.sourceId);
    const sourceDurationMs = Math.max(0, clip.sourceEndMs - clip.sourceStartMs);
    const timelineEndMs = Math.min(durationMs, clip.startMs + sourceDurationMs);
    if (!source || clip.startMs >= durationMs || timelineEndMs <= clip.startMs) return [];
    return [{
      id: clip.id,
      sourceUri: source.uri,
      timelineStartMs: Math.max(0, clip.startMs),
      timelineEndMs,
      sourceStartMs: clip.sourceStartMs,
      sourceEndMs: clip.sourceStartMs + (timelineEndMs - clip.startMs),
      playbackRate: 1,
      volume: clip.volume,
      muted: clip.muted,
    }];
  });
  return {
    version: TIMELINE_AUDIO_RENDER_PLAN_VERSION,
    durationMs,
    videoClips,
    audioClips,
  };
}
