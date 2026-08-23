import * as FileSystem from 'expo-file-system/legacy';

import CaptionMedia from '../../modules/caption-media/src/CaptionMediaModule';
import { resolvePersonTransform } from '@/lib/person-motion';
import type { BackgroundReplacement } from '@/types/project';

const previousPreviewByProject = new Map<string, string>();

export async function renderPersonPreview(options: {
  projectId: string;
  videoUri: string;
  sourceTimeMs: number;
  timelineTimeMs: number;
  background: BackgroundReplacement;
}) {
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
  const previous = previousPreviewByProject.get(options.projectId);
  previousPreviewByProject.set(options.projectId, outputUri);
  if (previous && previous !== outputUri) {
    await FileSystem.deleteAsync(previous, { idempotent: true });
  }
  return outputUri;
}

export async function resetPersonPreviewPipeline() {
  await CaptionMedia.resetPersonSegmentation();
}

function safe(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}
