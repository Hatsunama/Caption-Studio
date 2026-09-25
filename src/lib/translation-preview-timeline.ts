import type { CaptionPair } from '@/lib/caption-tracks';
import {
  buildClipTimeline,
  dominantMediaOwner,
  sourceTimeAt,
  timelineTimeAt,
  translationReorderMapping,
} from '@/lib/video-timeline';
import type { CaptionBlock, VideoClip } from '@/types/project';

type PreviewTranslationTrack = { id: string; name: string; visible: boolean; pairs: CaptionPair[] };

/** Project secondary cue geometry for a temporary clip layout without editing committed cues. */
export function mapPreviewTranslationTracks(
  tracks: PreviewTranslationTrack[],
  beforeClips: VideoClip[],
  previewClips: VideoClip[],
  displayCaptions: CaptionBlock[],
): PreviewTranslationTrack[] {
  const beforeEntries = buildClipTimeline(beforeClips);
  const previewEntries = new Map(buildClipTimeline(previewClips).map((entry) => [entry.clip.id, entry]));
  const reorder = translationReorderMapping(beforeClips, previewClips);
  const displayById = new Map(displayCaptions.map((caption) => [caption.id, caption]));

  return tracks.map((track) => ({
    ...track,
    pairs: track.pairs.map((pair) => {
      const source = displayById.get(pair.source.id) ?? pair.source;
      // The translated cue owns this interval. Its primary source can occupy
      // a different part of the clip after an independent timing edit.
      const range = { startMs: pair.startMs, endMs: pair.endMs };
      const before = dominantMediaOwner(beforeEntries, range, pair.source.sourceAnchor?.clipId);
      if (!before || (previewEntries.has(before.clip.id)
        && previewEntries.get(before.clip.id)!.clip.sourceStartMs === before.clip.sourceStartMs
        && previewEntries.get(before.clip.id)!.clip.sourceEndMs === before.clip.sourceEndMs
        && previewEntries.get(before.clip.id)!.clip.playbackRate === before.clip.playbackRate)) {
        const mapped = reorder.mapRange(range, pair.source);
        const startMs = Math.min(reorder.durationMs, Math.max(0, mapped.startMs));
        const endMs = Math.min(reorder.durationMs, Math.max(startMs, mapped.endMs));
        return { ...pair, source, startMs, endMs, timelineVisible: pair.timelineVisible && endMs > startMs };
      }
      const preview = previewEntries.get(before.clip.id);
      if (!preview) return { ...pair, source, timelineVisible: false };

      const sourceStartMs = sourceTimeAt(before, pair.startMs);
      const sourceEndMs = sourceTimeAt(before, pair.endMs);
      const visibleStartMs = Math.max(sourceStartMs, preview.clip.sourceStartMs);
      const visibleEndMs = Math.min(sourceEndMs, preview.clip.sourceEndMs);
      if (visibleEndMs <= visibleStartMs) {
        const boundaryMs = timelineTimeAt(preview, sourceStartMs);
        return { ...pair, source, startMs: boundaryMs, endMs: boundaryMs, timelineVisible: false };
      }
      return {
        ...pair,
        source,
        startMs: timelineTimeAt(preview, visibleStartMs),
        endMs: timelineTimeAt(preview, visibleEndMs),
        timelineVisible: pair.timelineVisible,
      };
    }),
  }));
}
