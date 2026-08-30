import * as DocumentPicker from 'expo-document-picker';

import CaptionMedia from 'caption-media';
import { assertSupportedVideo } from '@/lib/media-validation';
import { classifyPickedMedia } from '@/lib/picked-media-kind';
import { MINIMUM_CLIP_TIMELINE_MS } from '@/lib/video-timeline';
import {
  deleteProjectOwnedFiles,
  generateProjectThumbnail,
  prepareExtractedAudioUri,
  storeProjectAudio,
  storeProjectImage,
} from '@/services/project-media';
import { releaseReadPermissions } from '@/services/media-permissions';
import { requireFreeSpace } from '@/services/storage-policy';
import type { BackgroundReplacement, ProjectAudioSource, ProjectVideoSource } from '@/types/project';

const MIN_IMPORT_HEADROOM_BYTES = 32 * 1024 * 1024;

export type MediaImportProgress = {
  stage: 'loading' | 'saving';
  completed: number;
  total: number;
  detail: string;
};

export async function pickLinkedVideos(
  projectId: string,
  onProgress?: (progress: MediaImportProgress) => void,
): Promise<ProjectVideoSource[] | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'video/*',
    copyToCacheDirectory: false,
    multiple: true,
  });
  if (result.canceled) return null;
  if (result.assets.length === 0) throw new Error('No videos were returned by the Android picker.');

  onProgress?.({
    stage: 'loading',
    completed: 0,
    total: result.assets.length,
    detail: `Preparing ${result.assets.length === 1 ? 'your video' : `${result.assets.length} videos`}`,
  });
  await requireFreeSpace(MIN_IMPORT_HEADROOM_BYTES, 'import a video');
  const sources: ProjectVideoSource[] = [];
  const persistedUris: string[] = [];
  try {
    for (let index = 0; index < result.assets.length; index += 1) {
      const asset = result.assets[index];
      const sourceId = `source-${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${index}`;
      onProgress?.({
        stage: 'loading',
        completed: index,
        total: result.assets.length,
        detail: `Loading video ${index + 1} of ${result.assets.length}`,
      });
      const info = await probeVideoForImport(asset.uri, asset.name);
      if (info.durationMs < MINIMUM_CLIP_TIMELINE_MS) {
        throw new Error(`${asset.name} is shorter than ${MINIMUM_CLIP_TIMELINE_MS / 1000} seconds and cannot be edited reliably.`);
      }
      try {
        await CaptionMedia.persistReadPermission(asset.uri);
        persistedUris.push(asset.uri);
      } catch {
        throw new Error(`Android did not grant lasting access to ${asset.name}. Select it from Files or Photos and try again.`);
      }
      sources.push({
        id: sourceId,
        uri: asset.uri,
        storageMode: 'linked',
        thumbnailUri: await generateProjectThumbnail(projectId, sourceId, asset.uri),
        displayName: asset.name,
        mimeType: asset.mimeType,
        sizeBytes: asset.size,
        durationMs: info.durationMs,
        width: info.width,
        height: info.height,
        rotation: info.rotation,
        frameRate: info.frameRate,
      });
      onProgress?.({
        stage: 'loading',
        completed: index + 1,
        total: result.assets.length,
        detail: `Loaded video ${index + 1} of ${result.assets.length}`,
      });
    }
  } catch (error) {
    await Promise.allSettled([
      deleteProjectOwnedFiles(
        projectId,
        sources.map((source) => source.thumbnailUri).filter((uri): uri is string => Boolean(uri)),
      ),
      releaseReadPermissions(persistedUris),
    ]);
    throw error;
  }
  return sources;
}

export async function pickAndStoreImage(projectId: string, imageId: string) {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'image/*',
    copyToCacheDirectory: false,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  await requireFreeSpace((asset.size ?? MIN_IMPORT_HEADROOM_BYTES) + MIN_IMPORT_HEADROOM_BYTES, 'add this image');
  const uri = await storeProjectImage({
    projectId,
    imageId,
    sourceUri: asset.uri,
    fileName: asset.name,
  });
  return { uri, name: asset.name };
}

