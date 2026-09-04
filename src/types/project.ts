import type { VideoTransition } from '@/lib/video-transitions';

export type { VideoTransition, VideoTransitionType } from '@/lib/video-transitions';

export type Identifier = string;

export type CaptionAnimationId =
  | 'none'
  | 'active-word'
  | 'karaoke'
  | 'single-word'
  | 'pop'
  | 'bounce'
  | 'punch'
  | 'typewriter'
  | 'slide-up'
  | 'slide-left'
  | 'zoom-in'
  | 'spin-in'
  | 'wave'
  | 'shake'
  | 'glow-pulse'
  | 'elastic'
  | 'flip'
  | 'stomp'
  | 'fade-in'
  | 'drop-in'
  | 'swing'
  | 'heartbeat'
  | 'flicker'
  | 'tilt-in'
  | 'squash'
  | 'stretch'
  | 'word-spin'
  | 'word-slide'
  | 'word-flash'
  | 'word-jitter'
  | 'emoji-burst'
  | 'emoji-orbit'
  | 'emoji-rain';

export type TextTreatment = 'solid' | 'duotone-offset' | 'duotone-shadow' | 'duotone-neon';

export type FontReference = {
  id: Identifier;
  family: string;
  source: 'system' | 'built-in' | 'imported';
  uri?: string;
  postScriptName?: string;
};

export type NormalizedTransform = {
  position: { x: number; y: number };
  box: { width: number; height: number };
  rotation: number;
};

export type CaptionStyle = {
  font: FontReference;
  fontSize: number;
  fontWeight: '400' | '500' | '600' | '700' | '800' | '900';
  italic: boolean;
  textColor: string;
  secondaryTextColor: string;
  textTreatment: TextTreatment;
  activeWordColor: string;
  stroke: {
    color: string;
    width: number;
  };
  shadow: {
    color: string;
    opacity: number;
    blur: number;
    offsetX: number;
    offsetY: number;
  };
  background: {
    color: string;
    opacity: number;
    radius: number;
    paddingX: number;
    paddingY: number;
  };
  alignment: 'left' | 'center' | 'right';
  letterSpacing: number;
  lineHeight: number;
  textTransform: 'none' | 'uppercase' | 'lowercase';
  position: {
    x: number;
    y: number;
  };
  box: {
    width: number;
    height: number;
  };
  rotation: number;
  maxLines: number;
  animation: {
    id: CaptionAnimationId;
    intensity: number;
    durationMs: number;
  };
};

export type CaptionStylePatch = Partial<
  Omit<CaptionStyle, 'font' | 'stroke' | 'shadow' | 'background' | 'position' | 'box' | 'animation'>
> & {
  font?: Partial<FontReference>;
  stroke?: Partial<CaptionStyle['stroke']>;
  shadow?: Partial<CaptionStyle['shadow']>;
  background?: Partial<CaptionStyle['background']>;
  position?: Partial<CaptionStyle['position']>;
  box?: Partial<CaptionStyle['box']>;
  animation?: Partial<CaptionStyle['animation']>;
};

export type WordToken = {
  id: Identifier;
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
  styleOverride?: CaptionStylePatch;
};

export type CaptionBlock = {
  id: Identifier;
  text: string;
  startMs: number;
  endMs: number;
  wordIds: Identifier[];
  textMode?: 'automatic' | 'manual';
  timelineVisible?: boolean;
  sourceAnchor?: {
    clipId: Identifier;
    sourceStartMs: number;
    sourceEndMs: number;
    wordIds: Identifier[];
  };
  styleOverride?: CaptionStylePatch;
};

export type TranslationCaptionStatus = 'pending' | 'translated' | 'reviewed' | 'stale' | 'failed';

export type TranslationCaptionCue = {
  id: Identifier;
  sourceCaptionId: Identifier;
  sourceTextSnapshot: string;
  text: string;
  status: TranslationCaptionStatus;
  reviewed: boolean;
  startMs?: number;
  endMs?: number;
  timelineVisible?: boolean;
  styleOverride?: CaptionStylePatch;
};

export type TranslationCaptionTrack = {
  id: Identifier;
  kind: 'translation';
  sourceTrackId: 'captions';
  sourceLanguageTag: string;
  languageTag: string;
  displayName: string;
  visible: boolean;
  origin: 'manual' | 'automatic';
  provider: {
    id: 'manual' | 'litertlm';
    modelId?: string;
    modelRevision?: string;
    promptVersion?: number;
  };
  stackGap?: number;
  styleOverride?: CaptionStylePatch;
  cues: TranslationCaptionCue[];
};

export type CaptionTrackCollection = {
  schemaVersion: 1;
  primaryTrackId: 'captions';
  translations: TranslationCaptionTrack[];
};

export type CaptionsVisualLayer = {
  id: 'captions';
  kind: 'captions';
  name: string;
  visible: boolean;
};

export type LayerSourceAnchor = {
  clipId: Identifier;
  sourceStartMs: number;
  sourceEndMs: number;
};

export type TextVisualLayer = {
  id: Identifier;
  kind: 'text';
  name: string;
  visible: boolean;
  text: string;
  startMs: number;
  endMs: number;
  style: CaptionStyle;
  sourceAnchors?: LayerSourceAnchor[];
  timelineVisible?: boolean;
};

