import CaptionMedia from 'caption-media';

import { groupTimelineWordsByClip, groupingOptionsForLanguage } from '@/lib/caption-grouping';
import { synchronizeCaptionTracksAfterTranscription } from '@/lib/caption-tracks';
import { canonicalCaptionLanguageTag } from '@/lib/caption-languages';
import type { TranscriptionModel } from '@/lib/model-catalog';
import {
  canReuseSourceTranscription,
  createSourceTranscriptionFingerprint,
} from '@/lib/source-transcription-fingerprint';
import { anchorCaptionsToClips, mapSourceWordsToTimeline } from '@/lib/video-timeline';
import { transcribeVideoLocally, type TranscriptionProgress } from '@/services/transcription';
import type { CaptionGenerationSessionContext } from '@/services/caption-generation-session';
import type { CaptionProject, SourceTranscription, WordToken } from '@/types/project';

export async function generateProjectCaptions(
  project: CaptionProject,
  modelId: TranscriptionModel['id'],
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
      await onCheckpoint({
        ...project,
        updatedAt: new Date().toISOString(),
        transcription: { ...project.transcription, sourceResults: { ...sourceResults } },
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
