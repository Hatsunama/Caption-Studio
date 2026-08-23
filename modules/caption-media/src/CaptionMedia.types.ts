export type MediaInfo = {
  durationMs: number;
  width: number;
  height: number;
  rotation: number;
  hasAudio: boolean;
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
