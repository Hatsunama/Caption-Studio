export const MEDIA_PERMISSION_RELEASE_LEDGER_VERSION = 1 as const;

export type MediaPermissionReleaseLedger = Readonly<{
  version: typeof MEDIA_PERMISSION_RELEASE_LEDGER_VERSION;
  uris: readonly string[];
}>;

export type MediaPermissionReleaseAttempt = Readonly<{
  uri: string;
  released: boolean;
}>;

export function createMediaPermissionReleaseLedger(
  uris: Iterable<unknown>,
): MediaPermissionReleaseLedger {
  return {
    version: MEDIA_PERMISSION_RELEASE_LEDGER_VERSION,
    uris: uniqueContentUris(uris),
  };
}

export function decodeMediaPermissionReleaseLedger(
  value: unknown,
): MediaPermissionReleaseLedger {
  if (!value || typeof value !== 'object') return createMediaPermissionReleaseLedger([]);
  const candidate = value as { version?: unknown; uris?: unknown };
  if (
    candidate.version !== MEDIA_PERMISSION_RELEASE_LEDGER_VERSION
    || !Array.isArray(candidate.uris)
  ) return createMediaPermissionReleaseLedger([]);
  return createMediaPermissionReleaseLedger(candidate.uris);
}

export function mergeMediaPermissionReleaseLedger(
  ledger: MediaPermissionReleaseLedger,
  candidates: Iterable<unknown>,
): MediaPermissionReleaseLedger {
  return createMediaPermissionReleaseLedger([...ledger.uris, ...candidates]);
}

export function settleMediaPermissionReleaseAttempts(
  ledger: MediaPermissionReleaseLedger,
  attempts: Iterable<MediaPermissionReleaseAttempt>,
): MediaPermissionReleaseLedger {
  const released = new Set(
    [...attempts]
      .filter((attempt) => attempt.released)
      .map((attempt) => attempt.uri),
  );
  return createMediaPermissionReleaseLedger(
    ledger.uris.filter((uri) => !released.has(uri)),
  );
}

function uniqueContentUris(values: Iterable<unknown>): string[] {
  return [...new Set(
    [...values].filter((value): value is string => (
      typeof value === 'string'
      && value.startsWith('content:')
      && value.length <= 16_384
    )),
  )];
}
