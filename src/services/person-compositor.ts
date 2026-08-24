import * as FileSystem from 'expo-file-system/legacy';

import CaptionMedia from 'caption-media';
import { resolvePersonTransform } from '@/lib/person-motion';
import type { BackgroundReplacement } from '@/types/project';

const previousPreviewByProject = new Map<string, string>();
let previewEpoch = 0;

export async function renderPersonPreview(options: {
  projectId: string;
  videoUri: string;
  sourceTimeMs: number;
  timelineTimeMs: number;
  background: BackgroundReplacement;
}) {
  const epoch = previewEpoch;
  if (!FileSystem.cacheDirectory) throw new Error('Preview storage is unavailable.');
  const transform = resolvePersonTransform(options.background, options.timelineTimeMs);
  const directory = `${FileSystem.cacheDirectory}person-previews/${safe(options.projectId)}/`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const outputUri = `${directory}frame-${Math.round(options.timelineTimeMs)}-${Date.now()}.png`;
  await CaptionMedia.renderPersonPreviewFrame(
    options.videoUri,
    options.background.source?.uri ?? null,
    outputUri,
    {
      timeMs: options.sourceTimeMs,
      qualityPreset: options.background.mask.qualityPreset,
      threshold: options.background.mask.threshold,
      softness: options.background.mask.softness,
      temporalStability: options.background.mask.temporalStability,
      edgeFeather: options.background.mask.edgeFeather,
      positionX: transform.position.x,
      positionY: transform.position.y,
      scale: transform.scale,
      rotation: transform.rotation,
    },
  );
  if (epoch !== previewEpoch) {
    await FileSystem.deleteAsync(outputUri, { idempotent: true });
    throw new Error('The person preview was cancelled.');
  }
  const previous = previousPreviewByProject.get(options.projectId);
  previousPreviewByProject.set(options.projectId, outputUri);
  if (previous && previous !== outputUri) {
    await FileSystem.deleteAsync(previous, { idempotent: true });
  }
  return outputUri;
}

export async function releasePersonPreview(projectId: string) {
  previewEpoch += 1;
  const previous = previousPreviewByProject.get(projectId);
  previousPreviewByProject.delete(projectId);
  await CaptionMedia.resetPersonSegmentation();
  if (previous) await FileSystem.deleteAsync(previous, { idempotent: true });
}

function safe(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}
