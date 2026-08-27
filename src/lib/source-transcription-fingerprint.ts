import type { SourceTranscription } from '@/types/project';

const SHA256_DIGEST_PATTERN = /^[0-9a-f]{64}$/i;

export type SourceTranscriptionFingerprint = NonNullable<SourceTranscription['sourceFingerprint']>;

export function createSourceTranscriptionFingerprint(digest: string): SourceTranscriptionFingerprint {
  const normalized = digest.trim().toLowerCase();
  if (!SHA256_DIGEST_PATTERN.test(normalized)) {
    throw new Error('The source video fingerprint is invalid.');
  }
  return { algorithm: 'sha256', digest: normalized };
}

export function canReuseSourceTranscription(
  result: SourceTranscription | undefined,
  modelId: string,
  sourceFingerprint: SourceTranscriptionFingerprint,
) {
  return result?.modelId === modelId
    && result.sourceFingerprint?.algorithm === sourceFingerprint.algorithm
    && result.sourceFingerprint.digest === sourceFingerprint.digest;
}
