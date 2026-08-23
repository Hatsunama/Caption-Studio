import type { CaptionBlock, CaptionProject, VideoClip, VisualLayer, WordToken } from '@/types/project';
import { audioClipEnd, constrainAudioClips } from '@/lib/audio-timeline';

export const MINIMUM_CLIP_TIMELINE_MS = 120;

export type ClipTimelineEntry = {
  clip: VideoClip;
  gapStartMs: number;
  startMs: number;
  endMs: number;
  afterGapEndMs: number;
};

export type TimelineSegment =
  | { kind: 'gap'; startMs: number; endMs: number; next?: ClipTimelineEntry }
  | { kind: 'clip'; entry: ClipTimelineEntry };

export function buildClipTimeline(clips: VideoClip[]): ClipTimelineEntry[] {
  let cursor = 0;
  return clips.map((clip) => {
    const gapStartMs = cursor;
    cursor += validGap(clip.gapBeforeMs);
    const startMs = cursor;
    cursor += clipTimelineDuration(clip);
    const endMs = cursor;
    cursor += validGap(clip.gapAfterMs);
    return { clip, gapStartMs, startMs, endMs, afterGapEndMs: cursor };
  });
}

export function timelineEntryAt(entries: ClipTimelineEntry[], timelineMs: number) {
  if (entries.length === 0) return undefined;
  return entries.find((entry) => timelineMs >= entry.startMs && timelineMs < entry.endMs)
    ?? (timelineMs === entries[entries.length - 1].endMs ? entries[entries.length - 1] : undefined);
}

export function timelineSegmentAt(entries: ClipTimelineEntry[], timelineMs: number): TimelineSegment | undefined {
  const clampedTime = Math.max(0, timelineMs);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (clampedTime >= entry.gapStartMs && clampedTime < entry.startMs) {
      return { kind: 'gap', startMs: entry.gapStartMs, endMs: entry.startMs, next: entry };
    }
    if (clampedTime >= entry.startMs && clampedTime < entry.endMs) return { kind: 'clip', entry };
    if (clampedTime >= entry.endMs && clampedTime < entry.afterGapEndMs) {
      const next = entries[index + 1];
      return { kind: 'gap', startMs: entry.endMs, endMs: next?.startMs ?? entry.afterGapEndMs, next };
    }
  }
  const last = entries.at(-1);
  return last && clampedTime === last.afterGapEndMs
    ? last.afterGapEndMs === last.endMs ? { kind: 'clip', entry: last } : undefined
    : undefined;
}

export function totalClipDuration(clips: VideoClip[]) {
  return buildClipTimeline(clips).at(-1)?.afterGapEndMs ?? 0;
}

export function clipTimelineDuration(clip: VideoClip) {
  return Math.max(0, clip.sourceEndMs - clip.sourceStartMs) / validPlaybackRate(clip.playbackRate);
}

export function sourceTimeAt(entry: ClipTimelineEntry, timelineMs: number) {
  return entry.clip.sourceStartMs
    + clamp(timelineMs - entry.startMs, 0, entry.endMs - entry.startMs) * validPlaybackRate(entry.clip.playbackRate);
}

export function timelineTimeAt(entry: ClipTimelineEntry, sourceMs: number) {
  return entry.startMs
    + clamp(sourceMs - entry.clip.sourceStartMs, 0, entry.clip.sourceEndMs - entry.clip.sourceStartMs)
      / validPlaybackRate(entry.clip.playbackRate);
}

export function clipPlaybackVolume(clip: VideoClip, timelineOffsetMs: number) {
  if (clip.muted) return 0;
  const duration = clipTimelineDuration(clip);
  const fadeIn = clip.fadeInMs > 0 ? clamp(timelineOffsetMs / clip.fadeInMs, 0, 1) : 1;
  const fadeOut = clip.fadeOutMs > 0 ? clamp((duration - timelineOffsetMs) / clip.fadeOutMs, 0, 1) : 1;
  return clamp(clip.volume * Math.min(fadeIn, fadeOut), 0, 1);
}

