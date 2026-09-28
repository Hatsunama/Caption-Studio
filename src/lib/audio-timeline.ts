import type { AudioClip, CaptionProject, ProjectAudioSource, VideoClip } from '@/types/project';
import { editTimelineRange, MINIMUM_TIMELINE_ITEM_MS, splitTimelineRange } from '@/lib/timeline-item-timing';
import { buildClipTimeline, totalClipDuration } from '@/lib/video-timeline';

export const MINIMUM_AUDIO_CLIP_MS = MINIMUM_TIMELINE_ITEM_MS;

export function audioClipDuration(clip: AudioClip) {
  return Math.max(0, clip.sourceEndMs - clip.sourceStartMs) / (clip.playbackRate ?? 1);
}

export function audioClipEnd(clip: AudioClip) {
  return clip.startMs + audioClipDuration(clip);
}

/** Project stored ranges stay intact; only the export projection is clipped. */
export function audibleAudioClipsWithin(project: CaptionProject, durationMs: number): AudioClip[] {
  return project.audioClips.flatMap((clip) => {
    if (clip.muted || clip.hiddenByVideoTrim || clip.volume <= 0) return [];
    const startMs = Math.max(0, clip.startMs);
    const endMs = Math.min(durationMs, audioClipEnd(clip));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
    const rate = clip.playbackRate ?? 1;
    const sourceStartMs = clip.sourceStartMs + (startMs - clip.startMs) * rate;
    return [clampAudioFades({ ...clip, startMs, sourceStartMs,
      sourceEndMs: sourceStartMs + (endMs - startMs) * rate })];
  });
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
  attachment?: { videoClipId: string },
) {
  const owner = attachment && source.origin === 'video-audio'
    ? buildClipTimeline(project.clips).find((entry) => entry.clip.id === attachment.videoClipId
      && startMs >= entry.startMs && startMs < entry.endMs)
    : undefined;
  const extentMs = project.clips?.length ? totalClipDuration(project.clips)
    : Math.max(timelineDurationMs, Math.max(0, startMs) + source.durationMs);
  const safeStartMs = clamp(startMs, 0, Math.max(0, extentMs - MINIMUM_AUDIO_CLIP_MS));
  const rate = owner?.clip.playbackRate ?? 1;
  const sourceStartMs = owner
    ? owner.clip.sourceStartMs + (safeStartMs - owner.startMs) * rate
    : 0;
  const visibleDuration = Math.min(
    (source.durationMs - sourceStartMs) / rate,
    Math.max(0, (owner?.endMs ?? extentMs) - safeStartMs),
  );
  if (visibleDuration < MINIMUM_AUDIO_CLIP_MS) return null;
  const clip: AudioClip = {
    id: clipId,
    sourceId: source.id,
    anchor: owner ? 'video' : 'timeline',
    ...(owner ? { videoClipId: owner.clip.id, requestedSourceStartMs: sourceStartMs,
      requestedSourceEndMs: sourceStartMs + visibleDuration * rate, anchorOffsetMs: 0,
      playbackRate: rate } : {}),
    startMs: safeStartMs,
    sourceStartMs,
    sourceEndMs: sourceStartMs + visibleDuration * rate,
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
        audioEditExtent(project, timelineDurationMs),
        MINIMUM_AUDIO_CLIP_MS,
      );
      if (range.startMs === clip.startMs) return clip;
      if (clip.anchor !== 'video' || !clip.videoClipId) return { ...clip, startMs: range.startMs };
      const owner = buildClipTimeline(project.clips).find((entry) => entry.clip.id === clip.videoClipId);
      if (!owner || range.startMs < owner.startMs || range.endMs > owner.endMs) {
        return detachAudioFromVideo({ ...clip, startMs: range.startMs });
      }
      return { ...clip, startMs: range.startMs,
        anchorOffsetMs: (clip.anchorOffsetMs ?? 0) + range.startMs - clip.startMs };
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
          Math.max(0, clip.startMs - clip.sourceStartMs / (clip.playbackRate ?? 1)),
          audioClipEnd(clip) - MINIMUM_AUDIO_CLIP_MS,
        );
        const sourceStartMs = clip.sourceStartMs + (targetStart - clip.startMs) * (clip.playbackRate ?? 1);
        return detachAudioWhenOutsideOwner(project, clampAudioFades({ ...clip, startMs: targetStart, sourceStartMs,
          ...(clip.anchor === 'video' ? { requestedSourceStartMs: sourceStartMs } : {}) }));
      }
      const targetEnd = clamp(
        requestedTimelineMs,
        clip.startMs + MINIMUM_AUDIO_CLIP_MS,
        Math.min(audioEditExtent(project, timelineDurationMs), clip.startMs
          + (source.durationMs - clip.sourceStartMs) / (clip.playbackRate ?? 1)),
      );
      const sourceEndMs = clip.sourceStartMs + (targetEnd - clip.startMs) * (clip.playbackRate ?? 1);
      return detachAudioWhenOutsideOwner(project, clampAudioFades({ ...clip, sourceEndMs,
        ...(clip.anchor === 'video' ? { requestedSourceEndMs: sourceEndMs } : {}) }));
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
  const sourceSplitMs = clip.sourceStartMs + (split.left.endMs - split.left.startMs) * (clip.playbackRate ?? 1);
  const left = clampAudioFades({
    ...clip,
    id: leftId,
    sourceEndMs: sourceSplitMs,
    ...(clip.anchor === 'video' ? { requestedSourceEndMs: sourceSplitMs } : {}),
    fadeOutMs: 0,
  });
  const right = clampAudioFades({
    ...clip,
    id: rightId,
    startMs: split.right.startMs,
    sourceStartMs: sourceSplitMs,
    ...(clip.anchor === 'video' ? { requestedSourceStartMs: sourceSplitMs } : {}),
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
  const extentMs = audioEditExtent(project, timelineDurationMs);
  const duration = Math.min(audioClipDuration(clip), Math.max(0, extentMs));
  if (duration < MINIMUM_AUDIO_CLIP_MS) return null;
  const startMs = clamp(audioClipEnd(clip), 0, extentMs - duration);
  const duplicate = clampAudioFades({ ...detachAudioFromVideo(clip), id: nextId, startMs,
    sourceEndMs: clip.sourceStartMs + duration * (clip.playbackRate ?? 1) });
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
  return clips.map((clip) => clip.anchor !== 'video' && clip.startMs >= boundaryMs
    ? { ...clip, startMs: Math.max(0, clip.startMs + deltaMs) }
    : clip);
}

export function remapAudioAfterVideoEdit(audioClips: AudioClip[] | undefined, clips: VideoClip[]): AudioClip[] {
  const entries = new Map(buildClipTimeline(clips).map((entry) => [entry.clip.id, entry]));
  return (audioClips ?? []).map((clip) => {
    if (clip.anchor !== 'video' || !clip.videoClipId) return clip;
    const owner = entries.get(clip.videoClipId);
    if (!owner) return detachAudioFromVideo(clip);
    const requestedStart = clip.requestedSourceStartMs ?? clip.sourceStartMs;
    const requestedEnd = clip.requestedSourceEndMs ?? clip.sourceEndMs;
    const rate = owner.clip.playbackRate;
    const idealStart = owner.startMs + (requestedStart - owner.clip.sourceStartMs) / rate
      + (clip.anchorOffsetMs ?? 0);
    const visibleStart = Math.max(owner.startMs, idealStart);
    const visibleEnd = Math.min(owner.endMs, idealStart + (requestedEnd - requestedStart) / rate);
    if (visibleEnd - visibleStart < MINIMUM_AUDIO_CLIP_MS) {
      return { ...clip, startMs: owner.startMs, hiddenByVideoTrim: true,
        playbackRate: rate, sourceStartMs: requestedStart, sourceEndMs: requestedEnd };
    }
    const sourceStartMs = requestedStart + (visibleStart - idealStart) * rate;
    const sourceEndMs = requestedStart + (visibleEnd - idealStart) * rate;
    return clampAudioFades({ ...clip, startMs: visibleStart, sourceStartMs, sourceEndMs,
      playbackRate: rate, hiddenByVideoTrim: false });
  });
}

export function splitAttachedAudioForVideo(
  audioClips: AudioClip[] | undefined, videoClipId: string, leftClipId: string, rightClipId: string, sourceSplitMs: number,
) {
  const existingIds = new Set((audioClips ?? []).map((clip) => clip.id));
  return (audioClips ?? []).flatMap((clip) => {
    if (clip.anchor !== 'video' || clip.videoClipId !== videoClipId) return [clip];
    const start = clip.requestedSourceStartMs ?? clip.sourceStartMs;
    const end = clip.requestedSourceEndMs ?? clip.sourceEndMs;
    const leftEnd = Math.min(end, sourceSplitMs);
    const rightStart = Math.max(start, sourceSplitMs);
    const rate = clip.playbackRate ?? 1;
    const left = (leftEnd - start) / rate >= MINIMUM_AUDIO_CLIP_MS
      ? [{ ...clip, videoClipId: leftClipId, requestedSourceStartMs: start,
        requestedSourceEndMs: leftEnd, sourceStartMs: start, sourceEndMs: leftEnd,
        fadeOutMs: end > sourceSplitMs ? 0 : clip.fadeOutMs }]
      : [];
    if ((end - rightStart) / rate < MINIMUM_AUDIO_CLIP_MS) return left;
    let rightId = left.length ? `${clip.id}-${rightClipId}` : clip.id;
    for (let index = 2; existingIds.has(rightId); index += 1) rightId = `${clip.id}-${rightClipId}-${index}`;
    existingIds.add(rightId);
    return [...left, { ...clip, id: rightId, videoClipId: rightClipId,
      requestedSourceStartMs: rightStart, requestedSourceEndMs: end,
      sourceStartMs: rightStart, sourceEndMs: end,
      fadeInMs: start < sourceSplitMs ? 0 : clip.fadeInMs }];
  });
}

function detachAudioFromVideo(clip: AudioClip): AudioClip {
  const { videoClipId, requestedSourceStartMs, requestedSourceEndMs,
    anchorOffsetMs, hiddenByVideoTrim, ...timelineClip } = clip;
  return { ...timelineClip, anchor: 'timeline' };
}

function detachAudioWhenOutsideOwner(project: CaptionProject, clip: AudioClip): AudioClip {
  if (clip.anchor !== 'video' || !clip.videoClipId) return clip;
  const owner = buildClipTimeline(project.clips).find((entry) => entry.clip.id === clip.videoClipId);
  if (owner && clip.startMs >= owner.startMs && audioClipEnd(clip) <= owner.endMs) return clip;
  return detachAudioFromVideo(clip);
}

export function constrainAudioClips(audioClips: AudioClip[] | undefined, timelineDurationMs: number) {
  if (!audioClips) return [];
  return audioClips.flatMap((clip) => {
    if (clip.startMs >= timelineDurationMs) return [];
    const maximumDuration = timelineDurationMs - clip.startMs;
    const sourceEndMs = Math.min(clip.sourceEndMs,
      clip.sourceStartMs + maximumDuration * (clip.playbackRate ?? 1));
    return sourceEndMs > clip.sourceStartMs
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

function audioEditExtent(project: CaptionProject, requestedMs: number) {
  return project.clips?.length ? totalClipDuration(project.clips) : requestedMs;
}

function updateProject(project: CaptionProject, update: Partial<CaptionProject>): CaptionProject {
  return { ...project, ...update, updatedAt: new Date().toISOString() };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
