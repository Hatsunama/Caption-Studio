import { NativeModule, requireNativeModule } from 'expo';

import type { AudioExtractionResult, AudioTrackExtractionResult, MediaInfo, VideoThumbnailResult } from './CaptionMedia.types';

declare class CaptionMediaModule extends NativeModule<{}> {
  persistReadPermission(inputUri: string): Promise<boolean>;
  sha256(inputUri: string): Promise<string>;
  getMediaInfo(inputUri: string): Promise<MediaInfo>;
  extractAudioToWav(
    inputUri: string,
    outputUri: string,
  ): Promise<AudioExtractionResult>;
  extractAudioTrack(inputUri: string, outputUri: string): Promise<AudioTrackExtractionResult>;
  generateVideoThumbnail(
    inputUri: string,
    outputUri: string,
    timeMs: number,
  ): Promise<VideoThumbnailResult>;
  renderPersonPreviewFrame(
    inputUri: string,
    backgroundUri: string | null,
    outputUri: string,
    options: {
      timeMs: number;
      threshold: number;
      softness: number;
      temporalStability: number;
      edgeFeather: number;
      positionX: number;
      positionY: number;
      scale: number;
      rotation: number;
    },
  ): Promise<VideoThumbnailResult>;
  resetPersonSegmentation(): Promise<void>;
  exportPersonVideo(
    inputUri: string,
    backgroundUri: string,
    outputPath: string,
    options: {
      durationMs: number;
      sourceStartMs: number;
      backgroundKind: 'image' | 'video';
      threshold: number;
      softness: number;
      temporalStability: number;
      edgeFeather: number;
      positionX: number;
      positionY: number;
      scale: number;
      rotation: number;
    },
  ): Promise<{ outputUri: string; mediaUri: string; durationMs: number; width: number; height: number; sizeBytes: number }>;
  cancelPersonVideoExport(): Promise<void>;
}

export default requireNativeModule<CaptionMediaModule>('CaptionMedia');
