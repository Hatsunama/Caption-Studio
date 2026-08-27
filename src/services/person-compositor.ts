import * as FileSystem from 'expo-file-system/legacy';

import CaptionMedia from 'caption-media';
import { resolvePersonTransform } from '@/lib/person-motion';
import { requireBackgroundProcessingConsent } from '@/services/background-processing-consent';
import type { BackgroundReplacement, CaptionProject } from '@/types/project';

const previousPreviewByProject = new Map<string, string>();

type PreviewOptions = {
  projectId: string;
  videoUri: string;
  sourceTimeMs: number;
  timelineTimeMs: number;
  background: BackgroundReplacement;
  outputSize: { width: number; height: number };
  videoTransform: CaptionProject['videoTransform'];
};

type PreviewJob = {
  options: PreviewOptions;
  resolve: (uri: string) => void;
  reject: (reason: Error) => void;
};

type PreviewQueue = {
  generation: number;
  running: boolean;
  pending?: PreviewJob;
};

const previewQueues = new Map<string, PreviewQueue>();

export function renderPersonPreview(options: PreviewOptions) {
  return new Promise<string>((resolve, reject) => {
    const queue = previewQueues.get(options.projectId) ?? { generation: 0, running: false };
    previewQueues.set(options.projectId, queue);
    const job = { options, resolve, reject };
    if (queue.running) {
      queue.pending?.reject(new Error('The person preview was superseded by a newer frame.'));
      queue.pending = job;
      return;
    }
    void runPreviewJob(queue, job);
  });
}

async function runPreviewJob(queue: PreviewQueue, job: PreviewJob) {
  queue.running = true;
  const generation = queue.generation;
  try {
    job.resolve(await renderPersonPreviewNow(job.options, generation));
  } catch (caught) {
    job.reject(caught instanceof Error ? caught : new Error('Background preview failed.'));
  } finally {
    const next = queue.pending;
    queue.pending = undefined;
    if (next) {
      void runPreviewJob(queue, next);
    } else {
      queue.running = false;
      if (previewQueues.get(job.options.projectId) === queue) previewQueues.delete(job.options.projectId);
    }
  }
}

async function renderPersonPreviewNow(options: PreviewOptions, generation: number) {
  await requireBackgroundProcessingConsent();
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
      backgroundTimeMs: options.timelineTimeMs,
      qualityPreset: options.background.mask.qualityPreset,
      threshold: options.background.mask.threshold,
      softness: options.background.mask.softness,
      temporalStability: options.background.mask.temporalStability,
      edgeFeather: options.background.mask.edgeFeather,
      positionX: transform.position.x,
      positionY: transform.position.y,
      scale: transform.scale,
      rotation: transform.rotation,
      outputWidth: Math.max(2, Math.round(options.outputSize.width)),
      outputHeight: Math.max(2, Math.round(options.outputSize.height)),
      videoFit: options.videoTransform.fit,
      videoPositionX: options.videoTransform.position.x,
      videoPositionY: options.videoTransform.position.y,
      videoScale: options.videoTransform.scale,
      videoRotation: options.videoTransform.rotation,
    },
  );
  if (previewQueues.get(options.projectId)?.generation !== generation) {
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
  const queue = previewQueues.get(projectId);
  if (queue) {
    queue.generation += 1;
    queue.pending?.reject(new Error('The person preview was cancelled.'));
    queue.pending = undefined;
  }
  const previous = previousPreviewByProject.get(projectId);
  previousPreviewByProject.delete(projectId);
  await CaptionMedia.resetPersonSegmentation();
  if (previous) await FileSystem.deleteAsync(previous, { idempotent: true });
}

function safe(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}
