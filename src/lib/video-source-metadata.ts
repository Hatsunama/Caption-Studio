export const DEFAULT_VIDEO_FRAME_RATE = 30;
export const MIN_SOURCE_FRAME_RATE = 1;
export const MAX_SOURCE_FRAME_RATE = 240;
export const MIN_EXPORT_FRAME_RATE = 15;
export const MAX_EXPORT_FRAME_RATE = 60;

export function validatedSourceFrameRate(value: number | undefined, label: string) {
  if (value === undefined) return DEFAULT_VIDEO_FRAME_RATE;
  if (!Number.isFinite(value) || value < MIN_SOURCE_FRAME_RATE || value > MAX_SOURCE_FRAME_RATE) {
    throw new Error(`${label} has invalid frame-rate metadata.`);
  }
  return value;
}

export function selectExportFrameRate(sources: readonly { frameRate?: number }[]) {
  const highest = sources.reduce((value, source) => {
    const candidate = source.frameRate;
    return typeof candidate === 'number'
      && Number.isFinite(candidate)
      && candidate >= MIN_SOURCE_FRAME_RATE
      && candidate <= MAX_SOURCE_FRAME_RATE
      ? Math.max(value, candidate)
      : value;
  }, 0);
  const selected = highest > 0 ? highest : DEFAULT_VIDEO_FRAME_RATE;
  return Math.round(Math.min(MAX_EXPORT_FRAME_RATE, Math.max(MIN_EXPORT_FRAME_RATE, selected)));
}
