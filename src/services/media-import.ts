import * as DocumentPicker from 'expo-document-picker';

import CaptionMedia from '../../modules/caption-media/src/CaptionMediaModule';
import { MINIMUM_CLIP_TIMELINE_MS } from '@/lib/video-timeline';
import {
  deleteProjectOwnedFiles,
  generateProjectThumbnail,
  prepareExtractedAudioUri,
  storeProjectAudio,
  storeProjectImage,
} from '@/services/project-media';
import { requireFreeSpace } from '@/services/storage-policy';
import type { ProjectAudioSource, ProjectVideoSource } from '@/types/project';

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
      try {
        await CaptionMedia.persistReadPermission(asset.uri);
      } catch {
        throw new Error(`Android did not grant lasting access to ${asset.name}. Select it from Files or Photos and try again.`);
      }
      const info = await CaptionMedia.getMediaInfo(asset.uri);
      if (info.durationMs < MINIMUM_CLIP_TIMELINE_MS) {
        throw new Error(`${asset.name} is shorter than ${MINIMUM_CLIP_TIMELINE_MS / 1000} seconds and cannot be edited reliably.`);
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
      });
      onProgress?.({
        stage: 'loading',
        completed: index + 1,
        total: result.assets.length,
        detail: `Loaded video ${index + 1} of ${result.assets.length}`,
      });
    }
  } catch (error) {
    await deleteProjectOwnedFiles(
      projectId,
      sources.map((source) => source.thumbnailUri).filter((uri): uri is string => Boolean(uri)),
    );
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
  const uri = await storeProjectImage({
    projectId,
    imageId,
    sourceUri: asset.uri,
    fileName: asset.name,
  });
  return { uri, name: asset.name };
}

export async function pickAndStoreAudio(projectId: string, audioId: string): Promise<ProjectAudioSource | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'audio/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  const uri = await storeProjectAudio({
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
}

export async function pickVideoAndExtractAudio(projectId: string, audioId: string): Promise<ProjectAudioSource | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'video/*',
    copyToCacheDirectory: false,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  await CaptionMedia.persistReadPermission(asset.uri);
  const sourceInfo = await CaptionMedia.getMediaInfo(asset.uri);
  if (!sourceInfo.hasAudio) throw new Error(`${asset.name} does not contain an audio track.`);
  const outputUri = await prepareExtractedAudioUri(projectId, audioId);
  try {
    const extraction = await CaptionMedia.extractAudioTrack(asset.uri, outputUri);
    const storedInfo = await CaptionMedia.getMediaInfo(outputUri);
    return {
      id: audioId,
      uri: outputUri,
      storageMode: 'copied',
      displayName: `${cleanAudioName(asset.name)} audio`,
      durationMs: storedInfo.durationMs || extraction.durationMs,
      mimeType: extraction.mimeType,
      origin: 'video-audio',
    };
  } catch (error) {
    await deleteProjectOwnedFiles(projectId, [outputUri]);
    throw error;
  }
}

function cleanAudioName(name: string) {
  return name.replace(/\.[a-zA-Z0-9]{2,5}$/, '').replace(/[_-]+/g, ' ').trim() || 'Audio';
}
