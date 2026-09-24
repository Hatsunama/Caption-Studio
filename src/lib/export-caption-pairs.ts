import { projectRenderDuration } from '@/lib/project-timeline';
import { assertVisibleTranslationTracksCompatible, resolveCaptionPairs } from '@/lib/caption-tracks';
import type { CaptionProject } from '@/types/project';

/** Validate only captions that the requested output actually contains. */
export function exportCaptionPairs(project: CaptionProject, allowIncomplete = false) {
  const pairs = eligibleExportCaptionPairs(project);
  const eligibleTrackIds = new Set(pairs.map((pair) => pair.trackId));
  assertVisibleTranslationTracksCompatible(project, eligibleTrackIds);
  const unresolved = pairs.filter((pair) => !['translated', 'reviewed'].includes(pair.translation.status) || !pair.translation.text.trim());
  if (!allowIncomplete && unresolved.length) throw new Error(
    `${unresolved.length} subtitles need translation or review. Refresh them, or choose Export anyway to use available text, including current source text for failed lines without saved translations.`,
  );
  return pairs.filter((pair) => pair.displayText.trim());
}

export function exportTranslationSummary(project: CaptionProject) {
  const pairs = eligibleExportCaptionPairs(project);
  return {
    missing: pairs.filter((pair) => !pair.translation.text.trim()).length,
    needsReview: pairs.filter((pair) => pair.translation.text.trim() && !['translated', 'reviewed'].includes(pair.translation.status)).length,
  };
}

function eligibleExportCaptionPairs(project: CaptionProject) {
  const duration = projectRenderDuration(project);
  if (duration <= 0) return [];
  return (project.captionTracks?.translations ?? []).flatMap((track) => {
    if (!track.visible) return [];
    const pairs = resolveCaptionPairs(project, track.id).filter((pair) => (
      pair.timelineVisible && Number.isFinite(pair.startMs) && Number.isFinite(pair.endMs)
      && Math.round(pair.endMs) > Math.max(0, Math.round(pair.startMs))
      && Math.round(pair.startMs) < duration
    )).map((pair) => ({ ...pair, startMs: Math.max(0, Math.round(pair.startMs)),
      endMs: Math.min(duration, Math.round(pair.endMs)) }));
    return pairs;
  });
}
