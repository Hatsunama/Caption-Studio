/** Displacement in logical pixels from the original single-touch position. */
export const TIMELINE_DRAG_ACTIVATION_PX = 8;

/** Pending permits tap selection; vertical belongs to scrolling. Horizontal
 * permits timing edits. Reordering requires a separate, deliberate handle action
 * and must never be inferred from vertical movement on an item body. */
export type TimelineTouchIntent = 'pending' | 'horizontal' | 'vertical';

/** Pure classification of total dx/dy, not per-event deltas. Both axes within
 * eight pixels remain pending. Beyond that, the winning axis must be at least
 * 1.5 times the other; ambiguous diagonals and non-finite input remain pending.
 * Callers latch the first resolved intent for the touch: yield vertical motion
 * to scroll, and retain horizontal ownership until release or cancellation.
 * This function neither selects an item nor acquires a native responder. */
export function timelineTouchIntent(dx: number, dy: number): TimelineTouchIntent {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 'pending';
  const horizontal = Math.abs(dx);
  const vertical = Math.abs(dy);
  if (Math.max(horizontal, vertical) <= TIMELINE_DRAG_ACTIVATION_PX) return 'pending';
  if (horizontal >= vertical * 1.5) return 'horizontal';
  if (vertical >= horizontal * 1.5) return 'vertical';
  return 'pending';
}
