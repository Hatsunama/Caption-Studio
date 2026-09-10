import type { AudioClip, CaptionProject, ProjectAudioSource } from '@/types/project';
import { editTimelineRange, MINIMUM_TIMELINE_ITEM_MS, splitTimelineRange } from '@/lib/timeline-item-timing';

export const MINIMUM_AUDIO_CLIP_MS = MINIMUM_TIMELINE_ITEM_MS;

export function audioClipDuration(clip: AudioClip) {
  return Math.max(0, clip.sourceEndMs - clip.sourceStartMs);
}

export function audioClipEnd(clip: AudioClip) {
  return clip.startMs + audioClipDuration(clip);
}

export function audioClipVolume(clip: AudioClip, timelineMs: number) {
  if (clip.muted) return 0;
  const offset = timelineMs - clip.startMs;
  const duration = audioClipDuration(clip);
  const fadeIn = clip.fadeInMs > 0 ? clamp(offset / clip.fadeInMs, 0, 1) : 1;
  const fadeOut = clip.fadeOutMs > 0 ? clamp((duration - offset) / clip.fadeOutMs, 0, 1) : 1;
  return clamp(clip.volume * Math.min(fadeIn, fadeOut), 0, 1);
}

export function addAudioSourceToProject(
  project: CaptionProject,
  source: ProjectAudioSource,
  clipId: string,
  startMs: number,
  timelineDurationMs: number,
) {
  const safeStartMs = clamp(startMs, 0, Math.max(0, timelineDurationMs - MINIMUM_AUDIO_CLIP_MS));
  const visibleDuration = Math.min(source.durationMs, Math.max(0, timelineDurationMs - safeStartMs));
  if (visibleDuration < MINIMUM_AUDIO_CLIP_MS) return null;
  const clip: AudioClip = {
    id: clipId,
    sourceId: source.id,
    anchor: 'timeline',
    startMs: safeStartMs,
    sourceStartMs: 0,
    sourceEndMs: visibleDuration,
    volume: 1,
    muted: false,
    fadeInMs: 0,
    fadeOutMs: 0,
  };
  return {
    project: updateProject(project, {
      audioSources: [...project.audioSources, source],
      audioClips: [...project.audioClips, clip],
    }),
    clip,
  };
}

export function updateAudioClip(
  project: CaptionProject,
  clipId: string,
  patch: Partial<Pick<AudioClip, 'volume' | 'muted' | 'fadeInMs' | 'fadeOutMs'>>,
) {
  return updateProject(project, {
    audioClips: project.audioClips.map((clip) => {
      if (clip.id !== clipId) return clip;
      const duration = audioClipDuration(clip);
      return {
        ...clip,
        ...patch,
        volume: clamp(patch.volume ?? clip.volume, 0, 1),
        fadeInMs: clamp(patch.fadeInMs ?? clip.fadeInMs, 0, duration),
        fadeOutMs: clamp(patch.fadeOutMs ?? clip.fadeOutMs, 0, duration),
      };
    }),
  });
}

export function moveAudioClip(project: CaptionProject, clipId: string, startMs: number, timelineDurationMs: number) {
  return updateProject(project, {
    audioClips: project.audioClips.map((clip) => {
      if (clip.id !== clipId) return clip;
      const range = editTimelineRange(
        { startMs: clip.startMs, endMs: audioClipEnd(clip) },
        'move',
        startMs,
        startMs + audioClipDuration(clip),
        timelineDurationMs,
        MINIMUM_AUDIO_CLIP_MS,
      );
      return range.startMs === clip.startMs ? clip : { ...clip, startMs: range.startMs };
    }),
  });
}

export function trimAudioClip(
  project: CaptionProject,
  clipId: string,
  edge: 'start' | 'end',
  requestedTimelineMs: number,
  timelineDurationMs: number,
) {
  const sourceById = new Map(project.audioSources.map((source) => [source.id, source]));
  return updateProject(project, {
    audioClips: project.audioClips.map((clip) => {
      if (clip.id !== clipId) return clip;
      const source = sourceById.get(clip.sourceId);
      if (!source || !Number.isFinite(requestedTimelineMs) || !Number.isFinite(timelineDurationMs)) return clip;
      if (edge === 'start') {
        const targetStart = clamp(
          requestedTimelineMs,
          Math.max(0, clip.startMs - clip.sourceStartMs),
          audioClipEnd(clip) - MINIMUM_AUDIO_CLIP_MS,
        );
        const sourceStartMs = clip.sourceStartMs + targetStart - clip.startMs;
        return clampAudioFades({ ...clip, startMs: targetStart, sourceStartMs });
      }
      const targetEnd = clamp(
        requestedTimelineMs,
        clip.startMs + MINIMUM_AUDIO_CLIP_MS,
        Math.min(timelineDurationMs, clip.startMs + source.durationMs - clip.sourceStartMs),
      );
      return clampAudioFades({ ...clip, sourceEndMs: clip.sourceStartMs + targetEnd - clip.startMs });
    }),
  });
}

