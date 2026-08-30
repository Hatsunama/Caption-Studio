import * as FileSystem from 'expo-file-system/legacy';

import CaptionMedia from 'caption-media';
import { assertSupportedVideo } from '@/lib/media-validation';

const MAX_STORED_IMAGE_BYTES = 50 * 1024 * 1024;
const PROJECT_POSTER_VERSION = 3;

const ORPHAN_DIRECTORY_GRACE_SECONDS = 24 * 60 * 60;

export async function ensureProjectThumbnail(options: {
  projectId: string;
  sourceId: string;
  videoUri: string;
  thumbnailUri?: string;
}): Promise<string | undefined> {
  if (options.thumbnailUri?.endsWith(`-poster-v${PROJECT_POSTER_VERSION}.jpg`)) {
    const existing = await FileSystem.getInfoAsync(options.thumbnailUri);
    if (existing.exists && !existing.isDirectory) return options.thumbnailUri;
  }
  return generateProjectThumbnail(options.projectId, options.sourceId, options.videoUri);
}

export async function generateProjectThumbnail(projectId: string, sourceId: string, videoUri: string) {
  if (!FileSystem.documentDirectory) return undefined;
  const outputUri = `${FileSystem.documentDirectory}projects/${projectId}/source-${safePathSegment(sourceId)}-poster-v${PROJECT_POSTER_VERSION}.jpg`;
  try {
    await CaptionMedia.generateVideoThumbnail(videoUri, outputUri, 0);
    const generated = await FileSystem.getInfoAsync(outputUri);
    return generated.exists && !generated.isDirectory ? outputUri : undefined;
  } catch {
    await FileSystem.deleteAsync(outputUri, { idempotent: true }).catch(() => undefined);
    return undefined;
  }
}

export async function deleteProjectFiles(projectId: string) {
  if (!FileSystem.documentDirectory) return;
  const projectUri = `${FileSystem.documentDirectory}projects/${safePathSegment(projectId)}/`;
  const info = await FileSystem.getInfoAsync(projectUri);
  if (info.exists) await FileSystem.deleteAsync(projectUri, { idempotent: true });
}

export async function deleteProjectOwnedFiles(projectId: string, uris: string[]) {
  if (!FileSystem.documentDirectory) return;
  const projectUri = `${FileSystem.documentDirectory}projects/${safePathSegment(projectId)}/`;
  for (const uri of uris) {
    if (!uri.startsWith(projectUri)) continue;
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists && !info.isDirectory) await FileSystem.deleteAsync(uri, { idempotent: true });
  }
}

export async function reconcileProjectOwnedFiles(projectId: string, retainedUris: Iterable<string>) {
  if (!FileSystem.documentDirectory) return;
  const projectUri = `${FileSystem.documentDirectory}projects/${safePathSegment(projectId)}/`;
  const projectInfo = await FileSystem.getInfoAsync(projectUri);
  if (!projectInfo.exists || !projectInfo.isDirectory) return;
  const retained = new Set([...retainedUris].filter((uri) => uri.startsWith(projectUri)));
  await removeUnreferencedFiles(projectUri, retained);
}

export async function reconcileOrphanedProjectDirectories(retainedProjectIds: Iterable<string>) {
  if (!FileSystem.documentDirectory) return;
  const projectsUri = `${FileSystem.documentDirectory}projects/`;
  const projectsInfo = await FileSystem.getInfoAsync(projectsUri);
  if (!projectsInfo.exists || !projectsInfo.isDirectory) return;
  const retainedDirectories = new Set([...retainedProjectIds].map(safePathSegment));
  const entries = await FileSystem.readDirectoryAsync(projectsUri);
  for (const name of entries) {
    if (retainedDirectories.has(name) || !/^project-[a-zA-Z0-9._-]+$/.test(name)) continue;
    const uri = `${projectsUri}${name}`;
    const info = await FileSystem.getInfoAsync(uri);
    if (
      info.exists
      && info.isDirectory
      && Date.now() / 1000 - info.modificationTime >= ORPHAN_DIRECTORY_GRACE_SECONDS
    ) {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    }
  }
}

async function removeUnreferencedFiles(directoryUri: string, retained: ReadonlySet<string>) {
  const entries = await FileSystem.readDirectoryAsync(directoryUri);
  for (const name of entries) {
    const uri = `${directoryUri}${name}`;
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) continue;
    if (info.isDirectory) {
      await removeUnreferencedFiles(`${uri}/`, retained);
    } else if (!retained.has(uri)) {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    }
  }
}

