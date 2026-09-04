import { resolveCaptionStyle } from '@/lib/style-resolver';
import { exportCaptionPairs } from '@/lib/export-caption-pairs';
import { buildClipTimeline, totalClipDuration } from '@/lib/video-timeline';
import { effectiveVideoTransition } from '@/lib/video-transitions';
import { resolveVideoTransform } from '@/lib/video-transform';
import { selectExportFrameRate } from '@/lib/video-source-metadata';
import type { CaptionProject, CaptionStyle, VideoTransform } from '@/types/project';

export type ResolvedFontUris = ReadonlyMap<string, string>;

export type TimelineRenderPlan = {
  version: 1;
  durationMs: number;
  width: number;
  height: number;
  frameRate: number;
  backgroundColor: string;
  burnCaptions: boolean;
  videoTransform: CaptionProject['videoTransform'];
  clips: {
    id: string;
    uri: string;
    timelineStartMs: number;
    timelineEndMs: number;
    availableSourceStartMs: number;
    availableSourceEndMs: number;
    sourceStartMs: number;
    sourceEndMs: number;
    playbackRate: number;
    volume: number;
    muted: boolean;
    fadeInMs: number;
    fadeOutMs: number;
    transform: VideoTransform;
    transition: { type: string; durationMs: number };
  }[];
  backgroundReplacement?: {
    kind: 'image' | 'video';
    uri: string;
    qualityPreset: 'stable' | 'balanced' | 'detailed' | 'custom';
    threshold: number;
    softness: number;
    temporalStability: number;
    edgeFeather: number;
    personTransform: CaptionProject['backgroundReplacement']['personTransform'];
    keyframes: CaptionProject['backgroundReplacement']['keyframes'];
  };
  captions: {
    id: string;
    text: string;
    startMs: number;
    endMs: number;
    style: RenderStyle;
    words: { text: string; startMs: number; endMs: number; style: RenderStyle }[];
  }[];
  layers: (
    | { id: string; kind: 'captions'; visible: boolean }
    | { id: string; kind: 'text'; visible: boolean; text: string; startMs: number; endMs: number; style: RenderStyle }
    | {
      id: string;
      kind: 'image';
      visible: boolean;
      uri: string;
      startMs: number;
      endMs: number;
      position: { x: number; y: number };
      box: { width: number; height: number };
      rotation: number;
      opacity: number;
    }
  )[];
  audioClips: {
    id: string;
    uri: string;
    startMs: number;
    sourceStartMs: number;
    sourceEndMs: number;
    volume: number;
    muted: boolean;
    fadeInMs: number;
    fadeOutMs: number;
  }[];
};

export type RenderStyle = Omit<CaptionStyle, 'font'> & {
  font: CaptionStyle['font'] & { uri?: string };
};

