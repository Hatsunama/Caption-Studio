import { synchronizeCaptionTracks } from '@/lib/caption-tracks';
import { decodeVersionTwoProject } from '@/lib/project-schema';
import { hydrateProjectTranscription } from '@/lib/transcription-hydration';
import { recoverPersistedDuplicateSourceWordIds } from '@/lib/transcription-recovery';
import { MINIMUM_CLIP_TIMELINE_MS } from '@/lib/video-timeline';
import { hydrateVideoTransitionBoundaries } from '@/lib/video-transitions';
import {
  DEFAULT_CAPTION_STYLE,
  type AudioClip,
  type CaptionProject,
  type ProjectAudioSource,
  type ProjectVideoSource,
  type VideoClip,
} from '@/types/project';

export function decodePersistedProject(value: string): CaptionProject {
  return hydrateProject(parseProject(value));
}

function parseProject(value: string): CaptionProject {
  if (value.length > 64 * 1024 * 1024) throw new Error('Project data exceeds the supported size limit');
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object') throw new Error('Project data is not an object');
  const candidate = parsed as Record<string, unknown>;
  if (candidate.schemaVersion === 1) {
    return decodeVersionTwoProject(recoverPersistedDuplicateSourceWordIds(migrateVersionOne(candidate)));
  }
  if (candidate.schemaVersion !== 2) throw new Error('Project data uses an unsupported version');
  return decodeVersionTwoProject(recoverPersistedDuplicateSourceWordIds(candidate));
}

function hydrateProject(project: CaptionProject): CaptionProject {
  const sources = project.sources.map((source) => ({
    ...source,
    storageMode: source.storageMode ?? (source.uri.startsWith('content:') ? 'linked' : 'copied'),
    width: Math.max(1, source.width ?? 1),
    height: Math.max(1, source.height ?? 1),
    rotation: source.rotation ?? 0,
  }));
  const hydratedProjectStyle = {
    ...DEFAULT_CAPTION_STYLE,
    ...project.projectStyle,
    position: { ...DEFAULT_CAPTION_STYLE.position, ...project.projectStyle?.position },
    box: { ...DEFAULT_CAPTION_STYLE.box, ...project.projectStyle?.box },
  };
  const clips = hydrateClips(project.clips, sources);
  const { audioSources, audioClips } = hydrateAudio(project.audioSources ?? [], project.audioClips ?? []);
  const { transcription, captions } = hydrateProjectTranscription(project, clips);
  return {
    ...project,
    schemaVersion: 2,
    lifecycle: project.lifecycle ?? { status: 'saved' },
    sources,
    transcription,
    captions,
    captionTracks: synchronizeCaptionTracks(project, captions),
    projectStyle: hydratedProjectStyle,
    layers: (project.layers ?? [{ id: 'captions', kind: 'captions', name: 'Captions', visible: true }]).map((layer) =>
      layer.kind === 'text'
        ? {
            ...layer,
            timelineVisible: layer.timelineVisible ?? true,
            style: {
              ...DEFAULT_CAPTION_STYLE,
              ...layer.style,
              position: { ...DEFAULT_CAPTION_STYLE.position, ...layer.style?.position },
              box: { ...DEFAULT_CAPTION_STYLE.box, ...layer.style?.box },
            },
          }
        : layer.kind === 'image'
          ? { ...layer, scale: layer.scale ?? 1, scaleX: layer.scaleX ?? 1, scaleY: layer.scaleY ?? 1, timelineVisible: layer.timelineVisible ?? true }
          : layer,
    ),
    clips,
    audioSources,
    audioClips,
    canvas: project.canvas ?? {
      preset: 'source',
      aspectWidth: project.sources[0]?.width ?? 9,
      aspectHeight: project.sources[0]?.height ?? 16,
      backgroundColor: '#000000',
    },
    videoTransform: project.videoTransform ?? {
      fit: 'fit',
      position: { x: 0.5, y: 0.5 },
      scale: 1,
      rotation: 0,
    },
    backgroundReplacement: hydrateBackgroundReplacement(project.backgroundReplacement),
  };
}

