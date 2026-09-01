import { mergeStyle } from '@/lib/style-resolver';
import { synchronizeCaptionTracks } from '@/lib/caption-tracks';
import { applyCaptionTextChanges, type CaptionTextChanges } from '@/lib/caption-text-edits';
import { constrainAudioClips } from '@/lib/audio-timeline';
import { captionSpokenTokenSpans } from '@/lib/caption-text-breaks';
import {
  canApplyVideoTransition,
  isVideoTransitionType,
  normalizeVideoTransitionBoundaries,
} from '@/lib/video-transitions';
import {
  mergeVideoTransform,
  resolveVideoTransform,
  sameVideoTransform,
} from '@/lib/video-transform';
import {
  anchorCaptionsToClips,
  buildClipTimeline,
  mapSourceWordsToTimeline,
  MINIMUM_CLIP_TIMELINE_MS,
  remapCaptionsToTimeline,
  sourceTimeAt,
  timelineEntryAt,
  timelineTimeAt,
  totalClipDuration,
} from '@/lib/video-timeline';
import {
  DEFAULT_CAPTION_STYLE,
  type BackgroundReplacement,
  type CaptionProject,
  type CaptionStylePatch,
  type ImageVisualLayer,
  type TextVisualLayer,
  type VideoClip,
  type VideoTransformPatch,
} from '@/types/project';

export function setBackgroundReplacement(project: CaptionProject, value: BackgroundReplacement) {
  if (project.backgroundReplacement === value) return project;
  return updateProject(project, { backgroundReplacement: value });
}

export function setCaptionTexts(project: CaptionProject, changes: CaptionTextChanges) {
  const changed = applyCaptionTextChanges(project.captions, changes);
  if (changed === project.captions) return project;
  const captions = changed.map((caption, index) => caption === project.captions[index]
    ? caption
    : { ...caption, textMode: 'manual' as const });
  return updateProject(project, { captions });
}

export function setTextLayerText(project: CaptionProject, layerId: string, text: string) {
  const value = text.trim() || 'Text';
  return updateProject(project, {
    layers: project.layers.map((layer) => layer.id === layerId && layer.kind === 'text'
      ? { ...layer, text: value, name: value.slice(0, 18) }
      : layer),
  });
}

export function setTextLayerStyle(project: CaptionProject, layerId: string, patch: CaptionStylePatch) {
  return updateProject(project, {
    layers: project.layers.map((layer) => layer.id === layerId && layer.kind === 'text'
      ? { ...layer, style: mergeStyle(layer.style, patch) }
      : layer),
  });
}

export function setVideoClipTransform(
  project: CaptionProject,
  clipId: string,
  patch: VideoTransformPatch,
) {
  let changed = false;
  const clips = project.clips.map((clip) => {
    if (clip.id !== clipId) return clip;
    const current = resolveVideoTransform(clip.transform, project.videoTransform);
    const transform = mergeVideoTransform(current, patch);
    if (sameVideoTransform(current, transform)) return clip;
    changed = true;
    return { ...clip, transform };
  });
  return changed ? updateProject(project, { clips }) : project;
}

export function setCaptionTiming(
  project: CaptionProject,
  captionId: string,
  edge: 'start' | 'end' | 'move',
  startMs: number,
  endMs: number,
) {
  const entries = buildClipTimeline(project.clips);
  const selected = project.captions.find((caption) => caption.id === captionId);
  if (!selected || selected.timelineVisible === false) return project;
  const entry = entries.find((candidate) => candidate.clip.id === selected.sourceAnchor?.clipId)
    ?? timelineEntryAt(entries, selected.startMs)
    ?? timelineEntryAt(entries, Math.max(selected.startMs, selected.endMs - 1));
  if (!entry) return project;
  const minDuration = 80;
  let safeStartMs = selected.startMs;
  let safeEndMs = selected.endMs;
  if (edge === 'start') {
    safeStartMs = clamp(startMs, entry.startMs, selected.endMs - minDuration);
  } else if (edge === 'end') {
    safeEndMs = clamp(endMs, selected.startMs + minDuration, entry.endMs);
  } else {
    const duration = Math.max(minDuration, selected.endMs - selected.startMs);
    safeStartMs = clamp(startMs, entry.startMs, entry.endMs - duration);
    safeEndMs = safeStartMs + duration;
  }
  if (safeStartMs === selected.startMs && safeEndMs === selected.endMs) return project;
  return updateProject(project, {
    captions: project.captions.map((caption) => caption.id === captionId
      ? withTimelineCaptionTiming(caption, entry, safeStartMs, safeEndMs)
      : caption),
  });
}

