export function displayTranscriptionProgress(progress: number | null): number | null {
  if (progress === null || !Number.isFinite(progress)) return null;
  return Math.round(Math.max(0, Math.min(1, progress)) * 100);
}