export function videoTransitionOverlay(entries: ClipTimelineEntry[], timelineMs: number) {
  for (let index = 0; index < entries.length - 1; index += 1) {
    const entry = entries[index];
    const next = entries[index + 1];
    const transition = entry.clip.transitionAfter;
    if (!transition || transition.type === 'none' || transition.durationMs <= 0) continue;
    const half = transition.durationMs / 2;
    const boundaryMs = next.startMs;
    const distance = Math.abs(timelineMs - boundaryMs);
    if (distance > half) continue;
    const normalized = 1 - distance / Math.max(1, half);
    const opacity = transition.type === 'flash'
      ? Math.sin(normalized * Math.PI / 2) * 0.92
      : normalized;
    return {
      color: transition.type === 'dip-white' || transition.type === 'flash' ? '#FFFFFF' : '#000000',
      opacity: clamp(opacity, 0, 1),
    };
  }
  return undefined;
}

export function mapSourceWordsToTimeline(
  clips: VideoClip[],
  sourceWords: Record<string, WordToken[]>,
) {
  const timelineWords: WordToken[] = [];
  for (const entry of buildClipTimeline(clips)) {
    const rate = validPlaybackRate(entry.clip.playbackRate);
    for (const word of sourceWords[entry.clip.sourceId] ?? []) {
      const clippedStart = Math.max(word.startMs, entry.clip.sourceStartMs);
      const clippedEnd = Math.min(word.endMs, entry.clip.sourceEndMs);
      if (clippedEnd <= clippedStart) continue;
      timelineWords.push({
        ...word,
        id: `${entry.clip.id}-${word.id}`,
        startMs: entry.startMs + (clippedStart - entry.clip.sourceStartMs) / rate,
        endMs: entry.startMs + (clippedEnd - entry.clip.sourceStartMs) / rate,
      });
    }
  }
  return timelineWords;
}

export function recoverCanonicalSourceWords(clips: VideoClip[], timelineWords: WordToken[]) {
  const entries = buildClipTimeline(clips);
  const wordsBySource = new Map<string, Map<string, WordToken>>();
  for (const word of timelineWords) {
    const startEntry = timelineEntryAt(entries, word.startMs);
    const endEntry = timelineEntryAt(entries, Math.max(word.startMs, word.endMs - 1));
    if (!startEntry || !endEntry || startEntry.clip.sourceId !== endEntry.clip.sourceId) continue;
    const prefix = `${startEntry.clip.id}-`;
    const id = word.id.startsWith(prefix) ? word.id.slice(prefix.length) : word.id;
    const canonical = {
      ...word,
      id,
      startMs: sourceTimeAt(startEntry, word.startMs),
      endMs: sourceTimeAt(endEntry, word.endMs),
    };
    const sourceWords = wordsBySource.get(startEntry.clip.sourceId) ?? new Map<string, WordToken>();
    sourceWords.set(`${canonical.id}:${canonical.startMs}:${canonical.endMs}`, canonical);
    wordsBySource.set(startEntry.clip.sourceId, sourceWords);
  }
  return Object.fromEntries([...wordsBySource].map(([sourceId, words]) => [
    sourceId,
    [...words.values()].sort((left, right) => left.startMs - right.startMs),
  ]));
}

export function anchorCaptionsToClips(
  captions: CaptionBlock[],
  clips: VideoClip[],
  timelineWords: WordToken[],
) {
  const entries = buildClipTimeline(clips);
  const wordById = new Map(timelineWords.map((word) => [word.id, word]));
  const reservedIds = new Set(captions.map((caption) => caption.id));
  return captions.flatMap((caption) => {
    if (caption.sourceAnchor) return [caption];
    const owners = entries.map((entry) => {
      if (caption.startMs >= entry.endMs || caption.endMs <= entry.startMs) return undefined;
      const prefix = `${entry.clip.id}-`;
      const wordIds = caption.wordIds.filter((wordId) => wordId.startsWith(prefix) && wordById.has(wordId));
      if (wordIds.length === 0) {
        for (const legacyWordId of caption.wordIds) {
          const mappedId = `${prefix}${legacyWordId}`;
          if (wordById.has(mappedId)) wordIds.push(mappedId);
        }
      }
      return {
        entry,
        wordIds,
        words: wordIds.map((wordId) => wordById.get(wordId)!).filter(Boolean),
        startMs: Math.max(caption.startMs, entry.startMs),
        endMs: Math.min(caption.endMs, entry.endMs),
      };
    }).filter((owner): owner is NonNullable<typeof owner> => Boolean(owner));
    if (owners.length === 0) {
      return [{ ...caption, textMode: caption.textMode ?? 'manual', timelineVisible: caption.timelineVisible ?? true }];
    }
    const completeAutomaticText = joinTimelineWords(owners.flatMap((owner) => owner.words));
    const textMode = caption.textMode ?? (completeAutomaticText === caption.text ? 'automatic' : 'manual');
    return owners.map((owner, index) => {
      const automaticText = joinTimelineWords(owner.words);
      const derivedId = index === 0 ? caption.id : reserveDerivedCaptionId(caption.id, owner.entry.clip.id, reservedIds);
      const useAutomaticPiece = textMode === 'automatic' || (index > 0 && Boolean(automaticText));
      return {
        ...caption,
        id: derivedId,
        text: useAutomaticPiece && automaticText ? automaticText : caption.text,
        textMode: useAutomaticPiece ? 'automatic' as const : textMode,
        startMs: owner.startMs,
        endMs: owner.endMs,
        wordIds: owner.wordIds,
        timelineVisible: owner.endMs - owner.startMs >= 80,
        sourceAnchor: {
          clipId: owner.entry.clip.id,
          sourceStartMs: sourceTimeAt(owner.entry, owner.startMs),
          sourceEndMs: sourceTimeAt(owner.entry, owner.endMs),
          wordIds: owner.wordIds,
        },
      };
    });
  });
}

