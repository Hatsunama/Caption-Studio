import type { CaptionProject } from '@/types/project';

type EditedCaptionFields = {
  sourceCaptionId: string;
  primaryChanged: boolean;
  translatedChanged: boolean;
};

export function assertDualCaptionEditsStillCurrent(
  baseline: CaptionProject,
  current: CaptionProject,
  trackId: string,
  edits: readonly EditedCaptionFields[],
) {
  const previousTrack = baseline.captionTracks.translations.find((track) => track.id === trackId);
  const currentTrack = current.captionTracks.translations.find((track) => track.id === trackId);
  const conflict = (): never => { throw new Error('A subtitle changed while these edits were saving. Review the current text and save again.'); };
  if (!previousTrack || !currentTrack
    || previousTrack.languageTag !== currentTrack.languageTag
    || previousTrack.sourceLanguageTag !== currentTrack.sourceLanguageTag) conflict();
  for (const edit of edits) {
    const previousSource = baseline.captions.find((caption) => caption.id === edit.sourceCaptionId);
    const currentSource = current.captions.find((caption) => caption.id === edit.sourceCaptionId);
    const previousCue = previousTrack.cues.find((cue) => cue.sourceCaptionId === edit.sourceCaptionId);
    const currentCue = currentTrack.cues.find((cue) => cue.sourceCaptionId === edit.sourceCaptionId);
    if (!previousSource || !currentSource || !previousCue || !currentCue
      || (edit.primaryChanged && previousSource.text !== currentSource.text)
      || (edit.translatedChanged && previousCue.text !== currentCue.text)) conflict();
  }
}
