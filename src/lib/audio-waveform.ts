import type { ProjectAudioSource } from '@/types/project';

export const AUDIO_WAVEFORM_VERSION = 2 as const;
export const MIN_AUDIO_WAVEFORM_PEAKS = 128;
export const MAX_AUDIO_WAVEFORM_PEAKS = 4_096;
const AUDIO_WAVEFORM_PEAKS_PER_SECOND = 12;
const MAX_RENDERED_WAVEFORM_BARS = 256;

export function audioWaveformPeakCount(durationMs: number) {
  const durationSeconds = Number.isFinite(durationMs) ? Math.max(0, durationMs) / 1_000 : 0;
  return clamp(
    Math.round(durationSeconds * AUDIO_WAVEFORM_PEAKS_PER_SECOND),
    MIN_AUDIO_WAVEFORM_PEAKS,
    MAX_AUDIO_WAVEFORM_PEAKS,
  );
}

export function audioWaveformNeedsRefresh(source: Pick<ProjectAudioSource, 'durationMs' | 'waveformPeaks' | 'waveformVersion'>) {
  if (source.waveformVersion !== AUDIO_WAVEFORM_VERSION) return true;
  if (!source.waveformPeaks || source.waveformPeaks.length !== audioWaveformPeakCount(source.durationMs)) return true;
  return source.waveformPeaks.some((peak) => !Number.isFinite(peak) || peak < 0 || peak > 1);
}

export function audioWaveformWindow(options: {
  peaks: readonly number[];
  sourceDurationMs: number;
  sourceStartMs: number;
  sourceEndMs: number;
  clipStartMs: number;
  clipEndMs: number;
  visibleStartMs: number;
  visibleEndMs: number;
  renderedClipWidth: number;
}) {
  const clipDurationMs = Math.max(1, options.clipEndMs - options.clipStartMs);
  const visibleStartMs = clamp(options.visibleStartMs, options.clipStartMs, options.clipEndMs);
  const visibleEndMs = clamp(options.visibleEndMs, visibleStartMs, options.clipEndMs);
  if (visibleEndMs <= visibleStartMs || options.peaks.length === 0) {
    return { bars: [] as number[], leftPx: 0, widthPx: 0 };
  }

  const leftRatio = (visibleStartMs - options.clipStartMs) / clipDurationMs;
  const widthRatio = (visibleEndMs - visibleStartMs) / clipDurationMs;
  const sourceSpanMs = Math.max(1, options.sourceEndMs - options.sourceStartMs);
  const sourceWindowStartMs = options.sourceStartMs + sourceSpanMs * leftRatio;
  const sourceWindowEndMs = sourceWindowStartMs + sourceSpanMs * widthRatio;
  const sourceDurationMs = Math.max(1, options.sourceDurationMs);
  const first = clamp(
    Math.floor(sourceWindowStartMs / sourceDurationMs * options.peaks.length),
    0,
    options.peaks.length - 1,
  );
  const after = clamp(
    Math.ceil(sourceWindowEndMs / sourceDurationMs * options.peaks.length),
    first + 1,
    options.peaks.length,
  );
  const widthPx = Math.max(1, options.renderedClipWidth * widthRatio);
  const desiredBars = clamp(Math.floor(widthPx / 3), 8, MAX_RENDERED_WAVEFORM_BARS);
  return {
    bars: bucketWaveformPeaks(options.peaks.slice(first, after), desiredBars),
    leftPx: options.renderedClipWidth * leftRatio,
    widthPx,
  };
}

export function bucketWaveformPeaks(peaks: readonly number[], requestedCount: number) {
  const count = clamp(Math.floor(requestedCount), 1, MAX_RENDERED_WAVEFORM_BARS);
  if (peaks.length <= count) return peaks.map(normalizedPeak);
  const result = new Array<number>(count).fill(0);
  for (let index = 0; index < peaks.length; index += 1) {
    const bucket = Math.min(count - 1, Math.floor(index * count / peaks.length));
    result[bucket] = Math.max(result[bucket], normalizedPeak(peaks[index]));
  }
  return result;
}

function normalizedPeak(value: number) {
  return Number.isFinite(value) ? clamp(value, 0, 1) : 0;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
