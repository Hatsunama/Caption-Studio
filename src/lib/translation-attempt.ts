import { updatePairedCaptionTexts } from '@/lib/caption-tracks';
import type { AutomaticTranslationCueWrite } from '@/lib/caption-translation-commit';
import type { CaptionProject } from '@/types/project';

/** Persist successes and explicit failures together, retaining previous text. */
export function commitTranslationAttempt(
  project: CaptionProject,
  trackId: string,
  captions: readonly { id: string; text: string }[],
  writes: readonly AutomaticTranslationCueWrite[],
): CaptionProject {
  const attempted = new Map(captions.map((caption) => [caption.id, caption.text]));
  const accepted = writes.filter((write) => write.translationStatus === 'translated');
  const successful = new Set(accepted.map((write) => write.sourceCaptionId));
  const next = updatePairedCaptionTexts(project, accepted.map((write) => ({
    trackId,
    sourceCaptionId: write.sourceCaptionId,
    translatedText: write.translatedText,
    translationStatus: 'translated' as const,
  })), new Date().toISOString());
  return {
    ...next,
    captionTracks: {
      ...next.captionTracks,
      translations: next.captionTracks.translations.map((track) => track.id !== trackId ? track : {
        ...track,
        cues: track.cues.map((cue) => attempted.has(cue.sourceCaptionId) && !successful.has(cue.sourceCaptionId)
          ? { ...cue, status: 'failed' as const, reviewed: false,
            sourceTextSnapshot: attempted.get(cue.sourceCaptionId)! }
          : cue),
      }),
    },
  };
}

export function translationAttemptMessage(project: CaptionProject, trackId: string, ids: readonly string[]) {
  const selected = new Set(ids);
  const track = project.captionTracks.translations.find((candidate) => candidate.id === trackId);
  const failed = track?.cues.filter((cue) => selected.has(cue.sourceCaptionId) && cue.status === 'failed').length ?? 0;
  return failed ? `${failed} subtitles could not be translated reliably. Successful translations were saved; existing text was kept. Tap Refresh to retry the failed lines before exporting.` : undefined;
}
