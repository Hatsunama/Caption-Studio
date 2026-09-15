import type { TimelineTimingEdge } from '@/lib/timeline-item-editor';

export const TIMELINE_DRAG_ACTIVATION_PX = 8;
export const TIMELINE_GRIP_WIDTH = 40;
export const TIMELINE_CONTROL_HEIGHT = 36;

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
  onPress: () => void;
  onChangeStart: () => void;
  onChange: (edge: TimelineTimingEdge, startMs: number, endMs: number) => void;
  onEnd: () => void;
};

/** A touch owns selection immediately, and timing only after deliberate drag. */
export function createTimelineTimingGesture() {
  let owner: TimingGestureOwner | undefined;
  let edge: TimelineTimingEdge = 'move';
  let activated = false;
  return {
    begin(next: TimingGestureOwner, nextEdge: TimelineTimingEdge) {
      owner = { ...next };
      edge = nextEdge;
      activated = false;
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
      owner.onChange(edge, owner.startMs + (edge === 'end' ? 0 : delta),
        owner.endMs + (edge === 'start' ? 0 : delta));
    },
    finish() {
      const ended = owner;
      owner = undefined;
      if (activated) ended?.onEnd();
      activated = false;
    },
  };
}