function withTimelineCaptionTiming(
  caption: CaptionProject['captions'][number],
  entry: ReturnType<typeof buildClipTimeline>[number],
  startMs: number,
  endMs: number,
) {
  return {
    ...caption,
    startMs,
    endMs,
    textMode: 'manual' as const,
    wordIds: [],
    sourceAnchor: {
      clipId: entry.clip.id,
      sourceStartMs: sourceTimeAt(entry, startMs),
      sourceEndMs: sourceTimeAt(entry, endMs),
      wordIds: [],
    },
    timelineVisible: true,
  };
}

export function replaceVisibleCaptionScript(project: CaptionProject, captions: CaptionProject['captions']) {
  const visible = project.captions.filter((caption) => caption.timelineVisible !== false);
  const hidden = project.captions.filter((caption) => caption.timelineVisible === false);
  const hiddenIds = new Set(hidden.map((caption) => caption.id));
  const ids = new Set<string>();
  for (const caption of captions) {
    if (
      !caption.id
      || ids.has(caption.id)
      || hiddenIds.has(caption.id)
      || !caption.text.trim()
      || caption.endMs - caption.startMs < 80
    ) return project;
    ids.add(caption.id);
  }
  if (captions.length === visible.length && captions.every((caption, index) => caption === visible[index])) return project;
  return updateProject(project, {
    captions: [...captions, ...hidden].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs),
  });
}

export function setLayerTiming(project: CaptionProject, layerId: string, startMs: number, endMs: number) {
  const entries = buildClipTimeline(project.clips);
  return updateProject(project, {
    layers: project.layers.map((layer) => layer.id === layerId && layer.kind !== 'captions'
      ? attachLayerToTimeline({ ...layer, startMs, endMs, timelineVisible: true }, entries, true)
      : layer),
  });
}

export function setImageLayer(project: CaptionProject, layerId: string, patch: Partial<ImageVisualLayer>) {
  return updateProject(project, {
    layers: project.layers.map((layer) => layer.id === layerId && layer.kind === 'image'
      ? { ...layer, ...patch }
      : layer),
  });
}

export function createTextLayer(project: CaptionProject, id: string, currentMs: number, durationMs: number) {
  const startMs = clamp(currentMs, 0, Math.max(0, durationMs - 500));
  const layer = attachLayerToTimeline<TextVisualLayer>({
    id,
    kind: 'text',
    name: 'New Text',
    visible: true,
    text: 'New text',
    startMs,
    endMs: Math.min(durationMs, startMs + 3_000),
    style: mergeStyle(DEFAULT_CAPTION_STYLE, {
      position: { x: 0.5, y: 0.48 },
      box: { width: 0.72, height: 0.18 },
      animation: { id: 'none' },
    }),
  }, buildClipTimeline(project.clips));
  const firstImage = project.layers.findIndex((item) => item.kind === 'image');
  const insertion = firstImage < 0 ? project.layers.length : firstImage;
  const layers = [...project.layers];
  layers.splice(insertion, 0, layer);
  return { project: updateProject(project, { layers }), layer };
}

export function addImageLayer(project: CaptionProject, options: {
  id: string;
  name: string;
  uri: string;
  currentMs: number;
  durationMs: number;
}) {
  const startMs = clamp(options.currentMs, 0, Math.max(0, options.durationMs - 500));
  const layer = attachLayerToTimeline<ImageVisualLayer>({
    id: options.id,
    kind: 'image',
    name: options.name.slice(0, 18) || 'Sticker',
    visible: true,
    uri: options.uri,
    startMs,
    endMs: Math.min(options.durationMs, startMs + 3_000),
    position: { x: 0.5, y: 0.5 },
    box: { width: 0.34, height: 0.24 },
    rotation: 0,
    opacity: 1,
  }, buildClipTimeline(project.clips));
  return { project: updateProject(project, { layers: [...project.layers, layer] }), layer };
}

