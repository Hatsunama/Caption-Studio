const EXPORT_ARTIFACT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const MEBIBYTE = 1024 * 1024;
const EXPORT_FILE_PATTERN = /^caption-studio-[a-z0-9_-]{1,96}-\d{13}-[a-z0-9]{8}\.(?:mp4|srt|ass)$/i;
const EXPORT_BASE_FRAME_PATTERN = /^\.caption-studio-[a-z0-9_-]{1,96}-\d{13}-[a-z0-9]{8}-base\.png$/i;
const LEGACY_EXPORT_FILE_PATTERN = /^(?:[a-z0-9_-]{1,60}-\d{13}\.mp4|[a-z0-9_-]{1,60}\.(?:srt|ass))$/i;
const LEGACY_EXPORT_BASE_FRAME_PATTERN = /^\.[a-z0-9_-]{1,60}-\d{13}-base\.png$/i;

export type VideoExportStorageInput = {
  width: number;
  height: number;
  durationMs: number;
  frameRate: number;
};

export function estimateVideoExportStorageBytes(input: VideoExportStorageInput): number {
  const width = positiveFinite(input.width, 'render width');
  const height = positiveFinite(input.height, 'render height');
  const durationSeconds = positiveFinite(input.durationMs, 'render duration') / 1_000;
  const frameRate = positiveFinite(input.frameRate, 'render frame rate');
  const pixels = width * height;
  const videoBitsPerSecond = clamp(pixels * frameRate * 0.12, 1_500_000, 50_000_000);
  const audioBitsPerSecond = 256_000;
  const encodedBytes = (videoBitsPerSecond + audioBitsPerSecond) * durationSeconds / 8 * 1.35;
  const cacheAndPublishedCopies = encodedBytes * 2;
  const baseFrameBytes = pixels * 4;
  const codecWorkingHeadroom = Math.max(96 * MEBIBYTE, pixels * 8);
  const estimate = Math.ceil(cacheAndPublishedCopies + baseFrameBytes + codecWorkingHeadroom);
  if (!Number.isSafeInteger(estimate)) throw new Error('This video is too large to estimate export storage safely.');
  return estimate;
}

export function createExportCacheFileName(
  projectName: string,
  extension: 'mp4' | 'srt' | 'ass',
  nowMs = Date.now(),
  nonce = Math.random().toString(36).slice(2, 10).padEnd(8, '0'),
): string {
  if (!Number.isFinite(nowMs)) throw new Error('The export timestamp is invalid.');
  const safeName = projectName
    .trim()
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'export';
  const safeNonce = nonce.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8).padEnd(8, '0');
  const timestamp = Math.max(0, Math.trunc(nowMs)).toString().padStart(13, '0').slice(-13);
  return `caption-studio-${safeName}-${timestamp}-${safeNonce}.${extension}`;
}

export function isCaptionStudioExportCacheArtifact(fileName: string): boolean {
  return EXPORT_FILE_PATTERN.test(fileName) || EXPORT_BASE_FRAME_PATTERN.test(fileName);
}

export function isLegacyCaptionStudioExportCacheArtifact(fileName: string): boolean {
  return LEGACY_EXPORT_FILE_PATTERN.test(fileName) || LEGACY_EXPORT_BASE_FRAME_PATTERN.test(fileName);
}

export function isStaleCaptionStudioExportCacheArtifact(
  fileName: string,
  modificationTimeSeconds: number | undefined,
  nowMs = Date.now(),
  maximumAgeMs = EXPORT_ARTIFACT_MAX_AGE_MS,
): boolean {
  if (!isCaptionStudioExportCacheArtifact(fileName)) return false;
  return staleAt(modificationTimeSeconds, nowMs, maximumAgeMs);
}

export function isStaleLegacyCaptionStudioExportCacheArtifact(
  fileName: string,
  modificationTimeSeconds: number | undefined,
  nowMs = Date.now(),
  maximumAgeMs = EXPORT_ARTIFACT_MAX_AGE_MS,
): boolean {
  if (!isLegacyCaptionStudioExportCacheArtifact(fileName)) return false;
  return staleAt(modificationTimeSeconds, nowMs, maximumAgeMs);
}

function staleAt(
  modificationTimeSeconds: number | undefined,
  nowMs: number,
  maximumAgeMs: number,
): boolean {
  if (
    !Number.isFinite(modificationTimeSeconds)
    || !Number.isFinite(nowMs)
    || !Number.isFinite(maximumAgeMs)
    || maximumAgeMs < 0
  ) return false;
  const ageMs = nowMs - (modificationTimeSeconds as number) * 1_000;
  return ageMs >= maximumAgeMs;
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`The ${label} is invalid.`);
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export type VideoExportDelivery = {
  outputUri: string;
  mediaUri: string;
  durationMs: number;
  width: number;
  height: number;
  sizeBytes: number;
};

export function assertVideoExportDelivery(value: unknown): VideoExportDelivery {
  if (value === null || typeof value !== 'object') {
    throw new Error('The exporter did not return a video.');
  }
  const record = value as Record<string, unknown>;
  const sizeBytes = requiredPositiveInteger(record.sizeBytes, 'exported file size');
  if (!Number.isSafeInteger(sizeBytes)) {
    throw new Error('The exported video is too large to verify.');
  }
  return {
    outputUri: requiredNonBlankString(record.outputUri, 'exported video'),
    mediaUri: requiredNonBlankString(record.mediaUri, 'media library copy'),
    durationMs: requiredPositiveInteger(record.durationMs, 'exported duration'),
    width: requiredEvenDimension(record.width, 'exported width'),
    height: requiredEvenDimension(record.height, 'exported height'),
    sizeBytes,
  };
}

function requiredNonBlankString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`The ${label} is missing.`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function requiredEvenDimension(value: unknown, label: string): number {
  const dimension = requiredPositiveInteger(value, label);
  if (dimension < 2 || dimension > 3840 || dimension % 2 !== 0) {
    throw new Error(`The ${label} is invalid.`);
  }
  return dimension;
}
