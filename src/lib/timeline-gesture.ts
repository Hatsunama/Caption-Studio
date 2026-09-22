import type { TimelineTimingEdge } from '@/lib/timeline-item-editor';

export const TIMELINE_DRAG_ACTIVATION_PX = 8;
export const TIMELINE_GRIP_WIDTH = 40;
export const TIMELINE_CONTROL_HEIGHT = 36;
export const TIMELINE_PLAYHEAD_DWELL_MS = 250;
export const TIMELINE_PLAYHEAD_RELEASE_PX = 3;

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

/** A touch owns selection immediately, and timing only after deliberate drag. */
export function createTimelineTimingGesture(options: { now?: () => number } = {}) {
  let owner: TimelineTimingGestureOwner | undefined;
  let edge: TimelineTimingEdge = 'move';
  let activated = false;
  let previousBoundary = 0;
  let detent: { originalSide: number; lastDx: number; lastMovementAt: number } | undefined;
  let releaseOriginDx: number | undefined;
  const now = options.now ?? Date.now;
  return {
    begin(next: TimelineTimingGestureOwner, nextEdge: TimelineTimingEdge) {
      owner = { ...next };
      edge = nextEdge;
      activated = false;
      previousBoundary = nextEdge === 'start' ? owner.startMs : owner.endMs;
      detent = undefined;
      releaseOriginDx = undefined;
      owner.onPress();
    },
    move(dx: number, dy: number) {
      if (!owner || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
      if (!activated) {
        if (Math.abs(dx) <= TIMELINE_DRAG_ACTIVATION_PX || Math.abs(dx) <= Math.abs(dy)) return;
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
        const time = now();
        if (releaseOriginDx !== undefined) {
          const boundary = playhead + (dx - releaseOriginDx) * millisecondsPerPixel;
          if (edge === 'start') startMs = boundary;
          else endMs = boundary;
        } else if (detent) {
          const returnedToOriginalSide = requestedSide === detent.originalSide;
          const movementPx = Math.abs(dx - detent.lastDx);
          if (returnedToOriginalSide) {
            detent = undefined;
          } else if (
            time - detent.lastMovementAt >= TIMELINE_PLAYHEAD_DWELL_MS
            && movementPx >= TIMELINE_PLAYHEAD_RELEASE_PX
          ) {
            releaseOriginDx = detent.lastDx;
            const boundary = playhead + (dx - releaseOriginDx) * millisecondsPerPixel;
            if (edge === 'start') startMs = boundary;
            else endMs = boundary;
          } else {
            if (movementPx > 0.5) detent = { ...detent, lastDx: dx, lastMovementAt: time };
            if (edge === 'start') startMs = playhead;
            else endMs = playhead;
          }
        } else {
          const previousSide = Math.sign(previousBoundary - playhead);
          const crossedPlayhead = previousSide !== 0 && (requestedSide === 0 || requestedSide !== previousSide);
          if (crossedPlayhead) {
            detent = { originalSide: previousSide, lastDx: dx, lastMovementAt: time };
            if (edge === 'start') startMs = playhead;
            else endMs = playhead;
          }
        }
        previousBoundary = requestedBoundary;
      }
      owner.onChange(edge, startMs, endMs);
    },
    finish() {
      const ended = owner;
      owner = undefined;
      if (activated) ended?.onEnd();
      activated = false;
      detent = undefined;
      releaseOriginDx = undefined;
    },
  };
}
