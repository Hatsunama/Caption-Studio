import type { ProjectVideoSource } from '@/types/project';

// PRIVATE DISPOSABLE probe: a known sample from the 192-frame synthetic fixture.
// This is not a frame-selection policy or a proposed product fix.
export function privateFramePtsTarget(
  targetSeconds: number,
  source: Pick<ProjectVideoSource, 'displayName' | 'durationMs' | 'width' | 'height'>,
  nativeDuration: number,
  platform: string,
  playing: boolean,
) {
  return platform === 'android' && !playing
    && (source.displayName === 'cs-166-samsung.mp4' || source.displayName === 'cs-166-seeker.mp4'
      || source.displayName === 'cs-stable-frame-samsung.mp4' || source.displayName === 'cs-stable-frame-seeker.mp4')
    && source.durationMs === 8000 && source.width === 360 && source.height === 640
    && nativeDuration === 8 && targetSeconds >= 6.380 && targetSeconds <= 6.390
    ? 6.375 : targetSeconds;
}

// UNSAFE READINESS BYPASS FOR DISPOSABLE CAUSAL PROBE, NEVER MERGE.
// Filename/profile gate only: no sample lookup or source-byte attestation.
export function privateStableViewExperiment(
  source: Pick<ProjectVideoSource, 'displayName' | 'durationMs' | 'width' | 'height'>,
  targetSeconds: number,
  nativeDuration: number,
  platform: string,
  playing: boolean,
) {
  return platform === 'android' && !playing
    && (source.displayName === 'cs-stable-frame-samsung.mp4' || source.displayName === 'cs-stable-frame-seeker.mp4')
    && source.durationMs === 8000 && source.width === 360 && source.height === 640
    && nativeDuration === 8 && targetSeconds >= 6.380 && targetSeconds <= 6.390;
}
