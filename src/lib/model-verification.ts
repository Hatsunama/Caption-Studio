export type ModelFileIdentity = {
  fileName: string;
  sizeBytes: number;
  modifiedAtMs: number | null;
  createdAtMs: number | null;
};

type ModelVerificationMarker = {
  schemaVersion: 1;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  modifiedAtMs: number;
  createdAtMs: number | null;
};

export function encodeModelVerificationMarker(
  identity: ModelFileIdentity,
  sha256: string,
): string | null {
  const modifiedAtMs = identity.modifiedAtMs;
  if (modifiedAtMs === null || !Number.isFinite(modifiedAtMs)) return null;
  return JSON.stringify({
    schemaVersion: 1,
    fileName: identity.fileName,
    sizeBytes: identity.sizeBytes,
    sha256,
    modifiedAtMs,
    createdAtMs: identity.createdAtMs,
  } satisfies ModelVerificationMarker);
}

export function modelVerificationMarkerMatches(
  rawMarker: string,
  identity: ModelFileIdentity,
  expectedSha256: string,
): boolean {
  if (!Number.isFinite(identity.modifiedAtMs)) return false;
  try {
    const marker: unknown = JSON.parse(rawMarker);
    if (!isMarker(marker)) return false;
    return marker.schemaVersion === 1
      && marker.fileName === identity.fileName
      && marker.sizeBytes === identity.sizeBytes
      && marker.sha256 === expectedSha256
      && marker.modifiedAtMs === identity.modifiedAtMs
      && marker.createdAtMs === identity.createdAtMs;
  } catch {
    return false;
  }
}

function isMarker(value: unknown): value is ModelVerificationMarker {
  if (!value || typeof value !== 'object') return false;
  const marker = value as Record<string, unknown>;
  return marker.schemaVersion === 1
    && typeof marker.fileName === 'string'
    && Number.isSafeInteger(marker.sizeBytes)
    && typeof marker.sha256 === 'string'
    && Number.isFinite(marker.modifiedAtMs)
    && (marker.createdAtMs === null || Number.isFinite(marker.createdAtMs));
}
