/** Pure axis-neutral edge presentation policy; no scrolling, animation or RN imports.
 * All positions/ranges are dp, times monotonic ms, velocity dp/sec. Positive
 * presentation follows the pointer at offset 0; negative at offset rangeDp.
 * The adapter normalizes native offsets (including insets/RTL) to [0, rangeDp],
 * supplies dominantAxis from whole-gesture intent, and sets nativeActive ONLY
 * while Gesture.Native is ACTIVE. Never disable or replace native scrolling.
 *
 * Allocate one state per axis. Calls mutate it without allocating. On an eligible
 * settling interruption, cancel the adapter's animation and begin with its actual
 * presented translation. On release, spring that translation to 0 using withSpring
 * and the returned velocity. Zero translation needs no spring. Invalid eligibility,
 * reduced motion or changed geometry resets immediately: apply 0, cancel animation.
 * Re-read eligibility/geometry at finalization before release (update if changed).
 * This policy does not integrate an oscillator or keep animation time/state.
 */
export const SCROLL_SPRING_POLICY = {
  maxDisplacementDp: 96,
  viewportFraction: 0.25,
  maxSampleGapMs: 100,
} as const;

export interface ScrollSpringSample {
  pointerDp: number;
  timeMs: number;
  viewportDp: number;
  /** Normalized native offset and maximum offset, both dp. */
  offsetDp: number;
  rangeDp: number;
  nativeActive: boolean;
  scrollEnabled: boolean;
  touchCount: number;
  dominantAxis: boolean;
  reducedMotion: boolean;
}

export interface ScrollSpringAxisState {
  /** Unresisted edge travel, bounded to four times the presentation cap, dp. */
  rawOverscrollDp: number;
  displacementDp: number;
  lastPointerDp: number;
  lastTimeMs: number;
  velocityDpPerSecond: number;
  tracking: boolean;
  viewportDp: number;
  rangeDp: number;
  /** 1 = start, -1 = end, 0 = both (non-scrollable content). */
  edge: number;
}

export function createScrollSpringAxisState(): ScrollSpringAxisState {
  'worklet';
  return { rawOverscrollDp: 0, displacementDp: 0, lastPointerDp: 0,
    lastTimeMs: 0, velocityDpPerSecond: 0, tracking: false,
    viewportDp: 0, rangeDp: 0, edge: 0 };
}

export function resetScrollSpringAxis(s: ScrollSpringAxisState): void {
  'worklet';
  s.rawOverscrollDp = 0;
  s.displacementDp = 0;
  s.lastPointerDp = 0;
  s.lastTimeMs = 0;
  s.velocityDpPerSecond = 0;
  s.tracking = false;
  s.viewportDp = 0;
  s.rangeDp = 0;
  s.edge = 0;
}

function eligible(e: ScrollSpringSample): boolean {
  'worklet';
  return e.nativeActive === true && e.scrollEnabled === true &&
    e.dominantAxis === true && e.reducedMotion === false && e.touchCount === 1 &&
    Number.isFinite(e.pointerDp) && Number.isFinite(e.timeMs) && e.timeMs >= 0 &&
    Number.isFinite(e.viewportDp) && e.viewportDp > 0 &&
    // Reject subnormal viewports whose cap would underflow to zero.
    e.viewportDp * SCROLL_SPRING_POLICY.viewportFraction > 0 &&
    Number.isFinite(e.rangeDp) && e.rangeDp >= 0 &&
    Number.isFinite(e.offsetDp) && e.offsetDp >= 0 && e.offsetDp <= e.rangeDp &&
    (e.offsetDp === 0 || e.offsetDp === e.rangeDp);
}

function edge(e: ScrollSpringSample): number {
  'worklet';
  return e.rangeDp === 0 ? 0 : e.offsetDp === 0 ? 1 : -1;
}

function cap(viewportDp: number): number {
  'worklet';
  return Math.min(SCROLL_SPRING_POLICY.maxDisplacementDp,
    viewportDp * SCROLL_SPRING_POLICY.viewportFraction);
}

/** Returns eligibility; a valid begin with 0 presentation only records a baseline.
 * Inverse resistance preserves a settling position, clamped to the current cap
 * and boundary sign. May be called on a fresh state or to interrupt settling.
 */
