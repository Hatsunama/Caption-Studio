import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { getRawProjectRecord } from '@/services/database';
import {
  createProjectRecoveryCacheFileName,
  isCaptionStudioRecoveryCacheArtifact,
  isStaleCaptionStudioRecoveryCacheArtifact,
} from '@/services/project-recovery-policy';

const RECOVERY_CACHE_FOLDER = 'project-recovery/';

export async function shareProjectRecoveryRecord(projectId: string, projectName: string) {
  if (!FileSystem.cacheDirectory) throw new Error('Recovery storage is unavailable on this device.');
  const raw = await getRawProjectRecord(projectId);
  if (raw == null) throw new Error('This project record no longer exists.');
  if (!await Sharing.isAvailableAsync()) throw new Error('Android file sharing is unavailable on this device.');
  const directory = recoveryCacheDirectoryUri();
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  await cleanupStaleProjectRecoveryCache();
  const uri = `${directory}${createProjectRecoveryCacheFileName(projectName)}`;
  let shareFailure: unknown;
  try {
    await FileSystem.writeAsStringAsync(uri, raw, { encoding: FileSystem.EncodingType.UTF8 });
    await Sharing.shareAsync(uri, {
      mimeType: 'application/json',
      dialogTitle: 'Save Caption Studio recovery copy',
      UTI: 'public.json',
    });
  } catch (error) {
    shareFailure = error;
  } finally {
    try {
      await deleteOwnedRecoveryArtifact(uri);
    } catch (cleanupError) {
      if (shareFailure) {
        console.warn('Could not remove the temporary project recovery file.', cleanupError);
      } else {
        throw cleanupError;
      }
    }
  }
  if (shareFailure) throw shareFailure;
}

export async function cleanupStaleProjectRecoveryCache(nowMs = Date.now()) {
  if (!FileSystem.cacheDirectory) return;
  const directory = recoveryCacheDirectoryUri();
  const directoryInfo = await FileSystem.getInfoAsync(directory);
  if (!directoryInfo.exists || !directoryInfo.isDirectory) return;
  let entries: string[];
  try {
    entries = await FileSystem.readDirectoryAsync(directory);
  } catch {
    return;
  }
  await Promise.allSettled(entries.map(async (fileName) => {
    if (!isCaptionStudioRecoveryCacheArtifact(fileName)) return;
    const uri = `${directory}${fileName}`;
    const info = await FileSystem.getInfoAsync(uri);
    if (
      info.exists
      && !info.isDirectory
      && isStaleCaptionStudioRecoveryCacheArtifact(fileName, info.modificationTime, nowMs)
    ) await FileSystem.deleteAsync(uri, { idempotent: true });
  }));
}

function recoveryCacheDirectoryUri() {
  if (!FileSystem.cacheDirectory) throw new Error('Recovery storage is unavailable on this device.');
  return `${FileSystem.cacheDirectory}${RECOVERY_CACHE_FOLDER}`;
}

async function deleteOwnedRecoveryArtifact(uri: string) {
  const directory = recoveryCacheDirectoryUri();
  if (!uri.startsWith(directory)) return;
  const fileName = uri.slice(directory.length);
  if (!isCaptionStudioRecoveryCacheArtifact(fileName)) return;
  const info = await FileSystem.getInfoAsync(uri);
  if (info.exists && !info.isDirectory) await FileSystem.deleteAsync(uri, { idempotent: true });
}