export function buildTimelineRenderPlan(
  project: CaptionProject,
  resolvedFontUris: ResolvedFontUris = new Map(),
): TimelineRenderPlan {
  const durationMs = totalClipDuration(project.clips);
  if (durationMs <= 0) throw new Error('Add at least one visible video clip before exporting.');
  const captionsEnabled = project.export.burnCaptions && project.layers.some((layer) => layer.kind === 'captions' && layer.visible);
  const activeSources = activeProjectVideoSources(project);
  const { width, height } = outputDimensions(project, activeSources);
  const frameRate = selectExportFrameRate(activeSources);
  const sourceById = new Map(project.sources.map((source) => [source.id, source]));
  const entries = buildClipTimeline(project.clips);
  const compatibilityVideoTransform = resolveVideoTransform(
    entries[0]?.clip.transform,
    project.videoTransform,
  );
  const styleCache = new Map<string, RenderStyle>();
  const renderStyle = (style: CaptionStyle) => {
    const key = JSON.stringify(style);
    const cached = styleCache.get(key);
    if (cached) return cached;
    const value = serializeStyle(style, resolvedFontUris);
    styleCache.set(key, value);
    return value;
  };

  const wordsById = new Map(project.transcription.words.map((word) => [word.id, word]));
  const captions: TimelineRenderPlan['captions'] = [];
  for (const caption of captionsEnabled ? project.captions : []) {
    if (caption.timelineVisible === false || !caption.text.trim()) continue;
    const interval = boundedInterval(caption.startMs, caption.endMs, durationMs);
    if (!interval) continue;
    captions.push({
      id: caption.id,
      text: caption.text,
      ...interval,
      style: renderStyle(resolveCaptionStyle(project.projectStyle, caption)),
      words: caption.wordIds.flatMap((wordId) => {
        const word = wordsById.get(wordId);
        if (!word) return [];
        const wordInterval = boundedInterval(
          Math.max(word.startMs, interval.startMs),
          Math.min(word.endMs, interval.endMs),
          durationMs,
        );
        if (!wordInterval) return [];
        return [{
          text: word.text,
          ...wordInterval,
          style: renderStyle(resolveCaptionStyle(project.projectStyle, caption, word)),
        }];
      }),
    });
  }

  for (const pair of captionsEnabled ? exportCaptionPairs(project) : []) {
    const interval = boundedInterval(pair.startMs, pair.endMs, durationMs);
    if (!interval) continue;
    captions.push({ id: pair.translation.id, text: pair.translation.text, ...interval,
      style: renderStyle(pair.style), words: [] });
  }

  const layers: TimelineRenderPlan['layers'] = [];
  for (const layer of project.layers) {
    if (layer.kind !== 'captions' && layer.timelineVisible === false) continue;
    if (layer.kind === 'captions') {
      layers.push({ id: layer.id, kind: layer.kind, visible: layer.visible });
      continue;
    }
    const interval = boundedInterval(layer.startMs, layer.endMs, durationMs);
    if (!interval) continue;
    if (layer.kind === 'text') {
      if (!layer.text.trim()) continue;
      layers.push({
        id: layer.id,
        kind: layer.kind,
        visible: layer.visible,
        text: layer.text,
        ...interval,
        style: renderStyle(layer.style),
      });
      continue;
    }
    layers.push({
      id: layer.id,
      kind: layer.kind,
      visible: layer.visible,
      uri: layer.uri,
      ...interval,
      position: { ...layer.position },
      box: { ...layer.box },
      rotation: layer.rotation,
      opacity: layer.opacity,
    });
  }

  const plan: TimelineRenderPlan = {
    version: 1,
    durationMs,
    width,
    height,
    frameRate,
    backgroundColor: project.canvas.backgroundColor,
    burnCaptions: project.export.burnCaptions,
    videoTransform: compatibilityVideoTransform,
    clips: entries.map((entry, index) => {
      const source = sourceById.get(entry.clip.sourceId);
      if (!source) throw new Error(`A video source used by clip ${entry.clip.id} is unavailable.`);
      return {
        id: entry.clip.id,
        uri: source.uri,
        timelineStartMs: entry.startMs,
        timelineEndMs: entry.endMs,
        availableSourceStartMs: entry.clip.availableSourceStartMs,
        availableSourceEndMs: entry.clip.availableSourceEndMs,
        sourceStartMs: entry.clip.sourceStartMs,
        sourceEndMs: entry.clip.sourceEndMs,
        playbackRate: entry.clip.playbackRate,
        volume: entry.clip.volume,
        muted: entry.clip.muted,
        fadeInMs: entry.clip.fadeInMs,
        fadeOutMs: entry.clip.fadeOutMs,
        transform: resolveVideoTransform(entry.clip.transform, project.videoTransform),
        transition: { ...effectiveVideoTransition(entry.clip, entries[index + 1]?.clip) },
      };
    }),
    captions,
    layers,
    audioClips: project.audioClips.map((clip) => {
      const source = project.audioSources.find((candidate) => candidate.id === clip.sourceId);
      if (!source) throw new Error(`An audio source used by clip ${clip.id} is unavailable.`);
      return {
        id: clip.id,
        uri: source.uri,
        startMs: clip.startMs,
        sourceStartMs: clip.sourceStartMs,
        sourceEndMs: clip.sourceEndMs,
        volume: clip.volume,
        muted: clip.muted,
        fadeInMs: clip.fadeInMs,
        fadeOutMs: clip.fadeOutMs,
      };
    }),
    ...(project.backgroundReplacement.enabled && project.backgroundReplacement.source
      ? {
        backgroundReplacement: {
          kind: project.backgroundReplacement.source.kind,
          uri: project.backgroundReplacement.source.uri,
          qualityPreset: project.backgroundReplacement.mask.qualityPreset,
          threshold: project.backgroundReplacement.mask.threshold,
          softness: project.backgroundReplacement.mask.softness,
          temporalStability: project.backgroundReplacement.mask.temporalStability,
          edgeFeather: project.backgroundReplacement.mask.edgeFeather,
          personTransform: {
            ...project.backgroundReplacement.personTransform,
            position: { ...project.backgroundReplacement.personTransform.position },
          },
          keyframes: project.backgroundReplacement.keyframes.map((keyframe) => ({
            ...keyframe,
            position: { ...keyframe.position },
          })),
        },
      }
      : {}),
  };
  return omitUndefinedDeep(plan);
}

