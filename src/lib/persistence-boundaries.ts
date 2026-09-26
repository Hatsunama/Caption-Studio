export function createRetryableAsyncInitializer<T>(initialize: () => Promise<T>) {
  let initialization: Promise<T> | undefined;

  return () => {
    if (!initialization) {
      const current = initialize().catch((error) => {
        if (initialization === current) initialization = undefined;
        throw error;
      });
      initialization = current;
    }
    return initialization;
  };
}

export function decodeEveryPersistedRow<TRow, TValue>(
  rows: readonly TRow[],
  decode: (row: TRow) => TValue,
): TValue[] {
  return rows.map(decode);
}

export function inspectProjectRowsForMediaPermissionRelease<
  TRow extends { project_json: string },
  TProject,
>(rows: readonly TRow[], decode: (row: TRow) => TProject) {
  const projects: TProject[] = [];
  const protectedUris = new Set<string>();
  let complete = true;
  for (const row of rows) {
    try {
      projects.push(decode(row));
    } catch {
      const uris = inspectPersistedContentUris(row.project_json, true);
      if (uris === null) {
        complete = false;
      } else {
        uris.forEach((uri) => protectedUris.add(uri));
      }
    }
  }
  return { projects, protectedUris: [...protectedUris], complete };
}

export async function publishAfterDurableWrite<T>(
  value: T,
  write: (candidate: T) => Promise<void>,
  publish: (persisted: T) => void,
) {
  await write(value);
  publish(value);
  return value;
}

export function extractPersistedContentUris(value: string | null) {
  return inspectPersistedContentUris(value, false) ?? [];
}

function inspectPersistedContentUris(value: string | null, strict: boolean): string[] | null {
  if (!value || value.length > 64 * 1024 * 1024) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const uris = new Set<string>();
  const pending: unknown[] = [parsed];
  let inspected = 0;
  while (pending.length > 0) {
    if (inspected >= 1_000_000) return strict ? null : [...uris];
    const candidate = pending.pop();
    inspected += 1;
    if (typeof candidate === 'string') {
      if (strict && candidate.includes('content:') &&
          (!candidate.startsWith('content:') || candidate.indexOf('content:', 1) >= 0)) return null;
      if (candidate.startsWith('content:')) {
        if (strict) {
          uris.add(candidate);
        } else if (candidate.startsWith('content://') && candidate.length <= 16_384) {
          uris.add(candidate);
        }
      }
    } else if (Array.isArray(candidate)) {
      pending.push(...candidate);
    } else if (candidate && typeof candidate === 'object') {
      pending.push(...Object.values(candidate));
    }
  }
  return [...uris];
}
