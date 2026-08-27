import { effectiveVideoTransition, videoTransitionPreviewKind } from '@/lib/video-transitions';
import type { ClipTimelineEntry } from '@/lib/video-timeline';
import type { ProjectVideoSource, VideoTransform, VideoTransitionType } from '@/types/project';

export type TransitionPreviewSource = {
  clipId: string;
  sourceId: string;
  uri: string;
  sourceStartMs: number;
  sourceEndMs: number;
  playbackRate: number;
  transform: VideoTransform;
};

export type VideoTransitionPreviewWindow = {
  key: string;
  type: VideoTransitionType;
  mode: 'cover' | 'composite';
  fidelity: 'exact' | 'approximate';
  approximationLabel?: string;
  startMs: number;
  boundaryMs: number;
  endMs: number;
  durationMs: number;
  outgoing?: TransitionPreviewSource;
  incoming?: TransitionPreviewSource;
  unavailableReason?: string;
};

export type VideoTransitionPreviewFrame = VideoTransitionPreviewWindow & {
  phase: number;
  peak: number;
  outgoingSourceTimeMs?: number;
  incomingSourceTimeMs?: number;
};

const COVER_TYPES = new Set<VideoTransitionType>([
  'dip-black',
  'dip-white',
  'flash',
  'shutter',
  'color-wash-cyan',
  'color-wash-magenta',
  'ripple-rings',
]);

const APPROXIMATE_MASK_TYPES = new Set<VideoTransitionType>([
  'wipe-diagonal-tl',
  'wipe-diagonal-tr',
  'wipe-diagonal-bl',
  'wipe-diagonal-br',
  'iris-circle',
  'iris-diamond',
  'blinds-horizontal',
  'blinds-vertical',
  'checkerboard',
  'pixel-grid',
  'radial-clock',
  'stripes-diagonal',
  'slice-shuffle',
]);

export function buildVideoTransitionPreviewWindows(
  entries: readonly ClipTimelineEntry[],
  sources: readonly ProjectVideoSource[],
): VideoTransitionPreviewWindow[] {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const windows: VideoTransitionPreviewWindow[] = [];
  entries.slice(0, -1).forEach((entry, index) => {
    const incomingEntry = entries[index + 1];
    const transition = effectiveVideoTransition(entry.clip, incomingEntry.clip);
    if (transition.type === 'none') return;
    const durationMs = Math.max(2, Math.min(
      integerMs(transition.durationMs),
      integerMs(entry.endMs - entry.startMs),
      integerMs(incomingEntry.endMs - incomingEntry.startMs),
    ));
    const boundaryMs = integerMs(incomingEntry.startMs);
    const beforeBoundaryMs = Math.floor(durationMs / 2);
    const afterBoundaryMs = durationMs - beforeBoundaryMs;
    const base = {
      key: `${entry.clip.id}:${incomingEntry.clip.id}:${transition.type}:${durationMs}`,
      type: transition.type,
      mode: COVER_TYPES.has(transition.type) ? 'cover' as const : 'composite' as const,
      fidelity: APPROXIMATE_MASK_TYPES.has(transition.type) ? 'approximate' as const : 'exact' as const,
      ...(APPROXIMATE_MASK_TYPES.has(transition.type)
        ? { approximationLabel: 'MASK PREVIEW APPROXIMATION · EXPORT USES THE FULL EFFECT' }
        : {}),
      startMs: boundaryMs - beforeBoundaryMs,
      boundaryMs,
      endMs: boundaryMs + afterBoundaryMs,
      durationMs,
    };
    try {
      const outgoingSource = requiredSource(sourceById, entry.clip.sourceId, entry.clip.id);
      const incomingSource = requiredSource(sourceById, incomingEntry.clip.sourceId, incomingEntry.clip.id);
      const outgoingAvailableEndMs = Math.min(
        integerMs(entry.clip.availableSourceEndMs),
        integerMs(outgoingSource.durationMs),
      );
      const incomingAvailableEndMs = Math.min(
        integerMs(incomingEntry.clip.availableSourceEndMs),
        integerMs(incomingSource.durationMs),
      );
      const outgoingSelectedStartMs = integerMs(entry.clip.sourceStartMs);
      const outgoingSelectedEndMs = integerMs(entry.clip.sourceEndMs);
      const incomingSelectedStartMs = integerMs(incomingEntry.clip.sourceStartMs);
      const incomingSelectedEndMs = integerMs(incomingEntry.clip.sourceEndMs);
      const incomingAvailableStartMs = integerMs(incomingEntry.clip.availableSourceStartMs);
      if (outgoingSelectedEndMs > outgoingAvailableEndMs || incomingSelectedEndMs > incomingAvailableEndMs) {
        throw new Error('A transition source extends beyond readable media.');
      }
      const outgoingVisibleStartMs = outgoingSelectedEndMs
        - sourceDurationMs(beforeBoundaryMs, entry.clip.playbackRate);
      const incomingVisibleEndMs = incomingSelectedStartMs
        + sourceDurationMs(afterBoundaryMs, incomingEntry.clip.playbackRate);
      if (outgoingVisibleStartMs < outgoingSelectedStartMs) {
        throw new Error('The outgoing clip does not contain enough selected video before the cut.');
      }
      if (incomingVisibleEndMs > incomingSelectedEndMs) {
        throw new Error('The incoming clip does not contain enough selected video after the cut.');
      }
      const outgoingHandleEndMs = outgoingSelectedEndMs
        + sourceDurationMs(afterBoundaryMs, entry.clip.playbackRate);
      const incomingHandleStartMs = incomingSelectedStartMs
        - sourceDurationMs(beforeBoundaryMs, incomingEntry.clip.playbackRate);
      const outgoingSourceEndMs = outgoingHandleEndMs <= outgoingAvailableEndMs
        ? outgoingHandleEndMs
        : outgoingSelectedEndMs;
      const incomingSourceStartMs = incomingHandleStartMs >= incomingAvailableStartMs
        ? incomingHandleStartMs
        : incomingSelectedStartMs;
      const outgoingPlaybackRate = sourceRate(outgoingVisibleStartMs, outgoingSourceEndMs, durationMs);
      const incomingPlaybackRate = sourceRate(incomingSourceStartMs, incomingVisibleEndMs, durationMs);
      windows.push({
        ...base,
        key: `${base.key}:${outgoingSource.id}:${outgoingSource.uri}:${incomingSource.id}:${incomingSource.uri}`,
        outgoing: {
          clipId: entry.clip.id,
          sourceId: entry.clip.sourceId,
          uri: outgoingSource.uri,
          sourceStartMs: outgoingVisibleStartMs,
          sourceEndMs: outgoingSourceEndMs,
          playbackRate: outgoingPlaybackRate,
          transform: entry.clip.transform,
        },
        incoming: {
          clipId: incomingEntry.clip.id,
          sourceId: incomingEntry.clip.sourceId,
          uri: incomingSource.uri,
          sourceStartMs: incomingSourceStartMs,
          sourceEndMs: incomingVisibleEndMs,
          playbackRate: incomingPlaybackRate,
          transform: incomingEntry.clip.transform,
        },
      });
    } catch (error) {
      windows.push({
        ...base,
        unavailableReason: error instanceof Error ? error.message : 'The transition preview is unavailable.',
      });
    }
  });

  for (let index = 0; index < windows.length - 1; index += 1) {
    const current = windows[index];
    const next = windows[index + 1];
    if (current.endMs <= next.startMs) continue;
    const reason = 'Adjacent transition windows overlap. Shorten one transition before export.';
    current.unavailableReason = reason;
    next.unavailableReason = reason;
    current.outgoing = undefined;
    current.incoming = undefined;
    next.outgoing = undefined;
    next.incoming = undefined;
  }
  return windows;
}

