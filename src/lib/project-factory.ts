import { PERSON_MATTE_PRESETS } from '@/lib/person-matte-presets';
import { cloneVideoTransform } from '@/lib/video-transform';
import { validatedSourceFrameRate } from '@/lib/video-source-metadata';
import {
  DEFAULT_CAPTION_STYLE,
  DEFAULT_VIDEO_TRANSFORM,
  type CaptionProject,
  type ProjectVideoSource,
  type VideoClip,
  type VideoTransform,
} from '@/types/project';

export function createCaptionProject(options: {
  id: string;
  name: string;
  sources: ProjectVideoSource[];
}): CaptionProject {
  if (options.sources.length === 0) throw new Error('A project requires at least one video source.');
  const now = new Date().toISOString();
  const sources = options.sources.map((source) => ({
    ...source,
    frameRate: validatedSourceFrameRate(source.frameRate, source.displayName),
  }));
  const primary = sources[0];
  const displaySize = orientedSize(primary.width, primary.height, primary.rotation);
  return {
    schemaVersion: 2,
    id: options.id,
    name: options.name,
    createdAt: now,
    updatedAt: now,
    lifecycle: { status: 'draft' },
    sources,
    transcription: {
      language: 'en',
      modelId: 'balanced',
      words: [],
      sourceResults: {},
    },
    captions: [],
    captionTracks: {
      schemaVersion: 1,
      primaryTrackId: 'captions',
      translations: [],
    },
    projectStyle: DEFAULT_CAPTION_STYLE,
    layers: [{ id: 'captions', kind: 'captions', name: 'Captions', visible: true }],
    clips: sources.map((source, index) => createVideoClip(source, index)),
    audioSources: [],
    audioClips: [],
    canvas: {
      preset: 'source',
      aspectWidth: displaySize.width,
      aspectHeight: displaySize.height,
      backgroundColor: '#000000',
    },
    videoTransform: cloneVideoTransform(DEFAULT_VIDEO_TRANSFORM),
    backgroundReplacement: {
      enabled: false,
      mask: { ...PERSON_MATTE_PRESETS.stable },
      personTransform: { position: { x: 0.5, y: 0.5 }, scale: 1, rotation: 0 },
      keyframes: [],
    },
    export: {
      resolution: '1080p',
      format: 'mp4',
      burnCaptions: true,
    },
  };
}

export function createVideoClip(
  source: ProjectVideoSource,
  index = 0,
  transform: VideoTransform = DEFAULT_VIDEO_TRANSFORM,
): VideoClip {
  return {
    id: `clip-${source.id}-${index}`,
    sourceId: source.id,
    availableSourceStartMs: 0,
    availableSourceEndMs: source.durationMs,
    sourceStartMs: 0,
    sourceEndMs: source.durationMs,
    gapBeforeMs: 0,
    gapAfterMs: 0,
    playbackRate: 1,
    volume: 1,
    muted: false,
    fadeInMs: 0,
    fadeOutMs: 0,
    transitionAfter: { type: 'none' as const, durationMs: 0 },
    transform: cloneVideoTransform(transform),
  };
}

function orientedSize(width: number, height: number, rotation: number) {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  return Math.abs(rotation) % 180 === 90
    ? { width: safeHeight, height: safeWidth }
    : { width: safeWidth, height: safeHeight };
}
