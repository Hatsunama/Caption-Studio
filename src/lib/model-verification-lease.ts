import type { ModelFileIdentity } from '@/lib/model-verification';

export function sameModelFileIdentity(expected: ModelFileIdentity | undefined, actual: ModelFileIdentity): boolean {
  return expected !== undefined
    && Number.isFinite(expected.modifiedAtMs)
    && (expected.createdAtMs === null || Number.isFinite(expected.createdAtMs))
    && expected.fileName === actual.fileName
    && expected.sizeBytes === actual.sizeBytes
    && expected.modifiedAtMs === actual.modifiedAtMs
    && expected.createdAtMs === actual.createdAtMs;
}
