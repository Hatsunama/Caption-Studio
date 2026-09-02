import * as FileSystem from 'expo-file-system/legacy';

import {
  isCaptionStudioExportCacheArtifact,
  isLegacyCaptionStudioExportCacheArtifact,
  isStaleCaptionStudioExportCacheArtifact,
  isStaleLegacyCaptionStudioExportCacheArtifact,
} from '@/services/export-storage-policy';

export {
  assertVideoExportDelivery,
  createExportCacheFileName,
  estimateVideoExportStorageBytes,
  isCaptionStudioExportCacheArtifact,
  isLegacyCaptionStudioExportCacheArtifact,
  isStaleCaptionStudioExportCacheArtifact,
  isStaleLegacyCaptionStudioExportCacheArtifact,
} from '@/services/export-storage-policy';

const EXPORT_CACHE_FOLDER = 'caption-studio-exports/';
const LEGACY_EXPORT_CACHE_FOLDER = 'exports/';
const protectedArtifactNames = new Set<string>();

export function exportCacheDirectoryUri(): string {
  if (!FileSystem.cacheDirectory) throw new Error('Export storage is unavailable on this device.');
  return `${FileSystem.cacheDirectory}${EXPORT_CACHE_FOLDER}`;
}

export async function prepareCaptionStudioExportCache(nowMs = Date.now()): Promise<string> {
  const directory = exportCacheDirectoryUri();
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  await Promise.allSettled([
    cleanupStaleDirectory(
      directory,
      nowMs,
      isCaptionStudioExportCacheArtifact,
      isStaleCaptionStudioExportCacheArtifact,
    ),
    cleanupLegacyExportCache(nowMs),
  ]);
  return directory;
}

async function cleanupLegacyExportCache(nowMs: number) {
  if (!FileSystem.cacheDirectory) return;
  const directory = `${FileSystem.cacheDirectory}${LEGACY_EXPORT_CACHE_FOLDER}`;
  const info = await FileSystem.getInfoAsync(directory);
  if (!info.exists || !info.isDirectory) return;
  await cleanupStaleDirectory(
    directory,
    nowMs,
    isLegacyCaptionStudioExportCacheArtifact,
    isStaleLegacyCaptionStudioExportCacheArtifact,
  );
}

async function cleanupStaleDirectory(
  directory: string,
  nowMs: number,
  ownsArtifact: (fileName: string) => boolean,
  isStale: (fileName: string, modificationTimeSeconds: number | undefined, nowMs: number) => boolean,
) {
  let entries: string[];
  try {
    entries = await FileSystem.readDirectoryAsync(directory);
  } catch {
    return;
  }
  await Promise.allSettled(entries.map(async (fileName) => {
    if (!ownsArtifact(fileName) || protectedArtifactNames.has(fileName)) return;
    const uri = `${directory}${fileName}`;
    const info = await FileSystem.getInfoAsync(uri);
    if (
      info.exists
      && !info.isDirectory
      && isStale(fileName, info.modificationTime, nowMs)
    ) {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    }
  }));
}

export function protectTemporaryVideoExportArtifacts(outputUri: string): () => void {
  let names: string[] = [];
  try {
    const directory = exportCacheDirectoryUri();
    if (!outputUri.startsWith(directory)) return () => {};
    const fileName = outputUri.slice(directory.length);
    if (!isCaptionStudioExportCacheArtifact(fileName) || !fileName.endsWith('.mp4')) return () => {};
    names = [fileName, `.${fileName.slice(0, -4)}-base.png`];
    names.forEach((name) => protectedArtifactNames.add(name));
  } catch {
    return () => {};
  }
  return () => names.forEach((name) => protectedArtifactNames.delete(name));
}

export async function removeTemporaryVideoExportArtifacts(outputUri: string): Promise<void> {
  try {
    const directory = exportCacheDirectoryUri();
    if (!outputUri.startsWith(directory)) return;
    const fileName = outputUri.slice(directory.length);
    if (!isCaptionStudioExportCacheArtifact(fileName) || !fileName.endsWith('.mp4')) return;
    const baseFrameName = `.${fileName.slice(0, -4)}-base.png`;
    await Promise.allSettled([
      deleteOwnedArtifact(directory, fileName),
      deleteOwnedArtifact(directory, baseFrameName),
    ]);
  } catch {
    return;
  }
}

export async function removeFailedSubtitleExportArtifact(uri: string): Promise<void> {
  try {
    const directory = exportCacheDirectoryUri();
    if (!uri.startsWith(directory)) return;
    const fileName = uri.slice(directory.length);
    if (!isCaptionStudioExportCacheArtifact(fileName) || (!fileName.endsWith('.srt') && !fileName.endsWith('.ass'))) return;
    await deleteOwnedArtifact(directory, fileName).catch(() => undefined);
  } catch {
    return;
  }
}

async function deleteOwnedArtifact(directory: string, fileName: string) {
  if (!isCaptionStudioExportCacheArtifact(fileName)) return;
  const uri = `${directory}${fileName}`;
  const info = await FileSystem.getInfoAsync(uri);
  if (info.exists && !info.isDirectory) await FileSystem.deleteAsync(uri, { idempotent: true });
}
