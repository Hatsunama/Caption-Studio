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
  if (!value || value.length > 64 * 1024 * 1024) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  const uris = new Set<string>();
  const pending: unknown[] = [parsed];
  let inspected = 0;
  while (pending.length > 0 && inspected < 1_000_000) {
    const candidate = pending.pop();
    inspected += 1;
    if (typeof candidate === 'string') {
      if (candidate.startsWith('content://') && candidate.length <= 16_384) uris.add(candidate);
    } else if (Array.isArray(candidate)) {
      pending.push(...candidate);
    } else if (candidate && typeof candidate === 'object') {
      pending.push(...Object.values(candidate));
    }
  }
  return [...uris];
}
