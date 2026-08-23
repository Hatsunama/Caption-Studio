import * as FileSystem from 'expo-file-system/legacy';

import CaptionMedia from '../../modules/caption-media/src/CaptionMediaModule';

export async function ensureProjectThumbnail(options: {
  projectId: string;
  sourceId: string;
  videoUri: string;
  thumbnailUri?: string;
}): Promise<string | undefined> {
  if (options.thumbnailUri) {
    const existing = await FileSystem.getInfoAsync(options.thumbnailUri);
    if (existing.exists && !existing.isDirectory) return options.thumbnailUri;
  }
  return generateProjectThumbnail(options.projectId, options.sourceId, options.videoUri);
}

export async function generateProjectThumbnail(projectId: string, sourceId: string, videoUri: string) {
  if (!FileSystem.documentDirectory) return undefined;
  const outputUri = `${FileSystem.documentDirectory}projects/${projectId}/source-${safePathSegment(sourceId)}.jpg`;
  try {
    await CaptionMedia.generateVideoThumbnail(videoUri, outputUri, 0);
    const generated = await FileSystem.getInfoAsync(outputUri);
    return generated.exists && !generated.isDirectory ? outputUri : undefined;
  } catch {
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

export async function validateProjectSource(videoUri: string) {
  const info = await CaptionMedia.getMediaInfo(videoUri);
  if (info.durationMs <= 0) throw new Error('The source is not a readable video.');
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
  const extension = options.fileName.match(/\.([a-zA-Z0-9]{2,5})$/)?.[1]?.toLowerCase() ?? 'jpg';
  const directory = `${FileSystem.documentDirectory}projects/${options.projectId}/overlays/`;
  const destinationUri = `${directory}${options.imageId}.${extension}`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  await FileSystem.copyAsync({ from: options.sourceUri, to: destinationUri });
  const stored = await FileSystem.getInfoAsync(destinationUri);
  if (!stored.exists || stored.isDirectory || stored.size <= 0) {
    throw new Error('The selected image could not be saved in this project.');
  }
  return destinationUri;
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
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  await FileSystem.copyAsync({ from: options.sourceUri, to: destinationUri });
  await validateStoredAudio(destinationUri);
  return destinationUri;
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