export function remapCaptionsToTimeline(
  captions: CaptionBlock[],
  clips: VideoClip[],
  timelineWords: WordToken[],
) {
  const entryByClipId = new Map(buildClipTimeline(clips).map((entry) => [entry.clip.id, entry]));
  const wordById = new Map(timelineWords.map((word) => [word.id, word]));
  return captions.map((caption) => {
    const anchor = caption.sourceAnchor;
    if (!anchor) return caption;
    const entry = entryByClipId.get(anchor.clipId);
    if (!entry) return { ...caption, timelineVisible: false };
    const visibleSourceStart = Math.max(anchor.sourceStartMs, entry.clip.sourceStartMs);
    const visibleSourceEnd = Math.min(anchor.sourceEndMs, entry.clip.sourceEndMs);
    if (visibleSourceEnd <= visibleSourceStart) return { ...caption, timelineVisible: false };
    const startMs = timelineTimeAt(entry, visibleSourceStart);
    const endMs = timelineTimeAt(entry, visibleSourceEnd);
    const wordIds = anchor.wordIds.filter((wordId) => wordById.has(wordId));
    const automaticText = joinTimelineWords(wordIds.map((wordId) => wordById.get(wordId)!).filter(Boolean));
    return {
      ...caption,
      startMs,
      endMs,
      wordIds,
      text: caption.textMode === 'automatic' && automaticText ? automaticText : caption.text,
      timelineVisible: endMs - startMs >= 80,
    };
  });
}

export function visibleTimelineCaptions(captions: CaptionBlock[]) {
  return captions.filter((caption) => caption.timelineVisible !== false);
}

export function rippleDelete(project: CaptionProject, cutStartMs: number, cutEndMs: number, clipId: string): CaptionProject {
  const rippled = rippleTimedContent(project, cutStartMs, cutEndMs);
  return {
    ...rippled,
    clips: project.clips.filter((clip) => clip.id !== clipId),
    captions: rippled.captions.filter((caption) => caption.sourceAnchor?.clipId !== clipId),
  };
}

export function rippleTimedContent(project: CaptionProject, cutStartMs: number, cutEndMs: number): CaptionProject {
  const words = project.transcription.words
    .map((word) => {
      const range = rippleRange(word.startMs, word.endMs, cutStartMs, cutEndMs);
      return range ? { ...word, ...range } : undefined;
    })
    .filter((word): word is NonNullable<typeof word> => Boolean(word));
  const wordMap = new Map(words.map((word) => [word.id, word]));
  const captions = project.captions
    .map((caption) => {
      const range = rippleRange(caption.startMs, caption.endMs, cutStartMs, cutEndMs);
      if (!range) return undefined;
      const wordIds = caption.wordIds.filter((id) => wordMap.has(id));
      const text = caption.textMode === 'manual' || wordIds.length === 0
        ? caption.text
        : joinTimelineWords(wordIds.map((id) => wordMap.get(id)!).filter(Boolean));
      return { ...caption, ...range, wordIds, text };
    })
    .filter((caption): caption is NonNullable<typeof caption> => Boolean(caption));
  const layers = project.layers
    .map((layer) => {
      if (layer.kind === 'captions') return layer;
      const range = rippleRange(layer.startMs, layer.endMs, cutStartMs, cutEndMs);
      return range ? { ...layer, ...range } : undefined;
    })
    .filter((layer): layer is VisualLayer => Boolean(layer));
  const audioClips = project.audioClips.flatMap((clip) => {
    const range = rippleRange(clip.startMs, audioClipEnd(clip), cutStartMs, cutEndMs);
    if (!range) return [];
    const duration = range.endMs - range.startMs;
    return [{ ...clip, startMs: range.startMs, sourceEndMs: clip.sourceStartMs + duration }];
  });
  return {
    ...project,
    updatedAt: new Date().toISOString(),
    transcription: { ...project.transcription, words },
    captions,
    layers,
    audioClips,
  };
}