export function moveVisualLayer(project: CaptionProject, layerId: string, direction: -1 | 1) {
  const index = project.layers.findIndex((layer) => layer.id === layerId);
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= project.layers.length) return project;
  const layers = [...project.layers];
  [layers[index], layers[destination]] = [layers[destination], layers[index]];
  return updateProject(project, { layers });
}

export function deleteVisualLayer(project: CaptionProject, layerId: string) {
  if (layerId === 'captions') return project;
  return updateProject(project, { layers: project.layers.filter((layer) => layer.id !== layerId) });
}

export function deleteCaptionBlock(project: CaptionProject, captionId: string) {
  return updateProject(project, { captions: project.captions.filter((caption) => caption.id !== captionId) });
}

export function updateVideoClip(
  project: CaptionProject,
  clipId: string,
  patch: Partial<Pick<VideoClip, 'volume' | 'muted' | 'fadeInMs' | 'fadeOutMs'>>,
) {
  return updateProject(project, {
    clips: project.clips.map((clip) => clip.id === clipId ? { ...clip, ...patch } : clip),
  });
}

export function setVideoTransition(
  project: CaptionProject,
  clipId: string,
  type: VideoClip['transitionAfter']['type'],
  requestedDurationMs = 500,
) {
  const entries = buildClipTimeline(project.clips);
  const index = entries.findIndex((entry) => entry.clip.id === clipId);
  const entry = entries[index];
  const next = entries[index + 1];
  if (!entry || !isVideoTransitionType(type) || !Number.isFinite(requestedDurationMs)) return project;
  if (type !== 'none' && (!next || !canApplyVideoTransition(project.clips, index))) return project;
  const durationMs = type === 'none'
    ? 0
    : clamp(requestedDurationMs, 100, Math.min(2_000, entry.endMs - entry.startMs, next.endMs - next.startMs));
  if (entry.clip.transitionAfter?.type === type && entry.clip.transitionAfter.durationMs === durationMs) return project;
  return updateProject(project, {
    clips: project.clips.map((clip) => clip.id === clipId
      ? { ...clip, transitionAfter: { type, durationMs } }
      : clip),
  });
}

export function moveVideoClip(project: CaptionProject, clipId: string, direction: -1 | 1) {
  const index = project.clips.findIndex((clip) => clip.id === clipId);
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= project.clips.length) return project;
  const clips = [...project.clips];
  [clips[index], clips[destination]] = [clips[destination], clips[index]];
  return rebuildAfterLayoutEdit(project, clips, project.captions, { atMs: 0, removeMs: 0, insertMs: 0 });
}

export function deleteVideoClip(project: CaptionProject, clipId: string) {
  if (project.clips.length <= 1) return null;
  const entry = buildClipTimeline(project.clips).find((candidate) => candidate.clip.id === clipId);
  if (!entry) return null;
  const anchoredCaptions = anchorCaptionsToClips(project.captions, project.clips, project.transcription.words)
    .filter((caption) => caption.sourceAnchor?.clipId !== clipId);
  const clips = project.clips.filter((clip) => clip.id !== clipId);
  const next = rebuildAfterLayoutEdit(project, clips, anchoredCaptions, {
    atMs: entry.gapStartMs,
    removeMs: entry.afterGapEndMs - entry.gapStartMs,
    insertMs: 0,
  });
  const duration = totalClipDuration(clips);
  return { project: next, seekMs: Math.min(entry.gapStartMs, Math.max(0, duration - 1)) };
}