export async function pickBackgroundMedia(projectId: string): Promise<BackgroundReplacement['source'] | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['image/*', 'video/*'],
    copyToCacheDirectory: false,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  const declaredKind = classifyPickedMedia(asset.mimeType, asset.name);
  let probedVideoInfo;
  if (declaredKind === 'video' || declaredKind === 'unknown') {
    try {
      const info = await probeVideoForImport(asset.uri, asset.name);
      probedVideoInfo = info;
    } catch (error) {
      if (declaredKind === 'video') throw error;
      throw new Error(`Caption Studio could not identify ${asset.name} as an image or video. Choose a supported image or video file.`);
    }
  }
  const isVideo = Boolean(probedVideoInfo);
  if (isVideo) {
    try {
      await CaptionMedia.persistReadPermission(asset.uri);
    } catch {
      throw new Error(`Android did not grant lasting access to ${asset.name}. Select it from Files or Photos and try again.`);
    }
    try {
      return { kind: 'video', uri: asset.uri, storageMode: 'linked', displayName: asset.name };
    } catch (error) {
      await releaseReadPermissions([asset.uri]);
      throw error;
    }
  }
  await requireFreeSpace((asset.size ?? MIN_IMPORT_HEADROOM_BYTES) + MIN_IMPORT_HEADROOM_BYTES, 'add this background image');
  const stored = await pickAndStoreSpecificImage(projectId, `background-${Date.now()}`, asset.uri, asset.name);
  return { kind: 'image', uri: stored.uri, storageMode: 'copied', displayName: stored.name };
}

async function pickAndStoreSpecificImage(projectId: string, imageId: string, sourceUri: string, name: string) {
  const uri = await storeProjectImage({ projectId, imageId, sourceUri, fileName: name });
  return { uri, name };
}

export async function pickAndStoreAudio(projectId: string, audioId: string): Promise<ProjectAudioSource | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'audio/*',
    copyToCacheDirectory: false,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  await requireFreeSpace((asset.size ?? MIN_IMPORT_HEADROOM_BYTES) + MIN_IMPORT_HEADROOM_BYTES, 'add this audio');
  let uri: string | undefined;
  try {
    uri = await storeProjectAudio({
      projectId,
      audioId,
      sourceUri: asset.uri,
      fileName: asset.name,
    });
    const info = await CaptionMedia.getMediaInfo(uri);
    return {
      id: audioId,
      uri,
      storageMode: 'copied',
      displayName: cleanAudioName(asset.name),
      durationMs: info.durationMs,
      mimeType: asset.mimeType,
      origin: 'audio-file',
    };
  } catch (error) {
    if (uri) await deleteProjectOwnedFiles(projectId, [uri]).catch(() => undefined);
    throw error;
  }
}

export async function pickVideoAndExtractAudio(projectId: string, audioId: string): Promise<ProjectAudioSource | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'video/*',
    copyToCacheDirectory: false,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  const sourceInfo = await probeVideoForImport(asset.uri, asset.name);
  await CaptionMedia.persistReadPermission(asset.uri);
  try {
    return await extractAudioFromVideo(projectId, audioId, asset.uri, asset.name, sourceInfo);
  } finally {
    await releaseReadPermissions([asset.uri]);
  }
}

export async function extractAudioFromProjectVideo(
  projectId: string,
  audioId: string,
  source: ProjectVideoSource,
): Promise<ProjectAudioSource> {
  const sourceInfo = await probeVideoForImport(source.uri, source.displayName);
  return extractAudioFromVideo(projectId, audioId, source.uri, source.displayName, sourceInfo);
}

async function extractAudioFromVideo(
  projectId: string,
  audioId: string,
  sourceUri: string,
  displayName: string,
  sourceInfo: Awaited<ReturnType<typeof probeVideoForImport>>,
) {
  if (!sourceInfo.hasAudio) throw new Error(`${displayName} does not contain an audio track.`);
  const estimatedAudioBytes = Math.ceil(sourceInfo.durationMs / 1000) * 64 * 1024;
  await requireFreeSpace(estimatedAudioBytes + MIN_IMPORT_HEADROOM_BYTES, 'extract this audio');
  const outputUri = await prepareExtractedAudioUri(projectId, audioId);
  try {
    const extraction = await CaptionMedia.extractAudioTrack(sourceUri, outputUri);
    const storedInfo = await CaptionMedia.getMediaInfo(outputUri);
    return {
      id: audioId,
      uri: outputUri,
      storageMode: 'copied' as const,
      displayName: `${cleanAudioName(displayName)} audio`,
      durationMs: storedInfo.durationMs || extraction.durationMs,
      mimeType: extraction.mimeType,
      origin: 'video-audio' as const,
    };
  } catch (error) {
    await deleteProjectOwnedFiles(projectId, [outputUri]).catch(() => undefined);
    throw error;
  }
}

function cleanAudioName(name: string) {
  return name.replace(/\.[a-zA-Z0-9]{2,5}$/, '').replace(/[_-]+/g, ' ').trim() || 'Audio';
}

async function probeVideoForImport(uri: string, displayName: string) {
  try {
    const info = await CaptionMedia.getMediaInfo(uri);
    assertSupportedVideo(info, displayName);
    return info;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(displayName)) throw error;
    throw new Error(`${displayName} could not be opened as a supported video on this phone.`);
  }
}