export function setClipPlaybackRate(project: CaptionProject, clipId: string, playbackRate: number) {
  const entries = buildClipTimeline(project.clips);
  const entry = entries.find((candidate) => candidate.clip.id === clipId);
  if (!entry) return project;
  const rate = validPlaybackRate(playbackRate);
  if (rate === entry.clip.playbackRate) return project;
  const replacement = { ...entry.clip, playbackRate: rate };
  const replacementDuration = clipTimelineDuration(replacement);
  const oldDuration = entry.endMs - entry.startMs;
  const delta = replacementDuration - oldDuration;
  const mapTime = (timeMs: number) => {
    if (timeMs <= entry.startMs) return timeMs;
    if (timeMs >= entry.endMs) return timeMs + delta;
    return entry.startMs + (timeMs - entry.startMs) * replacementDuration / Math.max(1, oldDuration);
  };
  const words = project.transcription.words.map((word) => ({ ...word, startMs: mapTime(word.startMs), endMs: mapTime(word.endMs) }));
  const captions = project.captions.map((caption) => ({ ...caption, startMs: mapTime(caption.startMs), endMs: mapTime(caption.endMs) }));
  const layers = project.layers.map((layer) => layer.kind === 'captions'
    ? layer
    : { ...layer, startMs: mapTime(layer.startMs), endMs: mapTime(layer.endMs) });
  const audioClips = constrainAudioClips(
    project.audioClips.map((clip) => clip.startMs >= entry.endMs ? { ...clip, startMs: clip.startMs + delta } : clip),
    totalClipDuration(project.clips.map((clip) => clip.id === clipId ? replacement : clip)),
  );
  return {
    ...project,
    updatedAt: new Date().toISOString(),
    clips: project.clips.map((clip) => clip.id === clipId ? replacement : clip),
    transcription: { ...project.transcription, words },
    captions,
    layers,
    audioClips,
  };
}

function rippleRange(startMs: number, endMs: number, cutStartMs: number, cutEndMs: number) {
  const removed = Math.max(0, cutEndMs - cutStartMs);
  if (endMs <= cutStartMs) return { startMs, endMs };
  if (startMs >= cutEndMs) return { startMs: startMs - removed, endMs: endMs - removed };
  if (startMs < cutStartMs && endMs > cutEndMs) return { startMs, endMs: endMs - removed };
  if (startMs < cutStartMs) {
    const next = { startMs, endMs: cutStartMs };
    return next.endMs - next.startMs >= 80 ? next : undefined;
  }
  if (endMs > cutEndMs) {
    const next = { startMs: cutStartMs, endMs: endMs - removed };
    return next.endMs - next.startMs >= 80 ? next : undefined;
  }
  return undefined;
}

function validPlaybackRate(rate: number) {
  return clamp(Number.isFinite(rate) ? rate : 1, 0.25, 4);
}

function validGap(gapMs: number) {
  return Math.max(0, Number.isFinite(gapMs) ? gapMs : 0);
}

function joinTimelineWords(words: WordToken[]) {
  return words
    .map((word) => word.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([([{])\s+/g, '$1')
    .trim();
}

function reserveDerivedCaptionId(captionId: string, clipId: string, reservedIds: Set<string>) {
  const base = `${captionId}-${clipId}`;
  let candidate = base;
  let suffix = 2;
  while (reservedIds.has(candidate)) candidate = `${base}-${suffix++}`;
  reservedIds.add(candidate);
  return candidate;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