export function splitVideoClip(project: CaptionProject, clipId: string, timelineMs: number, leftId: string, rightId: string) {
  const entry = buildClipTimeline(project.clips).find((candidate) => candidate.clip.id === clipId);
  if (!entry) return null;
  const sourceSplitMs = sourceTimeAt(entry, timelineMs);
  const minimumSourceDuration = MINIMUM_CLIP_TIMELINE_MS * entry.clip.playbackRate;
  if (
    sourceSplitMs - entry.clip.sourceStartMs < minimumSourceDuration
    || entry.clip.sourceEndMs - sourceSplitMs < minimumSourceDuration
  ) return null;
  const left: VideoClip = {
    ...entry.clip,
    transform: resolveVideoTransform(entry.clip.transform, project.videoTransform),
    id: leftId,
    sourceEndMs: sourceSplitMs,
    gapAfterMs: 0,
    transitionAfter: { type: 'none', durationMs: 0 },
  };
  const right: VideoClip = {
    ...entry.clip,
    transform: resolveVideoTransform(entry.clip.transform, project.videoTransform),
    id: rightId,
    sourceStartMs: sourceSplitMs,
    gapBeforeMs: 0,
  };
  const clips = [...project.clips];
  const index = clips.findIndex((clip) => clip.id === clipId);
  clips.splice(index, 1, left, right);
  const wordById = new Map(project.transcription.words.map((word) => [word.id, word]));
  const splitRatios = new Map<string, { ratio: number; rightCaptionId: string }>();
  const captions = anchorCaptionsToClips(project.captions, project.clips, project.transcription.words).flatMap((caption) => {
    const anchor = caption.sourceAnchor;
    if (anchor?.clipId !== entry.clip.id) return [caption];
    if (anchor.sourceEndMs <= sourceSplitMs) return [retargetCaptionAnchor(caption, entry.clip.id, leftId)];
    if (anchor.sourceStartMs >= sourceSplitMs) return [retargetCaptionAnchor(caption, entry.clip.id, rightId)];
    const leftWordIds = anchor.wordIds
      .filter((wordId) => (wordById.get(wordId)?.startMs ?? timelineMs) < timelineMs)
      .map((wordId) => replaceClipWordPrefix(wordId, entry.clip.id, leftId));
    const rightWordIds = anchor.wordIds
      .filter((wordId) => (wordById.get(wordId)?.endMs ?? timelineMs) > timelineMs)
      .map((wordId) => replaceClipWordPrefix(wordId, entry.clip.id, rightId));
    const [leftText, rightText] = splitCaptionText(caption.text, (
      sourceSplitMs - anchor.sourceStartMs
    ) / Math.max(1, anchor.sourceEndMs - anchor.sourceStartMs));
    const rightCaptionId = `${caption.id}-${rightId}`;
    splitRatios.set(caption.id, {
      ratio: (sourceSplitMs - anchor.sourceStartMs) / Math.max(1, anchor.sourceEndMs - anchor.sourceStartMs),
      rightCaptionId,
    });
    return [
      {
        ...caption,
        text: caption.textMode === 'manual' ? leftText : caption.text,
        wordIds: leftWordIds,
        sourceAnchor: {
          clipId: leftId,
          sourceStartMs: anchor.sourceStartMs,
          sourceEndMs: sourceSplitMs,
          wordIds: leftWordIds,
        },
      },
      {
        ...caption,
        id: rightCaptionId,
        text: caption.textMode === 'manual' ? rightText : caption.text,
        wordIds: rightWordIds,
        sourceAnchor: {
          clipId: rightId,
          sourceStartMs: sourceSplitMs,
          sourceEndMs: anchor.sourceEndMs,
          wordIds: rightWordIds,
        },
      },
    ];
  });
  const layers = reanchorVisualLayersAfterSplit(
    anchorVisualLayers(project.layers, project.clips),
    entry.clip.id,
    leftId,
    rightId,
    sourceSplitMs,
  );
  const rebuilt = rebuildAfterLayoutEdit(
    project,
    clips,
    captions,
    { atMs: entry.endMs, removeMs: 0, insertMs: 0 },
    layers,
  );
  const captionById = new Map(rebuilt.captions.map((caption) => [caption.id, caption]));
  const translations = (project.captionTracks?.translations ?? []).map((track) => ({
    ...track,
    cues: track.cues.flatMap((cue) => {
      const split = splitRatios.get(cue.sourceCaptionId);
      if (!split) return [cue];
      const leftSource = captionById.get(cue.sourceCaptionId);
      const rightSource = captionById.get(split.rightCaptionId);
      if (!leftSource || !rightSource) return [cue];
      const [leftText, rightText] = cue.text.trim()
        ? splitCaptionText(cue.text, split.ratio)
        : ['', ''];
      const splitStatus = cue.text.trim() ? cue.status : 'pending' as const;
      const reviewed = Boolean(cue.text.trim()) && cue.reviewed;
      return [
        {
          ...cue,
          sourceTextSnapshot: leftSource.text,
          text: leftText,
          status: splitStatus,
          reviewed,
        },
        {
          ...cue,
          id: `${track.id}:${split.rightCaptionId}`,
          sourceCaptionId: split.rightCaptionId,
          sourceTextSnapshot: rightSource.text,
          text: rightText,
          status: splitStatus,
          reviewed,
        },
      ];
    }),
  }));
  const next = {
    ...rebuilt,
    captionTracks: synchronizeCaptionTracks({
      ...rebuilt,
      captionTracks: {
        ...(rebuilt.captionTracks ?? { schemaVersion: 1 as const, primaryTrackId: 'captions' as const }),
        translations,
      },
    }, rebuilt.captions),
  };
  return { project: next, rightClipId: right.id };
}

