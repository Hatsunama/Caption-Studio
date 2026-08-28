export type LocalProcessExitRecord = {
  timestampMs: number;
  reason: number;
  reasonClass: string;
  status: number;
  importance: number;
  pssKb: number;
  rssKb: number;
  description: string;
  versionCode: number;
};

const SAFE_DESCRIPTIONS = new Map<number, string>([
  [1, 'App requested exit'],
  [2, 'Native signal'],
  [3, 'System low memory'],
  [4, 'Java or Kotlin crash'],
  [5, 'Native crash'],
  [6, 'App not responding'],
  [7, 'Startup failure'],
  [8, 'Permission change'],
  [9, 'Excessive resource use'],
  [10, 'User or system stopped app'],
  [11, 'User stopped app'],
  [12, 'Dependency stopped'],
  [13, 'Other system exit'],
]);

export function decodeProcessExitReason(reason: number): string {
  return SAFE_DESCRIPTIONS.get(reason) ?? 'Unknown system exit';
}

export function sanitizeProcessExitRecord(input: Partial<LocalProcessExitRecord>): LocalProcessExitRecord | null {
  if (!Number.isFinite(input.timestampMs) || (input.timestampMs ?? 0) <= 0) return null;
  const reason = finiteInteger(input.reason);
  return {
    timestampMs: Math.floor(input.timestampMs!),
    reason,
    reasonClass: decodeProcessExitReason(reason),
    status: finiteInteger(input.status),
    importance: finiteInteger(input.importance),
    pssKb: finiteNonnegative(input.pssKb),
    rssKb: finiteNonnegative(input.rssKb),
    description: decodeProcessExitReason(reason),
    versionCode: finiteNonnegative(input.versionCode),
  };
}

export function mergeBoundedExitRecords(
  existing: readonly LocalProcessExitRecord[],
  incoming: readonly Partial<LocalProcessExitRecord>[],
  limit = 20,
): LocalProcessExitRecord[] {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const byIdentity = new Map<string, LocalProcessExitRecord>();
  for (const candidate of [...existing, ...incoming]) {
    const record = sanitizeProcessExitRecord(candidate);
    if (record) byIdentity.set(`${record.timestampMs}:${record.reason}:${record.status}`, record);
  }
  return [...byIdentity.values()].sort((a, b) => b.timestampMs - a.timestampMs).slice(0, safeLimit);
}

function finiteInteger(value: unknown): number {
  return Number.isFinite(value) ? Math.trunc(value as number) : 0;
}

function finiteNonnegative(value: unknown): number {
  return Math.max(0, finiteInteger(value));
}
