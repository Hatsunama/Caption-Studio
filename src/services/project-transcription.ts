import { createTimelineTranscriptionSession } from '@/services/timeline-audio-render';
import CaptionMedia from 'caption-media';

import { groupTimelineWordsByClip, groupingOptionsForLanguage } from '@/lib/caption-grouping';
import { synchronizeCaptionTracksAfterTranscription } from '@/lib/caption-tracks';
import { canonicalCaptionLanguageTag } from '@/lib/caption-languages';
import {
  canReuseSourceTranscription,
  createSourceTranscriptionFingerprint,
} from '@/lib/source-transcription-fingerprint';
import { anchorCaptionsToClips, mapSourceWordsToTimeline } from '@/lib/video-timeline';
import {
  transcribeVideoLocally,
  type TranscriptionModelId,
  type TranscriptionProgress,
} from '@/services/transcription';
import type { CaptionGenerationSessionContext } from '@/services/caption-generation-session';
import type { CaptionProject, SourceTranscription, WordToken } from '@/types/project';

async function generateProjectCaptionsFromSources(
  project: CaptionProject,
  modelId: TranscriptionModelId,
  onProgress?: (progress: TranscriptionProgress) => void,
  onCheckpoint?: (project: CaptionProject) => Promise<void>,
  session?: CaptionGenerationSessionContext,
) {
  const sourceIds = [...new Set(project.clips.map((clip) => clip.sourceId))];
  const sourceById = new Map(project.sources.map((source) => [source.id, source]));
  const sourceResults: Record<string, SourceTranscription> = { ...project.transcription.sourceResults };

  for (let index = 0; index < sourceIds.length; index += 1) {
    session?.throwIfCancelled();
    const sourceId = sourceIds[index];
    const source = sourceById.get(sourceId);
    if (!source) throw new Error('A timeline clip has lost its source video.');
    onProgress?.({
      stage: 'preparing-audio',
      progress: 0,
      detail: sourceIds.length > 1
        ? `Video ${index + 1} of ${sourceIds.length} · Checking for reusable captions`
        : 'Checking for reusable captions',
    });
    const sourceFingerprint = createSourceTranscriptionFingerprint(await CaptionMedia.sha256(source.uri));
    session?.throwIfCancelled();
    if (canReuseSourceTranscription(sourceResults[sourceId], modelId, sourceFingerprint)) {
      onProgress?.({
        stage: 'grouping',
        progress: 1,
        detail: sourceIds.length > 1
          ? `Video ${index + 1} of ${sourceIds.length} · Reusing verified captions`
          : 'Reusing verified captions',
      });
      continue;
    }
    const result = await transcribeVideoLocally({
      projectId: `${project.id}-${sourceId}`,
      videoUri: source.uri,
      modelId,
      durationMs: source.durationMs,
      onProgress: (progress) => onProgress?.({
        ...progress,
        detail: sourceIds.length > 1
          ? `Video ${index + 1} of ${sourceIds.length} · ${progress.detail}`
          : progress.detail,
      }),
      session,
    });
    session?.throwIfCancelled();
    sourceResults[sourceId] = {
      language: result.language,
      modelId,
      generatedAt: new Date().toISOString(),
      sourceFingerprint,
      words: result.words,
    };
    if (onCheckpoint) {
      session?.throwIfCancelled();
      const allSourcesReady = sourceIds.every((sourceId) => sourceResults[sourceId]?.language);
      await onCheckpoint({
        ...project,
        updatedAt: new Date().toISOString(),
        transcription: {
          ...project.transcription,
          sourceResults: { ...sourceResults },
          ...(allSourcesReady
            ? { language: canonicalCaptionLanguageTag(sourceResults[sourceIds[0]]!.language) }
            : {}),
        },
      });
      session?.throwIfCancelled();
    }
  }

  const sourceWords: Record<string, WordToken[]> = {};
  for (const [sourceId, result] of Object.entries(sourceResults)) sourceWords[sourceId] = result.words;
  const words = mapSourceWordsToTimeline(project.clips, sourceWords);
  onProgress?.({
    stage: 'grouping',
    progress: 0.5,
    detail: 'Grouping words into editable subtitles',
  });
  const languageByClipId = new Map(
    project.clips.map((clip) => [clip.id, sourceResults[clip.sourceId]?.language]),
  );
  const grouped = groupTimelineWordsByClip(
    words,
    project.clips.map((clip) => clip.id),
    (clipId) => groupingOptionsForLanguage(languageByClipId.get(clipId)),
  );
  const captions = anchorCaptionsToClips(grouped, project.clips, words);
  onProgress?.({
    stage: 'grouping',
    progress: 1,
    detail: 'Captions ready',
  });
  const now = new Date().toISOString();
  const generated = {
    ...project,
    updatedAt: now,
    transcription: {
      language: canonicalCaptionLanguageTag(sourceResults[sourceIds[0]]?.language || 'en'),
      modelId,
      generatedAt: now,
      words,
      sourceResults,
    },
    captions,
  } satisfies CaptionProject;
  return {
    ...generated,
    captionTracks: synchronizeCaptionTracksAfterTranscription(project, generated),
  };
}
export async function generateProjectCaptions(
  ...args: Parameters<typeof generateProjectCaptionsFromSources>
): Promise<Awaited<ReturnType<typeof generateProjectCaptionsFromSources>>> {
  const [project] = args;
  const usesTimelineComposition = project.clips.length > 1
    || project.audioClips.some((clip) => !clip.muted && clip.volume > 0);
  if (!usesTimelineComposition) return generateProjectCaptionsFromSources(...args);

  args[2]?.({
    stage: 'preparing-audio',
    progress: 0,
    detail: 'Preparing the audible timeline',
  });
  const timelineSession = await createTimelineTranscriptionSession(project);
  const forwarded = [...args] as unknown as Parameters<typeof generateProjectCaptionsFromSources>;
  forwarded[0] = timelineSession.project;
  const checkpoint = args[3];
  if (checkpoint) {
    forwarded[3] = async (candidate) => checkpoint(timelineSession.restore(candidate));
  }
  try {
    const generated = await generateProjectCaptionsFromSources(...forwarded);
    return timelineSession.restore(generated);
  } finally {
    timelineSession.dispose();
  }
}