export function trimVideoClip(project: CaptionProject, clipId: string, edge: 'start' | 'end', targetSourceMs: number) {
  const entry = buildClipTimeline(project.clips).find((candidate) => candidate.clip.id === clipId);
  if (!entry || !Number.isFinite(targetSourceMs)) return null;
  const replacement = previewVideoClipTrim(entry.clip, edge, targetSourceMs);
  if (
    Math.abs(replacement.sourceStartMs - entry.clip.sourceStartMs) < 1
    && Math.abs(replacement.sourceEndMs - entry.clip.sourceEndMs) < 1
  ) return null;
  const clips = project.clips.map((clip) => clip.id === clipId ? replacement : clip);
  const next = rebuildAfterLayoutEdit(
    project,
    clips,
    project.captions,
    { atMs: entry.startMs, removeMs: 0, insertMs: 0 },
  );
  const nextEntry = buildClipTimeline(next.clips).find((candidate) => candidate.clip.id === clipId)!;
  return {
    project: next,
    seekMs: edge === 'start' ? nextEntry.startMs : nextEntry.endMs,
  };
}

export function previewVideoClipTrim(clip: VideoClip, edge: 'start' | 'end', targetSourceMs: number) {
  const minimumSourceDuration = MINIMUM_CLIP_TIMELINE_MS * clip.playbackRate;
  if (edge === 'start') {
    const recoverableStartMs = Math.max(
      clip.availableSourceStartMs,
      clip.sourceStartMs - clip.gapBeforeMs * clip.playbackRate,
    );
    const sourceStartMs = clamp(targetSourceMs, recoverableStartMs, clip.sourceEndMs - minimumSourceDuration);
    const gapBeforeMs = Math.max(0, clip.gapBeforeMs + (sourceStartMs - clip.sourceStartMs) / clip.playbackRate);
    return { ...clip, sourceStartMs, gapBeforeMs };
  }
  const recoverableEndMs = Math.min(
    clip.availableSourceEndMs,
    clip.sourceEndMs + clip.gapAfterMs * clip.playbackRate,
  );
  const sourceEndMs = clamp(targetSourceMs, clip.sourceStartMs + minimumSourceDuration, recoverableEndMs);
  const gapAfterMs = Math.max(0, clip.gapAfterMs + (clip.sourceEndMs - sourceEndMs) / clip.playbackRate);
  return { ...clip, sourceEndMs, gapAfterMs };
}

