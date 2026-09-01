import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import CaptionMedia from 'caption-media';
import type { TimelineVideoExportProgress } from 'caption-media';

import { buildTimelineRenderPlan, collectUnresolvedFontFamilies, toNativeRenderPlan } from '@/lib/export-render-plan';
import { serializeAss, serializeSrt, visibleCaptions } from '@/lib/subtitle-export';
import { requireBackgroundProcessingConsent } from '@/services/background-processing-consent';
import {
  assertCompletedVideoExport,
  createExportCacheFileName,
  estimateVideoExportStorageBytes,
  prepareCaptionStudioExportCache,
  protectTemporaryVideoExportArtifacts,
  removeFailedSubtitleExportArtifact,
  removeTemporaryVideoExportArtifacts,
} from '@/services/export-storage';
import { resolveExportFontUris } from '@/services/export-font-assets';
import { requireFreeSpace } from '@/services/storage-policy';
import { createVideoExportSession } from '@/services/video-export-session';
import type { CaptionProject } from '@/types/project';

const videoExportSession = createVideoExportSession(() => CaptionMedia.cancelTimelineVideoExport());

export async function exportProjectVideo(project: CaptionProject) {
  return videoExportSession.run(async (session) => {
    if (!FileSystem.cacheDirectory) throw new Error('Export storage is unavailable on this device.');
    const unresolvedPlan = buildTimelineRenderPlan(project);
    const directory = await session.waitFor(prepareCaptionStudioExportCache());
    await session.waitFor(requireFreeSpace(
      estimateVideoExportStorageBytes(unresolvedPlan),
      'export this video',
    ));
    if (project.backgroundReplacement.enabled && project.backgroundReplacement.source) {
      await session.waitFor(requireBackgroundProcessingConsent());
    }
    const canPublish = await session.waitFor(CaptionMedia.requestLegacyMediaWritePermission());
    if (!canPublish) throw new Error('Allow storage access so Caption Studio can save the export to your media library.');

    const fontUris = await session.waitFor(resolveExportFontUris(collectUnresolvedFontFamilies(unresolvedPlan)));
    const renderPlan = fontUris.size > 0 ? buildTimelineRenderPlan(project, fontUris) : unresolvedPlan;
    const outputUri = `${directory}${createExportCacheFileName(project.name, 'mp4')}`;
    const releaseArtifactProtection = protectTemporaryVideoExportArtifacts(outputUri);
    try {
      session.throwIfCancelled();
      const result = await session.startNative(() => CaptionMedia.exportTimelineVideo(
        outputUri.replace(/^file:\/\//, ''),
        toNativeRenderPlan(renderPlan),
      ));
      const outputInfo = await session.waitFor(FileSystem.getInfoAsync(outputUri));
      assertCompletedVideoExport(outputUri, result, outputInfo);
      if (!await session.waitFor(Sharing.isAvailableAsync())) {
        throw new Error('The video was saved to the media library, but Android file sharing is unavailable.');
      }
      await session.waitFor(Sharing.shareAsync(outputUri, {
        mimeType: 'video/mp4',
        dialogTitle: 'Save or share exported video',
        UTI: 'public.mpeg-4',
      }));
      return result;
    } finally {
      try {
        await removeTemporaryVideoExportArtifacts(outputUri);
      } finally {
        releaseArtifactProtection();
      }
    }
  });
}

export function cancelProjectVideoExport() {
  return videoExportSession.cancel();
}

export function getProjectVideoExportProgress(): Promise<TimelineVideoExportProgress> {
  return CaptionMedia.getTimelineVideoExportProgress();
}

export async function exportSubtitleFile(project: CaptionProject, format: 'srt' | 'ass') {
  if (!FileSystem.cacheDirectory) throw new Error('Export storage is unavailable on this device.');
  if (visibleCaptions(project).length === 0) throw new Error('Generate or add a visible caption before exporting subtitles.');
  const directory = await prepareCaptionStudioExportCache();
  const uri = `${directory}${createExportCacheFileName(project.name, format)}`;
  const content = format === 'srt' ? serializeSrt(project) : serializeAss(project);
  await requireFreeSpace(Math.max(1 * 1024 * 1024, content.length * 8), 'export these subtitles');
  try {
    await FileSystem.writeAsStringAsync(uri, content, { encoding: FileSystem.EncodingType.UTF8 });
    if (!await Sharing.isAvailableAsync()) throw new Error('Android file sharing is unavailable on this device.');
    await Sharing.shareAsync(uri, {
      mimeType: format === 'srt' ? 'application/x-subrip' : 'text/x-ssa',
      dialogTitle: `Save ${format.toUpperCase()} subtitles`,
      UTI: format === 'srt' ? 'public.text' : 'public.plain-text',
    });
    return uri;
  } catch (error) {
    await removeFailedSubtitleExportArtifact(uri);
    throw error;
  }
}

export function userFacingExportError(caught: unknown, fallback = 'The video could not be exported.'): string {
  if (!(caught instanceof Error)) return fallback;
  const firstLine = caught.message.split(/\r?\n/)[0]?.trim() ?? '';
  if (!firstLine) return fallback;
  if (/Cannot convert|Value is undefined, expected an Object|index\.android\.bundle|InternalBytecode/i.test(caught.message)) {
    return fallback;
  }
  const cleaned = firstLine.replace(/^\[[\w.]+\]\s*/, '');
  if (!cleaned || cleaned.length > 180) return fallback;
  return cleaned;
}
