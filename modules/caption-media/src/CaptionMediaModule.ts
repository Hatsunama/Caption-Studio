import { NativeModule, requireNativeModule } from 'expo';

import type { AudioExtractionResult, AudioTrackExtractionResult, FontValidationResult, ImageValidationResult, MediaInfo, TimelineVideoExportProgress, TimelineVideoExportResult, VideoThumbnailResult } from './CaptionMedia.types';

export type { TimelineVideoExportProgress } from './CaptionMedia.types';

declare class CaptionMediaModule extends NativeModule<Record<never, never>> {
  persistReadPermission(inputUri: string): Promise<boolean>;
  releaseReadPermission(inputUri: string): Promise<boolean>;
  sha256(inputUri: string): Promise<string>;
  getMediaInfo(inputUri: string): Promise<MediaInfo>;
  validateImageFile(inputUri: string): Promise<ImageValidationResult>;
  validateFontFile(inputUri: string): Promise<FontValidationResult>;
  extractAudioToWav(
    inputUri: string,
    outputUri: string,
  ): Promise<AudioExtractionResult>;
  cancelAudioExtraction(): Promise<void>;
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
      backgroundTimeMs: number;
      qualityPreset: 'stable' | 'balanced' | 'detailed' | 'custom';
      threshold: number;
      softness: number;
      temporalStability: number;
      edgeFeather: number;
      positionX: number;
      positionY: number;
      scale: number;
      rotation: number;
      outputWidth: number;
      outputHeight: number;
      videoFit: 'fit' | 'fill';
      videoPositionX: number;
      videoPositionY: number;
      videoScale: number;
      videoRotation: number;
    },
  ): Promise<VideoThumbnailResult>;
  resetPersonSegmentation(): Promise<void>;
  requestLegacyMediaWritePermission(): Promise<boolean>;
  exportTimelineVideo(outputPath: string, renderPlan: Record<string, unknown>): Promise<TimelineVideoExportResult>;
  getTimelineVideoExportProgress(): Promise<TimelineVideoExportProgress>;
  cancelTimelineVideoExport(): Promise<void>;
}

export default requireNativeModule<CaptionMediaModule>('CaptionMedia');
