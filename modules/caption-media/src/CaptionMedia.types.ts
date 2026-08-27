export type MediaInfo = {
  durationMs: number;
  width: number;
  height: number;
  rotation: number;
  frameRate: number;
  hasAudio: boolean;
  hasVideo: boolean;
  hasVideoTrack: boolean;
  videoMimeType: string;
};

export type ImageValidationResult = {
  width: number;
  height: number;
  mimeType: string;
};

export type FontValidationResult = {
  flavor: string;
  tableCount: number;
};

export type AudioExtractionResult = {
  outputUri: string;
  sampleRate: number;
  channelCount: number;
  durationMs: number;
  pcmBytes: number;
  insertedSilenceMs: number;
  trimmedOverlapMs: number;
};

export type VideoThumbnailResult = {
  outputUri: string;
  width: number;
  height: number;
  timeMs: number;
};

export type AudioTrackExtractionResult = {
  outputUri: string;
  durationMs: number;
  mimeType: string;
};

export type TimelineVideoExportResult = {
  outputUri: string;
  mediaUri: string;
  durationMs: number;
  width: number;
  height: number;
  sizeBytes: number;
};

export type TimelineVideoExportProgress = {
  stage: 'idle' | 'preparing' | 'rendering' | 'publishing';
  percent: number | null;
};
