import type { TimelineTimingEdge } from '@/lib/timeline-item-editor';

export const TIMELINE_DRAG_ACTIVATION_PX = 8;
export const TIMELINE_GRIP_WIDTH = 40;
export const TIMELINE_CONTROL_HEIGHT = 36;
export const TIMELINE_PLAYHEAD_SNAP_PX = 10;
export const TIMELINE_PLAYHEAD_RELEASE_PX = 12;
export const TIMELINE_PLAYHEAD_HOLD_MS = 350;

/** Time-interval hit bounds never expand on selection. Editing controls occupy
 * a separate row below every content lane, with their own responder bounds. */
export function timelineBlockControls(width: number, selected: boolean) {
  return { width, controlWidth: selected ? 144 : 0 };
}

export type TimelineTrackBounds = { left: number; right: number };

/** Scroll content includes the label and leading playhead padding. */
export function timelineVisibleTrackBounds(scrollX: number, viewportWidth: number, trackWidth: number, trackOrigin: number): TimelineTrackBounds {
  return {
    left: Math.max(0, Math.min(trackWidth, scrollX - trackOrigin)),
    right: Math.max(0, Math.min(trackWidth, scrollX + viewportWidth - trackOrigin)),
  };
}

export function timelineControlRail(bodyLeft: number, trackWidth: number, bounds: TimelineTrackBounds = { left: 0, right: trackWidth }) {
  const width = Math.min(144, Math.max(0, bounds.right - bounds.left));
  return { left: Math.max(bounds.left, Math.min(bodyLeft, bounds.right - width)), width };
}

type TimingGestureOwner = {
  startMs: number;
  endMs: number;
  durationMs: number;
  trackWidth: number;
  playheadMs?: number;
  onPress: () => void;
  onChangeStart: () => void;
  onChange: (edge: TimelineTimingEdge, startMs: number, endMs: number) => void;
  onEnd: () => void;
};

export const TIMELINE_ACCESSIBILITY_STEP_MS = 100;
export const TIMELINE_ACCESSIBILITY_ACTIONS = [{ name: 'increment' as const }, { name: 'decrement' as const }];

/** Assistive commands enter the same selection/history/domain/save boundary as
 * deliberate touch gestures. No UI-only range mutation or synthetic drag. */
export function adjustTimelineTiming(owner: TimingGestureOwner, edge: TimelineTimingEdge, action: string) {
  if (action !== 'increment' && action !== 'decrement') return;
  const delta = action === 'increment' ? TIMELINE_ACCESSIBILITY_STEP_MS : -TIMELINE_ACCESSIBILITY_STEP_MS;
  owner.onPress();
  owner.onChangeStart();
  try {
    owner.onChange(edge, owner.startMs + (edge === 'end' ? 0 : delta), owner.endMs + (edge === 'start' ? 0 : delta));
  } finally {
    owner.onEnd();
  }
}

export function timelineTimingLabel(label: string, startMs: number, endMs: number, selected: boolean, operation: string) {
  return `${label}. ${selected ? 'Selected' : 'Not selected'}. Start ${(startMs / 1000).toFixed(3)} seconds, end ${(endMs / 1000).toFixed(3)} seconds. ${operation}`;
}

/** A touch owns selection immediately, and timing only after deliberate drag. */
export function createTimelineTimingGesture(options: { now?: () => number } = {}) {
  let owner: TimingGestureOwner | undefined;
  let edge: TimelineTimingEdge = 'move';
  let activated = false;
  let snapEnteredAt: number | undefined;
  let snapReleased = false;
  const now = options.now ?? Date.now;
  return {
    begin(next: TimingGestureOwner, nextEdge: TimelineTimingEdge) {
      owner = { ...next };
      edge = nextEdge;
      activated = false;
      snapEnteredAt = undefined;
      snapReleased = false;
      owner.onPress();
    },
    move(dx: number, dy: number) {
      if (!owner || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
      if (!activated) {
        if (Math.abs(dx) <= TIMELINE_DRAG_ACTIVATION_PX || Math.abs(dx) <= Math.abs(dy)) return;
        activated = true;
        owner.onChangeStart();
      }
      const delta = dx / Math.max(1, owner.trackWidth) * owner.durationMs;
      let startMs = owner.startMs + (edge === 'end' ? 0 : delta);
      let endMs = owner.endMs + (edge === 'start' ? 0 : delta);
      const playheadMs = owner.playheadMs;
      if (edge !== 'move' && Number.isFinite(playheadMs) && !snapReleased) {
        const playhead = playheadMs as number;
        const originalBoundary = edge === 'start' ? owner.startMs : owner.endMs;
        const requestedBoundary = edge === 'start' ? startMs : endMs;
        const originalSide = Math.sign(originalBoundary - playhead);
        const requestedSide = Math.sign(requestedBoundary - playhead);
        const snapThresholdMs = TIMELINE_PLAYHEAD_SNAP_PX / Math.max(1, owner.trackWidth) * owner.durationMs;
        const releaseThresholdMs = TIMELINE_PLAYHEAD_RELEASE_PX / Math.max(1, owner.trackWidth) * owner.durationMs;
        const reachedPlayhead = originalSide !== 0 && (
          Math.abs(requestedBoundary - playhead) <= snapThresholdMs
          || (requestedSide !== 0 && requestedSide !== originalSide)
        );
        if (snapEnteredAt === undefined && reachedPlayhead) snapEnteredAt = now();
        if (snapEnteredAt !== undefined) {
          const returnedToOriginalSide = requestedSide === originalSide
            && Math.abs(requestedBoundary - playhead) > snapThresholdMs;
          const continuedPastPlayhead = requestedSide !== 0
            && requestedSide !== originalSide
            && Math.abs(requestedBoundary - playhead) >= releaseThresholdMs;
          if (returnedToOriginalSide) {
            snapEnteredAt = undefined;
          } else if (continuedPastPlayhead && now() - snapEnteredAt >= TIMELINE_PLAYHEAD_HOLD_MS) {
            snapReleased = true;
          } else {
            if (edge === 'start') startMs = playhead;
            else endMs = playhead;
          }
        }
      }
      owner.onChange(edge, startMs, endMs);
    },
    finish() {
      const ended = owner;
      owner = undefined;
      if (activated) ended?.onEnd();
      activated = false;
      snapEnteredAt = undefined;
      snapReleased = false;
    },
  };
}
