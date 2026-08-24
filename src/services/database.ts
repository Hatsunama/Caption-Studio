import * as SQLite from 'expo-sqlite';

import {
  anchorCaptionsToClips,
  mapSourceWordsToTimeline,
  MINIMUM_CLIP_TIMELINE_MS,
  recoverCanonicalSourceWords,
} from '@/lib/video-timeline';
import { normalizedPersonKeyframes } from '@/lib/person-motion';
import { PERSON_MATTE_PRESETS } from '@/lib/person-matte-presets';
import {
  DEFAULT_CAPTION_STYLE,
  type AudioClip,
  type CaptionProject,
  type ProjectAudioSource,
  type ProjectVideoSource,
  type VideoClip,
} from '@/types/project';

let databasePromise: Promise<SQLite.SQLiteDatabase> | undefined;
const projectWriteQueues = new Map<string, Promise<void>>();
const deletedProjectIds = new Set<string>();

export async function getDatabase() {
  databasePromise ??= SQLite.openDatabaseAsync('caption-studio.db');
  const database = await databasePromise;
  await database.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      source_uri TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      project_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS projects_updated_at
      ON projects(updated_at DESC);
    CREATE TABLE IF NOT EXISTS imported_fonts (
      id TEXT PRIMARY KEY NOT NULL,
      font_json TEXT NOT NULL,
      imported_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS preferences (
      key TEXT PRIMARY KEY NOT NULL,
      value_json TEXT NOT NULL
    );
  `);
  return database;
}

export async function saveProject(project: CaptionProject) {
  if (deletedProjectIds.has(project.id)) throw new Error('This project has been deleted.');
  const snapshot = JSON.stringify(project);
  const previous = projectWriteQueues.get(project.id) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    const database = await getDatabase();
    await database.runAsync(
      `INSERT INTO projects (id, name, source_uri, updated_at, project_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         source_uri = excluded.source_uri,
         updated_at = excluded.updated_at,
         project_json = excluded.project_json`,
      project.id,
      project.name,
      project.sources[0]?.uri ?? '',
      project.updatedAt,
      snapshot,
    );
  });
  projectWriteQueues.set(project.id, operation);
  try {
    await operation;
  } finally {
    if (projectWriteQueues.get(project.id) === operation) projectWriteQueues.delete(project.id);
  }
}

export async function deleteProjectRecord(projectId: string) {
  deletedProjectIds.add(projectId);
  await projectWriteQueues.get(projectId)?.catch(() => undefined);
  try {
    const database = await getDatabase();
    await database.runAsync('DELETE FROM projects WHERE id = ?', projectId);
  } catch (error) {
    deletedProjectIds.delete(projectId);
    throw error;
  }
}

export async function listProjects(): Promise<CaptionProject[]> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<{ project_json: string }>(
    'SELECT project_json FROM projects ORDER BY updated_at DESC',
  );
  const projects: CaptionProject[] = [];
  for (const row of rows) {
    try {
      projects.push(hydrateProject(parseProject(row.project_json)));
    } catch (error) {
      console.error('Skipped an unreadable Caption Studio project', error);
    }
  }
  return projects;
}

export async function getProject(projectId: string): Promise<CaptionProject | null> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ project_json: string }>(
    'SELECT project_json FROM projects WHERE id = ?',
    projectId,
  );
  if (!row) return null;
  return hydrateProject(parseProject(row.project_json));
}

function parseProject(value: string): CaptionProject {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object') throw new Error('Project data is not an object');
  const candidate = parsed as Record<string, unknown>;
  if (candidate.schemaVersion === 1) return migrateVersionOne(candidate);
  if (candidate.schemaVersion !== 2) throw new Error('Project data uses an unsupported version');
  if (
    typeof candidate.id !== 'string'
    || typeof candidate.name !== 'string'
    || !Array.isArray(candidate.sources)
    || candidate.sources.length === 0
    || !Array.isArray(candidate.clips)
    || !Array.isArray(candidate.captions)
    || !candidate.transcription
  ) throw new Error('Project data is incomplete');
  return candidate as unknown as CaptionProject;
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
  const persistedSourceResults = project.transcription.sourceResults ?? {};
  const recoveredFromTimeline = Object.keys(persistedSourceResults).length === 0;
  const recoveredSourceResults = !recoveredFromTimeline
    ? persistedSourceResults
    : recoverCanonicalSourceResults(project, clips);
  const wordsForAnchoring = Object.keys(recoveredSourceResults).length > 0
    ? mapSourceWordsToTimeline(
        clips,
        Object.fromEntries(Object.entries(recoveredSourceResults).map(([sourceId, result]) => [sourceId, result.words])),
      )
    : project.transcription.words;
  const transcription = {
    ...project.transcription,
    words: recoveredFromTimeline ? wordsForAnchoring : project.transcription.words,
    sourceResults: recoveredSourceResults,
  };
  return {
    ...project,
    schemaVersion: 2,
    lifecycle: project.lifecycle ?? { status: 'saved' },
    sources,
    transcription,
    captions: anchorCaptionsToClips(project.captions, clips, wordsForAnchoring),
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
          ? { ...layer, timelineVisible: layer.timelineVisible ?? true }
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
  const legacyMask = value?.mask;
  const qualityPreset = isPersonMatteQualityPreset(legacyMask?.qualityPreset) ? legacyMask.qualityPreset : undefined;
  const migratedMask = qualityPreset && legacyMask ? legacyMask : PERSON_MATTE_PRESETS.stable;
  return {
    enabled: value?.enabled ?? false,
    source: value?.source,
    mask: {
      qualityPreset: qualityPreset ?? 'stable',
      threshold: boundedNumber(migratedMask.threshold, PERSON_MATTE_PRESETS.stable.threshold, 0, 1),
      softness: boundedNumber(migratedMask.softness, PERSON_MATTE_PRESETS.stable.softness, 0.001, 1),
      temporalStability: boundedNumber(migratedMask.temporalStability, PERSON_MATTE_PRESETS.stable.temporalStability, 0, 0.92),
      edgeFeather: boundedNumber(migratedMask.edgeFeather, PERSON_MATTE_PRESETS.stable.edgeFeather, 0, 1),
    },
    personTransform: {
      position: {
        x: boundedNumber(value?.personTransform?.position?.x, 0.5, -1, 2),
        y: boundedNumber(value?.personTransform?.position?.y, 0.5, -1, 2),
      },
      scale: boundedNumber(value?.personTransform?.scale, 1, 0.05, 8),
      rotation: normalizeAngle(boundedNumber(value?.personTransform?.rotation, 0, -360_000, 360_000)),
    },
    keyframes: normalizedPersonKeyframes(Array.isArray(value?.keyframes) ? value.keyframes : []),
  };
}

function isPersonMatteQualityPreset(value: unknown): value is CaptionProject['backgroundReplacement']['mask']['qualityPreset'] {
  return value === 'stable' || value === 'balanced' || value === 'detailed' || value === 'custom';
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function normalizeAngle(value: number) {
  return ((value + 180) % 360 + 360) % 360 - 180;
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
      transitionAfter: hydrateTransition(clip.transitionAfter),
    };
  });

  return normalized.map((clip, index) => {
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
}

function hydrateTransition(value: VideoClip['transitionAfter'] | undefined): VideoClip['transitionAfter'] {
  const type = value?.type ?? 'none';
  if (!['none', 'dip-black', 'dip-white', 'flash'].includes(type)) {
    throw new Error('A project video transition is invalid');
  }
  const durationMs = type === 'none' ? 0 : finiteNumber(value?.durationMs ?? 500, 'transition duration');
  if (durationMs < 0 || durationMs > 2_000) throw new Error('A project video transition duration is invalid');
  return { type, durationMs };
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

function recoverCanonicalSourceResults(project: CaptionProject, clips: VideoClip[]) {
  const wordsBySource = recoverCanonicalSourceWords(clips, project.transcription.words);
  return Object.fromEntries(Object.entries(wordsBySource).map(([sourceId, words]) => [sourceId, {
    language: project.transcription.language,
    modelId: project.transcription.modelId,
    generatedAt: project.transcription.generatedAt ?? project.updatedAt,
    words,
  }]));
}

function migrateVersionOne(candidate: Record<string, unknown>): CaptionProject {
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
    lifecycle: { status: 'saved' },
    sources: [source],
    clips: (legacy.clips?.length ? legacy.clips : [{ id: 'source-clip', sourceStartMs: 0, sourceEndMs: source.durationMs }])
      .map((clip) => ({ ...clip, id: String(clip.id), sourceId } as VideoClip)),
    transcription: { ...legacy.transcription, sourceResults: legacy.transcription.sourceResults ?? {} },
  };
  delete migrated.source;
  delete migrated.videoEdits;
  return migrated as unknown as CaptionProject;
}
