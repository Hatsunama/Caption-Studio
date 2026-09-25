import type { SourceTranscription } from '@/types/project';
import { hasCanonicalSourceWords } from '@/lib/primary-caption-timing';

const SHA256_DIGEST_PATTERN = /^[0-9a-f]{64}$/i;
// Bump this mask whenever alignment or VAD behavior changes. It versions the
// cache key using the existing media hash without reading the media again.
const ALIGNMENT_VAD_CACHE_REVISION = '1'.repeat(64);

export type SourceTranscriptionFingerprint = NonNullable<SourceTranscription['sourceFingerprint']>;

export function createSourceTranscriptionFingerprint(
  digest: string,
  revision = ALIGNMENT_VAD_CACHE_REVISION,
): SourceTranscriptionFingerprint {
  const normalized = digest.trim().toLowerCase();
  if (!SHA256_DIGEST_PATTERN.test(normalized) || !SHA256_DIGEST_PATTERN.test(revision)) {
    throw new Error('The source video fingerprint is invalid.');
  }
  const versionedDigest = Array.from(normalized, (digit, index) =>
    (parseInt(digit, 16) ^ parseInt(revision[index], 16)).toString(16),
  ).join('');
  return { algorithm: 'sha256', digest: versionedDigest };
}

export function canReuseSourceTranscription(
  result: SourceTranscription | undefined,
  modelId: string,
  sourceFingerprint: SourceTranscriptionFingerprint,
) {
  return result?.modelId === modelId
    && result.sourceFingerprint?.algorithm === sourceFingerprint.algorithm
    && result.sourceFingerprint.digest === sourceFingerprint.digest
    && hasCanonicalSourceWords(result.words);
}
