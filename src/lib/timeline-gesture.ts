import type { TimelineTimingEdge } from '@/lib/timeline-item-editor';

export const TIMELINE_DRAG_ACTIVATION_PX = 8;
export const TIMELINE_GRIP_WIDTH = 24;

/** Keep a real duration body inside a larger, nonoverlapping selection rail. */
export function timelineBlockControls(width: number, selected: boolean) {
  const controlWidth = selected ? Math.max(80, width) : width;
  return { width: controlWidth, inset: (controlWidth - width) / 2 };
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
