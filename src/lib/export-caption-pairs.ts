import { assertVisibleTranslationTracksCompatible, resolveCaptionPairs } from '@/lib/caption-tracks';
import { totalClipDuration } from '@/lib/video-timeline';
import type { CaptionProject } from '@/types/project';

/** Validate only captions that the requested output actually contains. */
export function exportCaptionPairs(project: CaptionProject) {
  assertVisibleTranslationTracksCompatible(project);
  const duration = totalClipDuration(project.clips ?? []);
  return (project.captionTracks?.translations ?? []).flatMap((track) => {
    if (!track.visible) return [];
    const pairs = resolveCaptionPairs(project, track.id).filter((pair) => (
      pair.timelineVisible && Number.isFinite(pair.startMs) && Number.isFinite(pair.endMs)
      && Math.round(pair.endMs) > Math.max(0, Math.round(pair.startMs))
      && (duration <= 0 || Math.round(pair.startMs) < duration)
    )).map((pair) => ({ ...pair, startMs: Math.max(0, Math.round(pair.startMs)),
      endMs: duration > 0 ? Math.min(duration, Math.round(pair.endMs)) : Math.round(pair.endMs) }));
    const unresolved = pairs.filter((pair) => (
      !['translated', 'reviewed'].includes(pair.translation.status) || !pair.translation.text.trim()
    ));
    if (unresolved.length) throw new Error(
      `${track.displayName} has ${unresolved.length} subtitles that need translation. Open Edit both languages and tap Refresh to retry them before exporting.`,
    );
    return pairs;
  });
}