export function videoTransitionPreviewFrameAt(
  windows: readonly VideoTransitionPreviewWindow[],
  timelineMs: number,
): VideoTransitionPreviewFrame | undefined {
  const window = windows.find((candidate) => timelineMs >= candidate.startMs && timelineMs < candidate.endMs);
  if (!window) return undefined;
  const phase = clamp((timelineMs - window.startMs) / Math.max(1, window.durationMs), 0, 1);
  return {
    ...window,
    phase,
    peak: 1 - Math.abs(phase * 2 - 1),
    outgoingSourceTimeMs: window.outgoing
      ? interpolateSourceTime(window.outgoing, phase)
      : undefined,
    incomingSourceTimeMs: window.incoming
      ? interpolateSourceTime(window.incoming, phase)
      : undefined,
  };
}

export function videoTransitionPreloadWindow(
  windows: readonly VideoTransitionPreviewWindow[],
  timelineMs: number,
  leadMs = 1_500,
) {
  return windows.find((window) => (
    !window.unavailableReason
    && window.outgoing
    && window.incoming
    && timelineMs < window.endMs
    && window.startMs - timelineMs <= leadMs
  ));
}

export function transitionPreviewKind(type: VideoTransitionType) {
  return videoTransitionPreviewKind(type);
}

function requiredSource(
  sourceById: ReadonlyMap<string, ProjectVideoSource>,
  sourceId: string,
  clipId: string,
) {
  const source = sourceById.get(sourceId);
  if (!source) throw new Error(`Clip ${clipId} has lost its source video.`);
  return source;
}

function interpolateSourceTime(source: TransitionPreviewSource, phase: number) {
  return source.sourceStartMs + Math.round((source.sourceEndMs - source.sourceStartMs) * phase);
}

function sourceDurationMs(timelineDurationMs: number, playbackRate: number) {
  return Math.ceil(timelineDurationMs * playbackRate);
}

function sourceRate(sourceStartMs: number, sourceEndMs: number, timelineDurationMs: number) {
  if (timelineDurationMs <= 0 || sourceEndMs <= sourceStartMs) {
    throw new Error('A transition segment has invalid media bounds.');
  }
  const rate = (sourceEndMs - sourceStartMs) / timelineDurationMs;
  if (rate < 0.1 || rate > 8) {
    throw new Error('A transition segment requires an unsupported playback rate.');
  }
  return rate;
}

function integerMs(value: number) {
  return Math.trunc(value);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
