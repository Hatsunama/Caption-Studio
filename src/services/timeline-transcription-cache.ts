import * as FileSystem from 'expo-file-system/legacy';

import { canReuseSourceTranscription, type SourceTranscriptionFingerprint } from '@/lib/source-transcription-fingerprint';
import type { SourceTranscription } from '@/types/project';

const MAX_CACHE_BYTES = 4 * 1024 * 1024;

type CacheRecord = {
  version: 2;
  projectId: string;
  result: SourceTranscription;
};

// Count UTF-8 bytes without allocating another multi-megabyte string or buffer.
function utf8Bytes(value: string) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff
      && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function cacheUri() {
  return FileSystem.cacheDirectory ? `${FileSystem.cacheDirectory}caption-timeline-transcription-v1.json` : undefined;
}

async function readCandidate(uri: string, projectId: string, fingerprint: SourceTranscriptionFingerprint, modelId: string) {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists || info.isDirectory || (info.size ?? 0) > MAX_CACHE_BYTES) return undefined;
  const raw = await FileSystem.readAsStringAsync(uri);
  if (utf8Bytes(raw) > MAX_CACHE_BYTES) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Partial<CacheRecord>;
  if (record.version !== 2 || record.projectId !== projectId
    || !record.result || typeof record.result !== 'object') return undefined;
  return canReuseSourceTranscription(record.result, modelId, fingerprint) ? record.result : undefined;
}

export async function readTimelineTranscription(projectId: string, fingerprint: SourceTranscriptionFingerprint, modelId: string) {
  const uri = cacheUri();
  if (!uri) return undefined;
  for (const candidate of [uri, `${uri}.previous`]) {
    try {
      const result = await readCandidate(candidate, projectId, fingerprint, modelId);
      if (result) return result;
    } catch {
      // Cache corruption cannot prevent a fresh transcription.
    }
  }
  return undefined;
}

export async function writeTimelineTranscription(
  projectId: string,
  fingerprint: SourceTranscriptionFingerprint,
  result: SourceTranscription,
) {
  if (!canReuseSourceTranscription(result, result.modelId, fingerprint)) return;
  const uri = cacheUri();
  if (!uri) return;
  const encoded = JSON.stringify({ version: 2, projectId, result } satisfies CacheRecord);
  if (utf8Bytes(encoded) > MAX_CACHE_BYTES) return;
  const staging = `${uri}.writing`;
  const previous = `${uri}.previous`;
  await FileSystem.writeAsStringAsync(staging, encoded);
  if ((await FileSystem.getInfoAsync(uri)).exists) {
    if ((await FileSystem.getInfoAsync(previous)).exists) {
      await FileSystem.deleteAsync(previous, { idempotent: true });
    }
    await FileSystem.moveAsync({ from: uri, to: previous });
  }
  await FileSystem.moveAsync({ from: staging, to: uri });
  await FileSystem.deleteAsync(previous, { idempotent: true });
}

export async function clearTimelineTranscriptionForProject(_projectId: string) {
  const uri = cacheUri();
  if (!uri) return;
  // This is a single global slot. Clear every copy, including legacy records
  // that have no project ID and interrupted writes that could contain audio text.
  for (const candidate of [`${uri}.writing`, `${uri}.previous`, uri]) {
    await FileSystem.deleteAsync(candidate, { idempotent: true });
  }
}
