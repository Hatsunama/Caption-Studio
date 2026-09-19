import * as DocumentPicker from 'expo-document-picker';

import CaptionMedia from 'caption-media';
import { assertSupportedVideo } from '@/lib/media-validation';
import { MINIMUM_CLIP_TIMELINE_MS } from '@/lib/video-timeline';
import {
  deleteProjectOwnedFiles,
  ensureProjectVideoPreview,
  generateProjectThumbnail,
  prepareExtractedAudioUri,
  storeProjectAudio,
  storeProjectImage,
} from '@/services/project-media';
import { releaseReadPermissions } from '@/services/media-permissions';
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
  await requireFreeSpace(MIN_IMPORT_HEADROOM_BYTES, 'import a video');
  const result = await CaptionMedia.pickVideoDocuments(true);
  if (result.canceled) return null;
  if (result.assets.length === 0) throw new Error('No videos were returned by the Android picker.');

  onProgress?.({
    stage: 'loading',
    completed: 0,
    total: result.assets.length,
    detail: `Preparing ${result.assets.length === 1 ? 'your video' : `${result.assets.length} videos`}`,
  });
  const sources: ProjectVideoSource[] = [];
  const persistedUris = result.assets.map((asset) => asset.uri);
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
      const thumbnailUri = await generateProjectThumbnail(projectId, sourceId, asset.uri);
      const previewUri = await ensureProjectVideoPreview({
        projectId,
        source: { id: sourceId, uri: asset.uri, durationMs: info.durationMs, width: info.width, height: info.height },
        onPreparing: () => onProgress?.({
          stage: 'loading',
          completed: index,
          total: result.assets.length,
          detail: `Optimizing video ${index + 1} of ${result.assets.length} for smooth editing`,
        }),
      });
      sources.push({
        id: sourceId,
        uri: asset.uri,
        previewUri,
        storageMode: 'linked',
        thumbnailUri,
        displayName: asset.name,
        mimeType: asset.mimeType ?? undefined,
        sizeBytes: asset.size ?? undefined,
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
        sources.flatMap((source) => [source.thumbnailUri, source.previewUri]).filter((uri): uri is string => Boolean(uri)),
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

export async function storeRecordedAudio(projectId: string, audioId: string, recordingUri: string): Promise<ProjectAudioSource> {
  const recording = await CaptionMedia.getMediaInfo(recordingUri);
  if (!recording.hasAudio || recording.durationMs < 80) {
    throw new Error('Record a little longer before adding a voice-over take.');
  }
  await requireFreeSpace(MIN_IMPORT_HEADROOM_BYTES, 'save this voice-over');
  let uri: string | undefined;
  try {
    uri = await storeProjectAudio({
      projectId,
      audioId,
      sourceUri: recordingUri,
      fileName: 'voice-over.m4a',
    });
    const info = await CaptionMedia.getMediaInfo(uri);
    return {
      id: audioId,
      uri,
      storageMode: 'copied',
      displayName: 'Voice over',
      durationMs: info.durationMs,
      mimeType: 'audio/mp4',
      origin: 'voiceover',
    };
  } catch (error) {
    if (uri) await deleteProjectOwnedFiles(projectId, [uri]).catch(() => undefined);
    throw error;
  }
}

export async function pickVideoAndExtractAudio(
  projectId: string,
  audioId: string,
  onSourceChosen?: () => void,
): Promise<ProjectAudioSource | null> {
  const result = await CaptionMedia.pickVideoDocuments(false);
  if (result.canceled) return null;
  const asset = result.assets[0];
  try {
    const sourceInfo = await probeVideoForImport(asset.uri, asset.name);
    onSourceChosen?.();
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