export function setVideoClipGap(
  project: CaptionProject,
  clipId: string,
  requestedGapMs: number,
  edge: 'before' | 'after' = 'before',
) {
  const entry = buildClipTimeline(project.clips).find((candidate) => candidate.clip.id === clipId);
  if (!entry || !Number.isFinite(requestedGapMs)) return null;
  const gapMs = clamp(requestedGapMs, 0, 60 * 60_000);
  const currentGapMs = edge === 'before' ? entry.clip.gapBeforeMs : entry.clip.gapAfterMs;
  const delta = gapMs - currentGapMs;
  if (Math.abs(delta) < 1) return null;
  const clips = project.clips.map((clip) => clip.id === clipId
    ? { ...clip, [edge === 'before' ? 'gapBeforeMs' : 'gapAfterMs']: gapMs }
    : clip);
  const gapStartMs = edge === 'before' ? entry.gapStartMs : entry.endMs;
  const splice = delta > 0
    ? { atMs: gapStartMs, removeMs: 0, insertMs: delta }
    : { atMs: gapStartMs + gapMs, removeMs: -delta, insertMs: 0 };
  const next = rebuildAfterLayoutEdit(project, clips, project.captions, splice);
  const nextEntry = buildClipTimeline(next.clips).find((candidate) => candidate.clip.id === clipId)!;
  return { project: next, seekMs: edge === 'before' ? nextEntry.startMs : nextEntry.endMs };
}

export function previewVideoClipLeadingGap(
  clips: VideoClip[],
  clipId: string,
  requestedGapMs: number,
) {
  const index = clips.findIndex((clip) => clip.id === clipId);
  if (index < 0 || !Number.isFinite(requestedGapMs)) return null;
  const gapMs = clamp(requestedGapMs, 0, 60 * 60_000);
  if (index === 0) {
    return clips.map((clip, clipIndex) => clipIndex === 0 ? { ...clip, gapBeforeMs: gapMs } : clip);
  }
  const previous = clips[index - 1];
  const previousGapAfterMs = Math.min(previous.gapAfterMs, gapMs);
  const gapBeforeMs = gapMs - previousGapAfterMs;
  return clips.map((clip, clipIndex) => {
    if (clipIndex === index - 1) return { ...clip, gapAfterMs: previousGapAfterMs };
    if (clipIndex === index) return { ...clip, gapBeforeMs };
    return clip;
  });
}

export function setVideoClipLeadingGap(
  project: CaptionProject,
  clipId: string,
  requestedGapMs: number,
) {
  const entries = buildClipTimeline(project.clips);
  const index = entries.findIndex((entry) => entry.clip.id === clipId);
  if (index < 0) return null;
  const previousEndMs = index === 0 ? 0 : entries[index - 1].endMs;
  const currentGapMs = entries[index].startMs - previousEndMs;
  const clips = previewVideoClipLeadingGap(project.clips, clipId, requestedGapMs);
  if (!clips) return null;
  const nextEntry = buildClipTimeline(clips)[index];
  const gapMs = nextEntry.startMs - previousEndMs;
  const delta = gapMs - currentGapMs;
  if (Math.abs(delta) < 1) return null;
  const splice = delta > 0
    ? { atMs: previousEndMs, removeMs: 0, insertMs: delta }
    : { atMs: previousEndMs + gapMs, removeMs: -delta, insertMs: 0 };
  const next = rebuildAfterLayoutEdit(project, clips, project.captions, splice);
  return { project: next, seekMs: buildClipTimeline(next.clips)[index].startMs };
}

export function setCanvasPreset(project: CaptionProject, preset: CaptionProject['canvas']['preset']) {
  const size = canvasPresetSize(preset, project);
  return updateProject(project, {
    canvas: { ...project.canvas, preset, aspectWidth: size.width, aspectHeight: size.height },
  });
}

function canvasPresetSize(preset: CaptionProject['canvas']['preset'], project: CaptionProject) {
  if (preset === '9:16') return { width: 9, height: 16 };
  if (preset === '16:9') return { width: 16, height: 9 };
  if (preset === '1:1') return { width: 1, height: 1 };
  if (preset === '4:5') return { width: 4, height: 5 };
  const source = project.sources[0];
  const width = Math.max(1, source?.width ?? 9);
  const height = Math.max(1, source?.height ?? 16);
  return Math.abs(source?.rotation ?? 0) % 180 === 90 ? { width: height, height: width } : { width, height };
}