export function beginScrollSpringDrag(
  s: ScrollSpringAxisState, e: ScrollSpringSample, presentedDp = 0,
): boolean {
  'worklet';
  resetScrollSpringAxis(s);
  if (!eligible(e) || !Number.isFinite(presentedDp)) return false;
  const limit = cap(e.viewportDp);
  const boundary = edge(e);
  const position = Math.max(boundary === 1 ? 0 : -limit,
    Math.min(boundary === -1 ? 0 : limit, presentedDp));
  const fraction = Math.abs(position) / limit;
  // Stable inverse of p = cap * (2u - u*u), u = |raw|/(4cap).
  s.rawOverscrollDp = Math.sign(position) * 4 * limit *
    (fraction / (1 + Math.sqrt(1 - fraction)));
  s.displacementDp = position;
  s.lastPointerDp = e.pointerDp;
  s.lastTimeMs = e.timeMs;
  s.viewportDp = e.viewportDp;
  s.rangeDp = e.rangeDp;
  s.edge = boundary;
  s.tracking = true;
  return true;
}

/** Returns translation dp. First eligible sample only acquires a baseline, so an
 * interior gesture reaching an edge never contributes its earlier pointer travel.
 * Duplicate/backward/gapped timestamps rebase without motion or stale velocity.
 */
export function updateScrollSpringDrag(s: ScrollSpringAxisState, e: ScrollSpringSample): number {
  'worklet';
  if (!eligible(e)) {
    resetScrollSpringAxis(s);
    return 0;
  }
  if (!s.tracking || s.viewportDp !== e.viewportDp || s.rangeDp !== e.rangeDp || s.edge !== edge(e)) {
    beginScrollSpringDrag(s, e);
    return 0;
  }
  const dt = e.timeMs - s.lastTimeMs;
  const delta = e.pointerDp - s.lastPointerDp;
  if (!Number.isFinite(delta) || !Number.isFinite(dt)) {
    resetScrollSpringAxis(s);
    return 0;
  }
  s.lastPointerDp = e.pointerDp;
  s.lastTimeMs = Math.max(s.lastTimeMs, e.timeMs);
  s.velocityDpPerSecond = 0;
  if (dt <= 0 || dt > SCROLL_SPRING_POLICY.maxSampleGapMs) return s.displacementDp;
  const limit = cap(e.viewportDp);
  const raw = s.rawOverscrollDp + delta;
  if (!Number.isFinite(raw)) {
    resetScrollSpringAxis(s);
    return 0;
  }
  // Discard travel beyond the cap, allowing immediate reversal. Never let a
  // start-edge drag turn into end-edge recoil (except when both edges coincide).
  s.rawOverscrollDp = Math.max(s.edge === 1 ? 0 : -4 * limit,
    Math.min(s.edge === -1 ? 0 : 4 * limit, raw));
  const u = Math.abs(s.rawOverscrollDp) / (4 * limit);
  s.displacementDp = Math.sign(s.rawOverscrollDp) * limit * u * (2 - u);
  const velocity = (delta / dt) * 1000 * 0.5 * (1 - u);
  if (s.displacementDp !== 0 && Number.isFinite(velocity) && velocity !== 0) s.velocityDpPerSecond = velocity;
  return s.displacementDp;
}

/** Ends observation, retaining displacement for the adapter's spring. A tap,
 * cancellation/reset or stale/invalid release returns 0 dp/sec. Call reset for
 * cancellation; call begin with actual presented dp when interrupting animation.
 */
export function releaseScrollSpringDrag(s: ScrollSpringAxisState, timeMs: number): number {
  'worklet';
  const age = timeMs - s.lastTimeMs;
  const velocity = s.tracking && s.displacementDp !== 0 && Number.isFinite(age) &&
    age >= 0 && age <= SCROLL_SPRING_POLICY.maxSampleGapMs &&
    Number.isFinite(s.velocityDpPerSecond) ? s.velocityDpPerSecond : 0;
  s.tracking = false;
  s.velocityDpPerSecond = 0;
  return velocity;
}