export function splitAudioClip(
  project: CaptionProject,
  clipId: string,
  timelineMs: number,
  leftId: string,
  rightId: string,
) {
  const index = project.audioClips.findIndex((clip) => clip.id === clipId);
  const clip = project.audioClips[index];
  if (
    !clip
    || leftId === rightId
    || project.audioClips.some((candidate) => candidate.id === leftId || candidate.id === rightId)
  ) return null;
  const split = splitTimelineRange(
    { startMs: clip.startMs, endMs: audioClipEnd(clip) },
    timelineMs,
    MINIMUM_AUDIO_CLIP_MS,
  );
  if (!split) return null;
  const sourceSplitMs = clip.sourceStartMs + split.left.endMs - split.left.startMs;
  const left = clampAudioFades({
    ...clip,
    id: leftId,
    sourceEndMs: sourceSplitMs,
    fadeOutMs: 0,
  });
  const right = clampAudioFades({
    ...clip,
    id: rightId,
    startMs: split.right.startMs,
    sourceStartMs: sourceSplitMs,
    fadeInMs: 0,
  });
  const audioClips = [...project.audioClips];
  audioClips.splice(index, 1, left, right);
  return { project: updateProject(project, { audioClips }), left, right };
}

export function deleteAudioClip(project: CaptionProject, clipId: string) {
  return updateProject(project, { audioClips: project.audioClips.filter((clip) => clip.id !== clipId) });
}

export function duplicateAudioClip(project: CaptionProject, clipId: string, nextId: string, timelineDurationMs: number) {
  const clip = project.audioClips.find((candidate) => candidate.id === clipId);
  if (!clip) return null;
  const duration = audioClipDuration(clip);
  const startMs = clamp(audioClipEnd(clip), 0, Math.max(0, timelineDurationMs - duration));
  const duplicate = { ...clip, id: nextId, startMs };
  return { project: updateProject(project, { audioClips: [...project.audioClips, duplicate] }), clip: duplicate };
}

export function applyTimelineSpliceToAudioClips(
  audioClips: AudioClip[] | undefined,
  splice: { atMs: number; removeMs: number; insertMs: number },
) {
  const clips = audioClips ?? [];
  if (![splice.atMs, splice.removeMs, splice.insertMs].every(Number.isFinite)) return clips;
  const atMs = Math.max(0, splice.atMs);
  const removeMs = Math.max(0, splice.removeMs);
  const insertMs = Math.max(0, splice.insertMs);
  const deltaMs = insertMs - removeMs;
  if (Math.abs(deltaMs) < 1) return clips;
  const boundaryMs = atMs + removeMs;
  return clips.map((clip) => clip.startMs >= boundaryMs
    ? { ...clip, startMs: Math.max(0, clip.startMs + deltaMs) }
    : clip);
}

export function constrainAudioClips(audioClips: AudioClip[] | undefined, timelineDurationMs: number) {
  if (!audioClips) return [];
  return audioClips.flatMap((clip) => {
    if (clip.startMs >= timelineDurationMs) return [];
    const maximumDuration = timelineDurationMs - clip.startMs;
    const sourceEndMs = Math.min(clip.sourceEndMs, clip.sourceStartMs + maximumDuration);
    return sourceEndMs - clip.sourceStartMs >= MINIMUM_AUDIO_CLIP_MS
      ? [clampAudioFades({ ...clip, sourceEndMs })]
      : [];
  });
}

function clampAudioFades(clip: AudioClip): AudioClip {
  const durationMs = audioClipDuration(clip);
  return {
    ...clip,
    fadeInMs: clamp(clip.fadeInMs, 0, durationMs),
    fadeOutMs: clamp(clip.fadeOutMs, 0, durationMs),
  };
}

function updateProject(project: CaptionProject, update: Partial<CaptionProject>): CaptionProject {
  return { ...project, ...update, updatedAt: new Date().toISOString() };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
