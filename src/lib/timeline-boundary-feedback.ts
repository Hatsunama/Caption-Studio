/** Observe applied endpoints for one gesture; the caller supplies feedback. */
export function createTimelineBoundaryFeedback(onBoundary: () => void) {
  let boundaries: number[] = [];
  let tolerance = 0;
  let previousStart = 0;
  let previousEnd = 0;
  let active = false;

  // Lower bound by default; upper bound includes an exact boundary match.
  function indexAt(value: number, upper: boolean): number {
    let low = 0;
    let high = boundaries.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (boundaries[middle] < value || (upper && boundaries[middle] === value)) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  function enteredBoundary(previous: number, current: number): boolean {
    // The previous tolerance interval is already latched. Only its newly
    // swept portion can trigger, including boundaries overshot this frame.
    // Leaving the interval rearms that boundary for a subsequent return.
    if (current > previous) {
      return indexAt(current + tolerance, true) > indexAt(previous + tolerance, true);
    }
    if (current < previous) {
      return indexAt(current - tolerance, false) < indexAt(previous - tolerance, false);
    }
    return false;
  }

  function reset(): void {
    active = false;
    boundaries = [];
  }

  return {
    begin(startMs: number, endMs: number, times: readonly number[], toleranceMs: number): void {
      reset();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
      boundaries = [...new Set(times.filter(Number.isFinite))].sort((a, b) => a - b);
      tolerance = Number.isFinite(toleranceMs) ? Math.max(0, toleranceMs) : 0;
      previousStart = startMs;
      previousEnd = endMs;
      active = true;
    },

    update(startMs: number, endMs: number): void {
      if (!active || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
      const startEntered = enteredBoundary(previousStart, startMs);
      const endEntered = enteredBoundary(previousEnd, endMs);
      previousStart = startMs;
      previousEnd = endMs;
      // Commit both positions before invoking caller code (including reset).
      if (startEntered || endEntered) onBoundary();
    },

    reset,
  };
}
