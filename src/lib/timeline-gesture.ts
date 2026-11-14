import type { TimelineTimingEdge } from '@/lib/timeline-item-editor';
import { timelineTouchIntent } from './timeline-touch-intent';

export { TIMELINE_DRAG_ACTIVATION_PX } from './timeline-touch-intent';
export const TIMELINE_GRIP_WIDTH = 40;
export const TIMELINE_CONTROL_HEIGHT = 36;
export const TIMELINE_PLAYHEAD_RELEASE_PX = 3;

export type TimelineTrackBounds = { left: number; right: number };

/** Only external viewport/zoom/rotation changes invalidate touch coordinates. Draft
 * duration and reorder filmstrip changes must not cancel their own gesture. */
export function createTimelineGestureGeometry(initial: { viewportWidth: number; scale: number }) {
  let geometry = { ...initial };
  const listeners = new Set<() => void>();
  const invalidate = () => { for (const cancel of [...listeners]) cancel(); };
  return {
    invalidate,
    subscribe(cancel: () => void) {
      listeners.add(cancel);
      return () => { listeners.delete(cancel); };
    },
    update(next: Partial<typeof initial>) {
      const updated = { ...geometry, ...next };
      if (updated.viewportWidth === geometry.viewportWidth && updated.scale === geometry.scale) return false;
      geometry = updated;
      invalidate();
      return true;
    },
  };
}

/** Scroll content includes the label and leading playhead padding. */
export function timelineVisibleTrackBounds(scrollX: number, viewportWidth: number, trackWidth: number, trackOrigin: number): TimelineTrackBounds {
  return {
    left: Math.max(0, Math.min(trackWidth, scrollX - trackOrigin)),
    right: Math.max(0, Math.min(trackWidth, scrollX + viewportWidth - trackOrigin)),
  };
}

export type TimelineTimingGestureOwner = {
  startMs: number;
  endMs: number;
  durationMs: number;
  trackWidth: number;
  playheadMs?: number;
  onPress: () => void;
  onChangeStart: () => void;
  onChange: (edge: TimelineTimingEdge, startMs: number, endMs: number) => void;
  onEnd: () => void;
  /** Optional draft rollback on cancellation. Without it, cancellation closes
   * the existing live transaction through onEnd; it does not undo live edits. */
  onCancel?: () => void;
};

export const TIMELINE_ACCESSIBILITY_STEP_MS = 100;
export const TIMELINE_ACCESSIBILITY_ACTIONS = [{ name: 'increment' as const }, { name: 'decrement' as const }];

/** Assistive commands enter the same selection/history/domain/save boundary as
 * deliberate touch gestures. No UI-only range mutation or synthetic drag. */
export function adjustTimelineTiming(owner: TimelineTimingGestureOwner, edge: TimelineTimingEdge, action: string) {
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

/** A touch owns selection immediately, and timing only after clear horizontal
 * intent. Vertical intent yields the rest of this touch to scrolling. Native
 * release should call finish; termination/interruption should call cancel. */
export function createTimelineTimingGesture(options: { now?: () => number } = {}) {
  let owner: TimelineTimingGestureOwner | undefined;
  let edge: TimelineTimingEdge = 'move';
  let activated = false;
  let yieldedToScroll = false;
  let previousBoundary = 0;
  let detent = false;
  const end = (cancelled: boolean) => {
    const ended = owner;
    const wasActivated = activated;
    owner = undefined;
    activated = false;
    yieldedToScroll = false;
    detent = false;
    if (wasActivated && ended) {
      if (cancelled && ended.onCancel) ended.onCancel();
      else ended.onEnd();
    }
  };
  return {
    begin(next: TimelineTimingGestureOwner, nextEdge: TimelineTimingEdge) {
      owner = { ...next };
      edge = nextEdge;
      activated = false;
      yieldedToScroll = false;
      previousBoundary = nextEdge === 'start' ? owner.startMs : owner.endMs;
      detent = previousBoundary === owner.playheadMs;
      owner.onPress();
    },
    move(dx: number, dy: number) {
      if (!owner || yieldedToScroll || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
      if (!activated) {
        const intent = timelineTouchIntent(dx, dy);
        if (intent === 'vertical') yieldedToScroll = true;
        if (intent !== 'horizontal') return;
        activated = true;
        owner.onChangeStart();
      }
      const millisecondsPerPixel = owner.durationMs / Math.max(1, owner.trackWidth);
      const delta = dx * millisecondsPerPixel;
      let startMs = owner.startMs + (edge === 'end' ? 0 : delta);
      let endMs = owner.endMs + (edge === 'start' ? 0 : delta);
      const playheadMs = owner.playheadMs;
      if (edge !== 'move' && Number.isFinite(playheadMs)) {
        const playhead = playheadMs as number;
        const requestedBoundary = edge === 'start' ? startMs : endMs;
        const requestedSide = Math.sign(requestedBoundary - playhead);
        if (!detent) {
          const previousSide = Math.sign(previousBoundary - playhead);
          const crossedPlayhead = previousSide !== 0 && (requestedSide === 0 || requestedSide !== previousSide);
          detent = crossedPlayhead;
        }
        if (detent) {
          // Keep a marker-centered spatial band for the rest of this touch.
          // Sparse crossings and reversals use the same bounded mapping; no
          // event position or stationary time becomes a new release origin.
          const displacement = requestedBoundary - playhead;
          const boundary = playhead + requestedSide * Math.max(0,
            Math.abs(displacement) - TIMELINE_PLAYHEAD_RELEASE_PX * millisecondsPerPixel);
          if (edge === 'start') startMs = boundary;
          else endMs = boundary;
        }
        previousBoundary = requestedBoundary;
      }
      owner.onChange(edge, startMs, endMs);
    },
    finish() {
      end(false);
    },
    cancel() {
      end(true);
    },
  };
}