function updateProject<T extends Partial<CaptionProject>>(project: CaptionProject, update: T) {
  const next = { ...project, ...update, updatedAt: new Date().toISOString() } as CaptionProject;
  if (!Object.prototype.hasOwnProperty.call(update, 'captions')) return next;
  return { ...next, captionTracks: synchronizeCaptionTracks(next, next.captions) };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function rebuildAfterLayoutEdit(
  project: CaptionProject,
  clips: VideoClip[],
  sourceCaptions: CaptionProject['captions'],
  splice: { atMs: number; removeMs: number; insertMs: number },
  sourceLayers: CaptionProject['layers'] = project.layers,
) {
  clips = normalizeVideoTransitionBoundaries(clips);
  const sourceWords = Object.fromEntries(
    Object.entries(project.transcription.sourceResults).map(([sourceId, result]) => [sourceId, result.words]),
  );
  const hasCanonicalWords = Object.keys(sourceWords).length > 0;
  const currentWords = hasCanonicalWords
    ? mapSourceWordsToTimeline(project.clips, sourceWords)
    : project.transcription.words;
  const anchoredCaptions = anchorCaptionsToClips(sourceCaptions, project.clips, currentWords);
  const words = hasCanonicalWords
    ? mapSourceWordsToTimeline(clips, sourceWords)
    : spliceTimedRanges(project.transcription.words, splice);
  const unanchored = anchoredCaptions
    .filter((caption) => !caption.sourceAnchor)
    .map((caption) => spliceTimedRange(caption, splice))
    .filter((caption): caption is NonNullable<typeof caption> => Boolean(caption));
  const remapped = remapCaptionsToTimeline(
    anchoredCaptions.filter((caption) => Boolean(caption.sourceAnchor)),
    clips,
    words,
  );
  const layers = remapVisualLayers(anchorVisualLayers(sourceLayers, project.clips), clips, splice);
  return updateProject(project, {
    clips,
    transcription: { ...project.transcription, words },
    captions: [...remapped, ...unanchored].sort((left, right) => left.startMs - right.startMs),
    layers,
    audioClips: constrainAudioClips(project.audioClips, totalClipDuration(clips)),
  });
}

function spliceTimedRanges<T extends { startMs: number; endMs: number }>(
  ranges: T[],
  splice: { atMs: number; removeMs: number; insertMs: number },
) {
  return ranges.map((range) => spliceTimedRange(range, splice)).filter((range): range is T => Boolean(range));
}

function spliceTimedRange<T extends { startMs: number; endMs: number }>(
  range: T,
  splice: { atMs: number; removeMs: number; insertMs: number },
): T | undefined {
  let startMs = range.startMs;
  let endMs = range.endMs;
  if (splice.removeMs > 0) {
    const cutEnd = splice.atMs + splice.removeMs;
    if (endMs <= splice.atMs) return range;
    if (startMs >= cutEnd) {
      startMs -= splice.removeMs;
      endMs -= splice.removeMs;
    } else if (startMs < splice.atMs && endMs > cutEnd) {
      endMs -= splice.removeMs;
    } else if (startMs < splice.atMs) {
      endMs = splice.atMs;
    } else if (endMs > cutEnd) {
      startMs = splice.atMs;
      endMs -= splice.removeMs;
    } else {
      return undefined;
    }
  }
  if (splice.insertMs > 0) {
    if (startMs >= splice.atMs) {
      startMs += splice.insertMs;
      endMs += splice.insertMs;
    } else if (endMs > splice.atMs) {
      endMs += splice.insertMs;
    }
  }
  return endMs - startMs >= 80 ? { ...range, startMs, endMs } : undefined;
}

function replaceClipWordPrefix(wordId: string, previousClipId: string, nextClipId: string) {
  const prefix = `${previousClipId}-`;
  return wordId.startsWith(prefix) ? `${nextClipId}-${wordId.slice(prefix.length)}` : wordId;
}

function retargetCaptionAnchor(
  caption: CaptionProject['captions'][number],
  previousClipId: string,
  nextClipId: string,
) {
  const sourceAnchor = caption.sourceAnchor!;
  const wordIds = sourceAnchor.wordIds.map((wordId) => replaceClipWordPrefix(wordId, previousClipId, nextClipId));
  return {
    ...caption,
    wordIds,
    sourceAnchor: { ...sourceAnchor, clipId: nextClipId, wordIds },
  };
}

function splitCaptionText(text: string, leftRatio: number) {
  const tokens = captionSpokenTokenSpans(text);
  if (tokens.length < 2) return [text, text] as const;
  const leftCount = clamp(Math.round(tokens.length * clamp(leftRatio, 0, 1)), 1, tokens.length - 1);
  const boundary = tokens[leftCount - 1].end;
  return [text.slice(0, boundary).trim(), text.slice(boundary).trim()] as const;
}

function anchorVisualLayers(layers: CaptionProject['layers'], clips: VideoClip[]) {
  const entries = buildClipTimeline(clips);
  return layers.map((layer) => layer.kind === 'captions' || layer.sourceAnchors?.length
    ? layer
    : attachLayerToTimeline(layer, entries));
}

function attachLayerToTimeline<T extends TextVisualLayer | ImageVisualLayer>(
  layer: T,
  entries: ReturnType<typeof buildClipTimeline>,
  replaceExisting = false,
): T {
  if (layer.sourceAnchors?.length && !replaceExisting) return layer;
  const sourceAnchors = entries
    .filter((entry) => layer.startMs < entry.endMs && layer.endMs > entry.startMs)
    .map((entry) => ({
      clipId: entry.clip.id,
      sourceStartMs: sourceTimeAt(entry, Math.max(layer.startMs, entry.startMs)),
      sourceEndMs: sourceTimeAt(entry, Math.min(layer.endMs, entry.endMs)),
    }));
  return {
    ...layer,
    sourceAnchors: sourceAnchors.length > 0 ? sourceAnchors : undefined,
    timelineVisible: true,
  };
}

function reanchorVisualLayersAfterSplit(
  layers: CaptionProject['layers'],
  previousClipId: string,
  leftClipId: string,
  rightClipId: string,
  sourceSplitMs: number,
) {
  return layers.map((layer) => {
    if (layer.kind === 'captions' || !layer.sourceAnchors?.length) return layer;
    const sourceAnchors = layer.sourceAnchors.flatMap((anchor) => {
      if (anchor.clipId !== previousClipId) return [anchor];
      if (anchor.sourceEndMs <= sourceSplitMs) return [{ ...anchor, clipId: leftClipId }];
      if (anchor.sourceStartMs >= sourceSplitMs) return [{ ...anchor, clipId: rightClipId }];
      return [
        { ...anchor, clipId: leftClipId, sourceEndMs: sourceSplitMs },
        { ...anchor, clipId: rightClipId, sourceStartMs: sourceSplitMs },
      ];
    });
    return { ...layer, sourceAnchors };
  });
}

function remapVisualLayers(
  layers: CaptionProject['layers'],
  clips: VideoClip[],
  splice: { atMs: number; removeMs: number; insertMs: number },
) {
  const entryByClipId = new Map(buildClipTimeline(clips).map((entry) => [entry.clip.id, entry]));
  return layers.map((layer) => {
    if (layer.kind === 'captions') return layer;
    if (!layer.sourceAnchors?.length) return spliceTimedRange(layer, splice);
    const visibleRanges = layer.sourceAnchors.flatMap((anchor) => {
      const entry = entryByClipId.get(anchor.clipId);
      if (!entry) return [];
      const sourceStartMs = Math.max(anchor.sourceStartMs, entry.clip.sourceStartMs);
      const sourceEndMs = Math.min(anchor.sourceEndMs, entry.clip.sourceEndMs);
      if (sourceEndMs <= sourceStartMs) return [];
      return [{
        startMs: timelineTimeAt(entry, sourceStartMs),
        endMs: timelineTimeAt(entry, sourceEndMs),
      }];
    });
    if (visibleRanges.length === 0) return { ...layer, timelineVisible: false };
    return {
      ...layer,
      startMs: Math.min(...visibleRanges.map((range) => range.startMs)),
      endMs: Math.max(...visibleRanges.map((range) => range.endMs)),
      timelineVisible: true,
    };
  }).filter((layer): layer is CaptionProject['layers'][number] => Boolean(layer));
}
