import { normalizedTranslationFailureReason, updatePairedCaptionTexts } from '@/lib/caption-tracks';
import type { AutomaticTranslationCueWrite } from '@/lib/caption-translation-commit';
import type { CaptionProject } from '@/types/project';

/** Persist successes and explicit failures together, retaining previous text. */
export function commitTranslationAttempt(
  project: CaptionProject,
  trackId: string,
  captions: readonly { id: string; text: string }[],
  writes: readonly AutomaticTranslationCueWrite[],
  failureReasons: ReadonlyMap<string, string> = new Map(),
): CaptionProject {
  if (!project.captionTracks.translations.some((track) => track.id === trackId)) {
    throw new Error('The second-language caption track no longer exists.');
  }
  const attempted = new Map(captions.map((caption) => [caption.id, caption.text]));
  if (attempted.size === 0) return project;
  const accepted = writes.filter((write) => attempted.has(write.sourceCaptionId)
    && write.translationStatus === 'translated' && write.translatedText.trim());
  const successful = new Set(accepted.map((write) => write.sourceCaptionId));
  const next = updatePairedCaptionTexts(project, accepted.map((write) => ({
    trackId,
    sourceCaptionId: write.sourceCaptionId,
    translatedText: write.translatedText,
    translationStatus: 'translated' as const,
  })), new Date().toISOString());
  return {
    ...next,
    updatedAt: new Date().toISOString(),
    captionTracks: {
      ...next.captionTracks,
      translations: next.captionTracks.translations.map((track) => track.id !== trackId ? track : {
        ...track,
        cues: track.cues.map((cue) => attempted.has(cue.sourceCaptionId) && !successful.has(cue.sourceCaptionId)
          ? { ...cue, status: 'failed' as const, reviewed: false,
            failureReason: normalizedTranslationFailureReason(failureReasons.get(cue.sourceCaptionId))
              ?? 'translation-output-unavailable',
            sourceTextSnapshot: cue.text.trim() ? cue.sourceTextSnapshot : attempted.get(cue.sourceCaptionId)! }
          : cue),
      }),
    },
  };
}

export function translationAttemptMessage(project: CaptionProject, trackId: string, ids: readonly string[]) {
  const selected = new Set(ids);
  const track = project.captionTracks.translations.find((candidate) => candidate.id === trackId);
  const failed = track?.cues.filter((cue) => selected.has(cue.sourceCaptionId) && cue.status === 'failed').length ?? 0;
  return failed ? `${failed} subtitle translation attempts failed. Successful translations were saved; existing text was kept. See each failed line for its reason. Refresh any or all failed lines, skip them, or export available text anyway.` : undefined;
}
