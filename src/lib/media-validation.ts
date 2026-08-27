import { validatedSourceFrameRate } from '@/lib/video-source-metadata';

export type ProbedVideoInfo = {
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

export function assertSupportedVideo(info: ProbedVideoInfo, displayName: string): void {
  if (!info.hasVideoTrack) {
    throw new Error(`${displayName} does not contain a video track. Choose a video file instead of audio-only media.`);
  }
  if (!info.hasVideo) {
    throw new Error(`${displayName} is damaged or uses a video format this phone cannot decode.`);
  }
  if (info.durationMs <= 0 || info.width <= 0 || info.height <= 0) {
    throw new Error(`${displayName} does not contain complete video timing or dimensions.`);
  }
  if (![0, 90, 180, 270].includes(info.rotation)) {
    throw new Error(`${displayName} has unsupported orientation metadata.`);
  }
  validatedSourceFrameRate(info.frameRate, displayName);
}