function hydrateBackgroundReplacement(value: CaptionProject['backgroundReplacement'] | undefined): CaptionProject['backgroundReplacement'] {
  return {
    enabled: false,
    source: value?.source,
    mask: { qualityPreset: 'stable', threshold: 0.46, softness: 0.14, temporalStability: 0.78, edgeFeather: 0.45 },
    personTransform: { position: { x: 0.5, y: 0.5 }, scale: 1, rotation: 0 },
    keyframes: [],
  };
}

function hydrateClips(clips: VideoClip[], sources: ProjectVideoSource[]): VideoClip[] {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const ids = new Set<string>();
  const normalized = clips.map((clip) => {
    if (!clip?.id || ids.has(clip.id)) throw new Error('Project video clips have duplicate or missing identifiers');
    ids.add(clip.id);
    const source = sourceById.get(clip.sourceId);
    if (!source) throw new Error('A project video clip has lost its source');
    const sourceStartMs = finiteNumber(clip.sourceStartMs, 'clip source start');
    const sourceEndMs = finiteNumber(clip.sourceEndMs, 'clip source end');
    const playbackRate = clip.playbackRate ?? 1;
    if (!Number.isFinite(playbackRate) || playbackRate < 0.25 || playbackRate > 4) {
      throw new Error('A project video clip has an invalid playback rate');
    }
    if (
      sourceStartMs < 0
      || sourceEndMs > source.durationMs + 1
      || (sourceEndMs - sourceStartMs) / playbackRate < MINIMUM_CLIP_TIMELINE_MS
    ) {
      throw new Error('A project video clip has invalid source bounds');
    }
    const gapBeforeMs = clip.gapBeforeMs ?? 0;
    if (!Number.isFinite(gapBeforeMs) || gapBeforeMs < 0) throw new Error('A project video gap is invalid');
    const gapAfterMs = clip.gapAfterMs ?? 0;
    if (!Number.isFinite(gapAfterMs) || gapAfterMs < 0) throw new Error('A project video gap is invalid');
    return {
      ...clip,
      sourceStartMs,
      sourceEndMs,
      gapBeforeMs,
      gapAfterMs,
      playbackRate,
      volume: clip.volume ?? 1,
      muted: clip.muted ?? false,
      fadeInMs: clip.fadeInMs ?? 0,
      fadeOutMs: clip.fadeOutMs ?? 0,
      transitionAfter: clip.transitionAfter,
    };
  });

  const clipsWithHandles = normalized.map((clip, index) => {
    const source = sourceById.get(clip.sourceId)!;
    const previous = normalized[index - 1];
    const next = normalized[index + 1];
    const inferredStart = previous?.sourceId === clip.sourceId
      ? (previous.sourceEndMs + clip.sourceStartMs) / 2
      : 0;
    const inferredEnd = next?.sourceId === clip.sourceId
      ? (clip.sourceEndMs + next.sourceStartMs) / 2
      : source.durationMs;
    const availableSourceStartMs = clip.availableSourceStartMs ?? inferredStart;
    const availableSourceEndMs = clip.availableSourceEndMs ?? inferredEnd;
    if (
      !Number.isFinite(availableSourceStartMs)
      || !Number.isFinite(availableSourceEndMs)
      || availableSourceStartMs < 0
      || availableSourceStartMs > clip.sourceStartMs
      || availableSourceEndMs < clip.sourceEndMs
      || availableSourceEndMs > source.durationMs + 1
    ) throw new Error('A project video clip has invalid recoverable handles');
    return { ...clip, availableSourceStartMs, availableSourceEndMs };
  });
  return hydrateVideoTransitionBoundaries(clipsWithHandles);
}

