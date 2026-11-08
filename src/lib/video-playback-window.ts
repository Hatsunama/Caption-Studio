import { canContinueTimelineClip } from '@/lib/video-playback-policy';
import type { ClipTimelineEntry } from '@/lib/video-timeline';
import type { VideoTransitionPreviewWindow } from '@/lib/video-transition-preview';
import type { ProjectVideoSource } from '@/types/project';

// Clip only the end: the native item must retain its absolute source clock.
export function desiredVideoPlaybackWindowEnd(
  entry: ClipTimelineEntry,
  entries: readonly ClipTimelineEntry[],
  source: ProjectVideoSource,
  loadedUri: string,
  windows: readonly VideoTransitionPreviewWindow[],
  platform: string,
): number | undefined {
  if (platform !== 'android') return undefined;
  if (source.id !== entry.clip.sourceId || !Number.isFinite(source.durationMs) || source.durationMs <= 0
    || !loadedUri || (loadedUri !== source.uri && loadedUri !== source.previewUri)) {
    throw new Error('The video playback window has an invalid source.');
  }
  const index = entries.findIndex(candidate => candidate.clip.id === entry.clip.id);
  if (index < 0) throw new Error('The video playback window has lost its clip.');
  let endMs = 0;
  for (let i = index; i < entries.length; i++) {
    const current = i === index ? entry : entries[i];
    const { sourceStartMs, sourceEndMs } = current.clip;
    if (!Number.isFinite(sourceStartMs) || !Number.isFinite(sourceEndMs)
      || sourceStartMs < 0 || sourceStartMs >= source.durationMs || sourceEndMs <= sourceStartMs
      || !Number.isFinite(current.startMs) || current.startMs < 0
      || !Number.isFinite(current.endMs) || current.endMs <= current.startMs) {
      throw new Error('The video playback window has invalid clip times.');
    }
    endMs = Math.max(endMs, sourceEndMs);
    for (const window of windows) {
      if (window.unavailableReason) continue;
      for (const leg of [window.outgoing, window.incoming]) {
        if (!leg || leg.clipId !== current.clip.id || leg.sourceId !== source.id
          || (leg.uri !== loadedUri && leg.uri !== source.uri && leg.uri !== source.previewUri)) continue;
        if (!Number.isFinite(leg.sourceStartMs) || !Number.isFinite(leg.sourceEndMs)
          || leg.sourceStartMs < 0 || leg.sourceEndMs <= leg.sourceStartMs) {
          throw new Error('The video playback window has invalid transition times.');
        }
        endMs = Math.max(endMs, leg.sourceEndMs);
      }
    }
    if (!canContinueTimelineClip(current, entries[i + 1])) break;
  }
  const boundedEndMs = Math.floor(Math.min(endMs, source.durationMs));
  if (!Number.isSafeInteger(boundedEndMs) || boundedEndMs <= 0) {
    throw new Error('The video playback window has an invalid end.');
  }
  return endMs >= source.durationMs ? undefined : boundedEndMs;
}
