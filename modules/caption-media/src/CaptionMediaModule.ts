import { NativeModule, requireNativeModule } from 'expo';
import type { DocumentReadStatus, VideoDocumentResult } from './CaptionMedia.types';

import type { AudioExtractionResult, AudioPeaksResult, AudioTrackExtractionResult, FontValidationResult, ImageValidationResult, MediaInfo, TimelineVideoExportProgress, TimelineVideoExportResult, VideoPlaybackSupport, VideoPreviewResult, VideoThumbnailResult } from './CaptionMedia.types';

export type { TimelineVideoExportProgress } from './CaptionMedia.types';

declare class CaptionMediaModule extends NativeModule<Record<never, never>> {
  pickVideoDocuments(multiple: boolean): Promise<VideoDocumentResult>;
  checkReadAccess(inputUri: string): Promise<{ status: DocumentReadStatus }>;
  persistReadPermission(inputUri: string): Promise<boolean>;
  releaseReadPermission(inputUri: string): Promise<boolean>;
  sha256(inputUri: string): Promise<string>;
  getMediaInfo(inputUri: string): Promise<MediaInfo>;
  getVideoPlaybackSupport(inputUri: string): Promise<VideoPlaybackSupport>;
  createVideoPreview(inputUri: string, outputUri: string, width: number, height: number, frameRate: number): Promise<VideoPreviewResult>;
  validateImageFile(inputUri: string): Promise<ImageValidationResult>;
  validateFontFile(inputUri: string): Promise<FontValidationResult>;
  extractAudioToWav(
    inputUri: string,
    outputUri: string,
  ): Promise<AudioExtractionResult>;
  cancelAudioExtraction(): Promise<void>;
  extractAudioTrack(inputUri: string, outputUri: string): Promise<AudioTrackExtractionResult>;
  generateAudioPeaks(inputUri: string, peakCount: number): Promise<AudioPeaksResult>;
  generateVideoThumbnail(
    inputUri: string,
    outputUri: string,
    timeMs: number,
  ): Promise<VideoThumbnailResult>;
  requestLegacyMediaWritePermission(): Promise<boolean>;
  exportTimelineVideo(outputPath: string, renderPlan: Record<string, unknown>): Promise<TimelineVideoExportResult>;
  getTimelineVideoExportProgress(): Promise<TimelineVideoExportProgress>;
  cancelTimelineVideoExport(): Promise<void>;
}

export default requireNativeModule<CaptionMediaModule>('CaptionMedia');
