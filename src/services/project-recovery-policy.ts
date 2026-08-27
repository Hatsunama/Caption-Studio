const RECOVERY_ARTIFACT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const CURRENT_RECOVERY_PATTERN = /^caption-studio-recovery-[a-z0-9_-]{1,50}-(\d{13})-[a-z0-9]{8}\.json$/i;
const LEGACY_RECOVERY_PATTERN = /^(?:[a-z0-9_-]{1,50}|caption-studio-project)-(\d{13})\.json$/i;

export function createProjectRecoveryCacheFileName(
  projectName: string,
  nowMs = Date.now(),
  nonce = Math.random().toString(36).slice(2, 10).padEnd(8, '0'),
): string {
  if (!Number.isFinite(nowMs)) throw new Error('The recovery timestamp is invalid.');
  const safeName = projectName
    .trim()
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'project';
  const timestamp = Math.max(0, Math.trunc(nowMs)).toString().padStart(13, '0').slice(-13);
  const safeNonce = nonce.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8).padEnd(8, '0');
  return `caption-studio-recovery-${safeName}-${timestamp}-${safeNonce}.json`;
}

export function isCaptionStudioRecoveryCacheArtifact(fileName: string): boolean {
  return CURRENT_RECOVERY_PATTERN.test(fileName) || LEGACY_RECOVERY_PATTERN.test(fileName);
}

export function isStaleCaptionStudioRecoveryCacheArtifact(
  fileName: string,
  modificationTimeSeconds: number | undefined,
  nowMs = Date.now(),
  maximumAgeMs = RECOVERY_ARTIFACT_MAX_AGE_MS,
): boolean {
  if (
    !isCaptionStudioRecoveryCacheArtifact(fileName)
    || !Number.isFinite(nowMs)
    || !Number.isFinite(maximumAgeMs)
    || maximumAgeMs < 0
  ) return false;
  const artifactTimeMs = Number.isFinite(modificationTimeSeconds)
    ? (modificationTimeSeconds as number) * 1_000
    : timestampFromOwnedFileName(fileName);
  return Number.isFinite(artifactTimeMs) && nowMs - artifactTimeMs >= maximumAgeMs;
}

function timestampFromOwnedFileName(fileName: string): number {
  const match = CURRENT_RECOVERY_PATTERN.exec(fileName) ?? LEGACY_RECOVERY_PATTERN.exec(fileName);
  return match ? Number(match[1]) : Number.NaN;
}