export async function validateProjectSource(videoUri: string) {
  const info = await CaptionMedia.getMediaInfo(videoUri);
  assertSupportedVideo(info, 'The source');
}

export async function validateProjectSources(sources: { uri: string; displayName: string }[]) {
  for (const source of sources) {
    try {
      await validateProjectSource(source.uri);
    } catch (error) {
      throw new Error(`${source.displayName}: ${error instanceof Error ? error.message : 'The source is unavailable.'}`);
    }
  }
}

function safePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export async function storeProjectImage(options: {
  projectId: string;
  imageId: string;
  sourceUri: string;
  fileName: string;
}) {
  if (!FileSystem.documentDirectory) throw new Error('Permanent app storage is unavailable on this device.');
  const directory = `${FileSystem.documentDirectory}projects/${safePathSegment(options.projectId)}/overlays/`;
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const stagingUri = `${directory}.staging-${safePathSegment(options.imageId)}-${nonce}`;
  let destinationUri: string | undefined;
  let committed = false;
  try {
    const source = await FileSystem.getInfoAsync(options.sourceUri);
    if (source.exists && !source.isDirectory && source.size > MAX_STORED_IMAGE_BYTES) {
      throw new Error('This image is larger than the 50 MB import limit. Choose an optimized image.');
    }
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    await FileSystem.copyAsync({ from: options.sourceUri, to: stagingUri });
    const staged = await FileSystem.getInfoAsync(stagingUri);
    if (!staged.exists || staged.isDirectory || staged.size <= 0) {
      throw new Error('The selected image could not be saved in this project.');
    }
    if (staged.size > MAX_STORED_IMAGE_BYTES) {
      throw new Error('This image is larger than the 50 MB import limit. Choose an optimized image.');
    }
    const validation = await CaptionMedia.validateImageFile(stagingUri);
    const extension = imageExtension(validation.mimeType);
    destinationUri = `${directory}${safePathSegment(options.imageId)}-${nonce}.${extension}`;
    const existing = await FileSystem.getInfoAsync(destinationUri);
    if (existing.exists) throw new Error('Caption Studio could not allocate a unique image file. Try again.');
    await FileSystem.moveAsync({ from: stagingUri, to: destinationUri });
    committed = true;
    return destinationUri;
  } catch (error) {
    throw error;
  } finally {
    await FileSystem.deleteAsync(stagingUri, { idempotent: true }).catch(() => undefined);
    if (!committed && destinationUri) {
      await FileSystem.deleteAsync(destinationUri, { idempotent: true }).catch(() => undefined);
    }
  }
}

function imageExtension(mimeType: string) {
  const extensions: Record<string, string> = {
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/gif': 'gif',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  };
  const extension = extensions[mimeType.toLowerCase()];
  if (!extension) throw new Error('The selected image format is not supported.');
  return extension;
}

export async function storeProjectAudio(options: {
  projectId: string;
  audioId: string;
  sourceUri: string;
  fileName: string;
}) {
  if (!FileSystem.documentDirectory) throw new Error('Permanent app storage is unavailable on this device.');
  const extension = options.fileName.match(/\.([a-zA-Z0-9]{2,5})$/)?.[1]?.toLowerCase() ?? 'm4a';
  const directory = `${FileSystem.documentDirectory}projects/${safePathSegment(options.projectId)}/audio/`;
  const destinationUri = `${directory}${safePathSegment(options.audioId)}.${extension}`;
  try {
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    await FileSystem.copyAsync({ from: options.sourceUri, to: destinationUri });
    await validateStoredAudio(destinationUri);
    return destinationUri;
  } catch (error) {
    await FileSystem.deleteAsync(destinationUri, { idempotent: true }).catch(() => undefined);
    throw error;
  }
}

export async function prepareExtractedAudioUri(projectId: string, audioId: string) {
  if (!FileSystem.documentDirectory) throw new Error('Permanent app storage is unavailable on this device.');
  const directory = `${FileSystem.documentDirectory}projects/${safePathSegment(projectId)}/audio/`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  return `${directory}${safePathSegment(audioId)}.m4a`;
}

async function validateStoredAudio(uri: string) {
  const stored = await FileSystem.getInfoAsync(uri);
  if (!stored.exists || stored.isDirectory || stored.size <= 0) {
    throw new Error('The selected audio could not be saved in this project.');
  }
  const media = await CaptionMedia.getMediaInfo(uri);
  if (!media.hasAudio || media.durationMs < 80) {
    await FileSystem.deleteAsync(uri, { idempotent: true });
    throw new Error('The selected file does not contain usable audio.');
  }
  return media;
}
