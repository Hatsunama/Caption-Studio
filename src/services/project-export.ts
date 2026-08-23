import * as FileSystem from 'expo-file-system/legacy';
import CaptionMedia from 'caption-media';

import { totalClipDuration } from '@/lib/video-timeline';
import type { CaptionProject } from '@/types/project';

export async function exportBackgroundReplacement(project: CaptionProject) {
  const background = project.backgroundReplacement;
  if (!background.enabled || !background.source) throw new Error('Choose a replacement background before exporting.');
  if (project.clips.length !== 1) throw new Error('Background export currently requires one video clip. Multi-clip native composition is still being completed.');
  const clip = project.clips[0];
  if (clip.gapBeforeMs || clip.gapAfterMs || clip.playbackRate !== 1) {
    throw new Error('Background export currently requires a normal-speed clip without timeline gaps.');
  }
  const source = project.sources.find((candidate) => candidate.id === clip.sourceId);
  if (!source) throw new Error('The video source for this clip is unavailable.');
  if (!FileSystem.cacheDirectory) throw new Error('Export storage is unavailable on this device.');
  const directory = `${FileSystem.cacheDirectory}exports/`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const outputUri = `${directory}caption-studio-${Date.now()}.mp4`;
  const transform = background.personTransform;
  const result = await CaptionMedia.exportPersonVideo(source.uri, background.source.uri, outputUri.replace(/^file:\/\//, ''), {
    durationMs: totalClipDuration(project.clips),
    sourceStartMs: clip.sourceStartMs,
    backgroundKind: background.source.kind,
    threshold: background.mask.threshold,
    softness: background.mask.softness,
    temporalStability: background.mask.temporalStability,
    edgeFeather: background.mask.edgeFeather,
    positionX: transform.position.x,
    positionY: transform.position.y,
    scale: transform.scale,
    rotation: transform.rotation,
  });
  return result;
}