function hydrateAudio(audioSources: ProjectAudioSource[], audioClips: AudioClip[]) {
  const sourceIds = new Set<string>();
  const normalizedSources = audioSources.map((source) => {
    if (!source?.id || sourceIds.has(source.id) || !source.uri || !source.displayName) {
      throw new Error('Project audio sources have duplicate or missing identifiers');
    }
    sourceIds.add(source.id);
    const durationMs = finiteNumber(source.durationMs, 'audio source duration');
    if (durationMs < 80) throw new Error('A project audio source is too short');
    return {
      ...source,
      durationMs,
      storageMode: 'copied' as const,
      origin: source.origin ?? 'audio-file' as const,
    };
  });
  const sourceById = new Map(normalizedSources.map((source) => [source.id, source]));
  const clipIds = new Set<string>();
  const normalizedClips = audioClips.map((clip) => {
    if (!clip?.id || clipIds.has(clip.id)) throw new Error('Project audio clips have duplicate or missing identifiers');
    clipIds.add(clip.id);
    const source = sourceById.get(clip.sourceId);
    if (!source) throw new Error('A project audio clip has lost its source');
    const startMs = finiteNumber(clip.startMs, 'audio timeline start');
    const sourceStartMs = finiteNumber(clip.sourceStartMs, 'audio source start');
    const sourceEndMs = finiteNumber(clip.sourceEndMs, 'audio source end');
    if (startMs < 0 || sourceStartMs < 0 || sourceEndMs > source.durationMs + 1 || sourceEndMs - sourceStartMs < 80) {
      throw new Error('A project audio clip has invalid bounds');
    }
    return {
      ...clip,
      anchor: 'timeline' as const,
      startMs,
      sourceStartMs,
      sourceEndMs,
      volume: clampNumber(clip.volume ?? 1, 0, 1),
      muted: clip.muted ?? false,
      fadeInMs: clampNumber(clip.fadeInMs ?? 0, 0, sourceEndMs - sourceStartMs),
      fadeOutMs: clampNumber(clip.fadeOutMs ?? 0, 0, sourceEndMs - sourceStartMs),
    };
  });
  return { audioSources: normalizedSources, audioClips: normalizedClips };
}

function finiteNumber(value: number, label: string) {
  if (!Number.isFinite(value)) throw new Error(`Project ${label} is invalid`);
  return value;
}

function clampNumber(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function migrateVersionOne(candidate: Record<string, unknown>): Record<string, unknown> {
  const legacy = candidate as {
    id?: unknown;
    name?: unknown;
    source?: Partial<ProjectVideoSource>;
    clips?: Partial<VideoClip>[];
    transcription?: CaptionProject['transcription'];
  } & Record<string, unknown>;
  if (
    typeof legacy.id !== 'string'
    || typeof legacy.name !== 'string'
    || typeof legacy.source?.uri !== 'string'
    || typeof legacy.source.durationMs !== 'number'
    || !legacy.transcription
  ) throw new Error('Legacy project data is incomplete');
  const sourceId = 'source-1';
  const source: ProjectVideoSource = {
    id: sourceId,
    uri: legacy.source.uri,
    storageMode: legacy.source.storageMode ?? (legacy.source.uri.startsWith('content:') ? 'linked' : 'copied'),
    sizeBytes: legacy.source.sizeBytes,
    mimeType: legacy.source.mimeType,
    thumbnailUri: legacy.source.thumbnailUri,
    displayName: legacy.source.displayName ?? legacy.name,
    durationMs: legacy.source.durationMs,
    width: Math.max(1, legacy.source.width ?? 1),
    height: Math.max(1, legacy.source.height ?? 1),
    rotation: legacy.source.rotation ?? 0,
  };
  const migrated: Record<string, unknown> = {
    ...candidate,
    schemaVersion: 2,
    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date().toISOString(),
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : new Date().toISOString(),
    lifecycle: { status: 'saved' },
    sources: [source],
    clips: (legacy.clips?.length ? legacy.clips : [{ id: 'source-clip', sourceStartMs: 0, sourceEndMs: source.durationMs }])
      .map((clip) => ({ ...clip, id: String(clip.id), sourceId } as VideoClip)),
    transcription: { ...legacy.transcription, sourceResults: legacy.transcription.sourceResults ?? {} },
  };
  delete migrated.source;
  delete migrated.videoEdits;
  return migrated;
}