export type ImageVisualLayer = {
  id: Identifier;
  kind: 'image';
  name: string;
  visible: boolean;
  uri: string;
  startMs: number;
  endMs: number;
  position: { x: number; y: number };
  box: { width: number; height: number };
  rotation: number;
  opacity: number;
  sourceAnchors?: LayerSourceAnchor[];
  timelineVisible?: boolean;
};

export type VisualLayer = CaptionsVisualLayer | TextVisualLayer | ImageVisualLayer;

export type ProjectVideoSource = {
  id: Identifier;
  uri: string;
  storageMode: 'linked' | 'copied';
  sizeBytes?: number;
  mimeType?: string;
  thumbnailUri?: string;
  displayName: string;
  durationMs: number;
  width: number;
  height: number;
  rotation: number;
  frameRate?: number;
};

export type VideoTransform = {
  fit: 'fit' | 'fill';
  position: { x: number; y: number };
  scale: number;
  rotation: number;
};

export type VideoTransformPatch = Partial<Omit<VideoTransform, 'position'>> & {
  position?: Partial<VideoTransform['position']>;
};

export type VideoClip = {
  id: Identifier;
  sourceId: Identifier;
  availableSourceStartMs: number;
  availableSourceEndMs: number;
  sourceStartMs: number;
  sourceEndMs: number;
  gapBeforeMs: number;
  gapAfterMs: number;
  playbackRate: number;
  volume: number;
  muted: boolean;
  fadeInMs: number;
  fadeOutMs: number;
  transitionAfter: VideoTransition;
  transform: VideoTransform;
};

export type PersonTransformKeyframe = {
  id: Identifier;
  timeMs: number;
  position: { x: number; y: number };
  scale: number;
  rotation: number;
};

export type BackgroundReplacement = {
  enabled: boolean;
  source?: {
    kind: 'image' | 'video';
    uri: string;
    storageMode: 'linked' | 'copied';
    displayName: string;
  };
  mask: {
    qualityPreset: 'stable' | 'balanced' | 'detailed' | 'custom';
    threshold: number;
    softness: number;
    temporalStability: number;
    edgeFeather: number;
  };
  personTransform: {
    position: { x: number; y: number };
    scale: number;
    rotation: number;
  };
  keyframes: PersonTransformKeyframe[];
};

export type ProjectAudioSource = {
  id: Identifier;
  uri: string;
  storageMode: 'copied';
  displayName: string;
  durationMs: number;
  mimeType?: string;
  origin: 'audio-file' | 'video-audio';
};

export type AudioClip = {
  id: Identifier;
  sourceId: Identifier;
  anchor: 'timeline';
  startMs: number;
  sourceStartMs: number;
  sourceEndMs: number;
  volume: number;
  muted: boolean;
  fadeInMs: number;
  fadeOutMs: number;
};

export type SourceTranscription = {
  language: string;
  modelId: string;
  generatedAt: string;
  sourceFingerprint?: {
    algorithm: 'sha256';
    digest: string;
  };
  words: WordToken[];
};

export type CaptionProject = {
  schemaVersion: 2;
  id: Identifier;
  name: string;
  createdAt: string;
  updatedAt: string;
  lifecycle: {
    status: 'draft' | 'saved';
  };
  sources: ProjectVideoSource[];
  transcription: {
    language: string;
    modelId: string;
    generatedAt?: string;
    words: WordToken[];
    sourceResults: Record<Identifier, SourceTranscription>;
  };
  captions: CaptionBlock[];
  captionTracks: CaptionTrackCollection;
  projectStyle: CaptionStyle;
  layers: VisualLayer[];
  clips: VideoClip[];
  audioSources: ProjectAudioSource[];
  audioClips: AudioClip[];
  canvas: {
    preset: 'source' | '9:16' | '16:9' | '1:1' | '4:5';
    aspectWidth: number;
    aspectHeight: number;
    backgroundColor: string;
  };
  videoTransform: VideoTransform;
  backgroundReplacement: BackgroundReplacement;
  export: {
    resolution: '720p' | '1080p' | 'original';
    format: 'mp4';
    burnCaptions: boolean;
  };
};

export const DEFAULT_VIDEO_TRANSFORM: VideoTransform = {
  fit: 'fit',
  position: { x: 0.5, y: 0.5 },
  scale: 1,
  rotation: 0,
};

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  font: {
    id: 'inter-bold',
    family: 'sans-serif',
    source: 'system',
  },
  fontSize: 48,
  fontWeight: '800',
  italic: false,
  textColor: '#FFFFFF',
  secondaryTextColor: '#FF4FD8',
  textTreatment: 'solid',
  activeWordColor: '#64D2FF',
  stroke: {
    color: '#111111',
    width: 3,
  },
  shadow: {
    color: '#000000',
    opacity: 0.45,
    blur: 4,
    offsetX: 0,
    offsetY: 3,
  },
  background: {
    color: '#000000',
    opacity: 0,
    radius: 18,
    paddingX: 16,
    paddingY: 10,
  },
  alignment: 'center',
  letterSpacing: 0,
  lineHeight: 1.05,
  textTransform: 'none',
  position: {
    x: 0.5,
    y: 0.78,
  },
  box: {
    width: 0.86,
    height: 0.2,
  },
  rotation: 0,
  maxLines: 2,
  animation: {
    id: 'active-word',
    intensity: 0.12,
    durationMs: 140,
  },
};