export function collectUnresolvedFontFamilies(plan: TimelineRenderPlan) {
  const families = new Set<string>();
  const add = (style: RenderStyle) => {
    if (style.font.source === 'built-in' && !style.font.uri) families.add(style.font.family);
  };
  plan.captions.forEach((caption) => {
    add(caption.style);
    caption.words.forEach((word) => add(word.style));
  });
  plan.layers.forEach((layer) => {
    if (layer.kind === 'text') add(layer.style);
  });
  return [...families];
}

function serializeStyle(style: CaptionStyle, resolvedFontUris: ResolvedFontUris): RenderStyle {
  const resolvedUri = style.font.uri
    ?? (style.font.source === 'built-in' ? resolvedFontUris.get(style.font.family) : undefined);
  return {
    font: {
      id: style.font.id,
      family: style.font.family,
      source: style.font.source,
      ...(style.font.postScriptName ? { postScriptName: style.font.postScriptName } : {}),
      ...(resolvedUri ? { uri: resolvedUri } : {}),
    },
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    italic: style.italic,
    textColor: style.textColor,
    secondaryTextColor: style.secondaryTextColor,
    textTreatment: style.textTreatment,
    activeWordColor: style.activeWordColor,
    stroke: { ...style.stroke },
    shadow: { ...style.shadow },
    background: { ...style.background },
    alignment: style.alignment,
    letterSpacing: style.letterSpacing,
    lineHeight: style.lineHeight,
    textTransform: style.textTransform,
    position: { ...style.position },
    box: { ...style.box },
    rotation: style.rotation,
    maxLines: style.maxLines,
    animation: { ...style.animation },
  };
}

/** Expo cannot convert JS `undefined` into Kotlin Map<String, Any>. Omit those keys. */
export function omitUndefinedDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => omitUndefinedDeep(item)) as T;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === undefined) continue;
    next[key] = omitUndefinedDeep(child);
  }
  return next as T;
}

export function toNativeRenderPlan(plan: TimelineRenderPlan): Record<string, unknown> {
  return omitUndefinedDeep(plan) as Record<string, unknown>;
}

function activeProjectVideoSources(project: CaptionProject) {
  const activeSourceIds = new Set(project.clips.map((clip) => clip.sourceId));
  return project.sources.filter((source) => activeSourceIds.has(source.id));
}

function outputDimensions(project: CaptionProject, activeSources: CaptionProject['sources']) {
  const aspect = project.canvas.aspectWidth / project.canvas.aspectHeight;
  let shortEdge = project.export.resolution === '720p' ? 720 : 1080;
  if (project.export.resolution === 'original' && activeSources.length > 0) {
    shortEdge = Math.max(...activeSources.map((source) => {
      const sourceWidth = source.rotation % 180 === 0 ? source.width : source.height;
      const sourceHeight = source.rotation % 180 === 0 ? source.height : source.width;
      return Math.min(sourceWidth, sourceHeight);
    }));
  }
  const width = aspect >= 1 ? shortEdge / Math.min(1, 1 / aspect) : shortEdge;
  const height = aspect >= 1 ? shortEdge : shortEdge / aspect;
  return { width: even(width), height: even(height) };
}

function even(value: number) {
  const bounded = Math.max(2, Math.min(3840, Math.round(value)));
  return bounded % 2 === 0 ? bounded : bounded - 1;
}

function boundedInterval(startMs: number, endMs: number, durationMs: number) {
  const start = Math.max(0, Math.round(startMs));
  const end = Math.min(durationMs, Math.round(endMs));
  return end > start ? { startMs: start, endMs: end } : undefined;
}
