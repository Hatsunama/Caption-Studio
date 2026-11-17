import assert from 'node:assert/strict';
import test from 'node:test';
import { createTimelineTimingGesture } from '../src/lib/timeline-gesture.ts';
import { createTimelineBoundaryFeedback } from '../src/lib/timeline-boundary-feedback.ts';
import { editTimelineRange } from '../src/lib/timeline-item-timing.ts';

// Same applied-range -> feedback path as useTimelineTimingPanHandlers; no device,
// timers, sleeps or platform haptic throttle can hide duplicate boundary pulses.
function fixture(edge, direction, aligned = false, millisecondsPerPixel = 5) {
  const marker = 2_500;
  const boundary = marker - (aligned ? 0 : direction * 100 * millisecondsPerPixel);
  const initial = edge === 'start'
    ? { startMs: boundary, endMs: 4_500 }
    : { startMs: 500, endMs: boundary };
  const changes = [];
  let pulses = 0;
  let commits = 0;
  let time = 0;
  const feedback = createTimelineBoundaryFeedback(() => { pulses += 1; });
  feedback.begin(initial.startMs, initial.endMs, [marker], 2 * millisecondsPerPixel);
  const gesture = createTimelineTimingGesture({ now: () => time });
  gesture.begin({
    ...initial, durationMs: 5_000, trackWidth: 5_000 / millisecondsPerPixel,
    playheadMs: marker, onPress() {}, onChangeStart() {},
    onChange(nextEdge, startMs, endMs) {
      const applied = editTimelineRange(initial, nextEdge, startMs, endMs, 5_000);
      changes.push(applied);
      feedback.update(applied.startMs, applied.endMs);
    },
    onEnd() { commits += 1; },
  }, edge);
  return {
    gesture, changes, pulses: () => pulses, commits: () => commits,
    move(dx) {
      // Every event moves within a single uninterrupted frame cadence.
      time += 16;
      gesture.move(dx, 0);
      return changes.at(-1)[edge === 'start' ? 'startMs' : 'endMs'];
    },
  };
}

for (const edge of ['start', 'end']) {
  for (const direction of [-1, 1]) {
    for (const scale of [2, 5]) {
      test(`${edge} ${direction}: uninterrupted capture releases spatially at scale ${scale}`, () => {
        const h = fixture(edge, direction, false, scale);
        assert.equal(h.move(direction * 90), 2_500 - direction * 10 * scale);
        assert.equal(h.move(direction * 100), 2_500, 'capture at the marker');
        for (const dx of [101, 102, 103]) {
          assert.equal(h.move(direction * dx), 2_500, 'soft capture is at most three logical pixels');
        }
        for (const dx of [103.25, 104, 110, 130, 160]) {
          assert.equal(h.move(direction * dx), 2_500 + direction * (dx - 103) * scale,
            'release immediately consumes only movement beyond the spatial band, with no catch-up jump');
        }
        assert.equal(h.pulses(), 1, 'capture and uninterrupted departure produce one boundary pulse');
        const beforeFinish = h.changes.at(-1);
        h.gesture.finish();
        assert.equal(h.changes.at(-1), beforeFinish, 'finger release cannot change timing');
        assert.equal(h.commits(), 1);
      });
    }

    test(`${edge} ${direction}: marker-origin drag and reversal cannot latch or oscillate`, () => {
      const h = fixture(edge, direction, true);
      assert.equal(h.move(direction * 9), 2_500 + direction * 30,
        'horizontal activation already exceeds the spatial band; never adds a dwell');
      assert.equal(h.move(direction * 20), 2_500 + direction * 85);
      assert.equal(h.move(direction * 9), 2_500 + direction * 30, 'reversal follows the same continuous mapping');
      for (const dx of [3, 2, 0, -2, -3]) assert.equal(h.move(direction * dx), 2_500);
      assert.equal(h.pulses(), 1, 'return to the initially aligned marker buzzes once');
      for (const dx of [-3.25, -4, -10, -30]) {
        assert.equal(h.move(direction * dx), 2_500 + direction * (dx + 3) * 5);
      }
      assert.equal(h.pulses(), 1, 'leaving a capture never creates another pulse');
      h.gesture.finish();
    });

    test(`${edge} ${direction}: coarse crossing is bounded and immediately reversible`, () => {
      const h = fixture(edge, direction);
      h.move(direction * 90);
      assert.equal(h.move(direction * 140), 2_500 + direction * 185,
        'a sparse event cannot create an unbounded capture at its overshoot position');
      assert.equal(h.move(direction * 130), 2_500 + direction * 135);
      assert.equal(h.pulses(), 1);
      for (const dx of [103, 102, 100, 98, 97]) assert.equal(h.move(direction * dx), 2_500);
      assert.equal(h.pulses(), 2, 'one new pulse for an intentional return');
      assert.equal(h.move(direction * 96), 2_500 - direction * 5);
      assert.equal(h.move(direction * 90), 2_500 - direction * 35);
      assert.equal(h.pulses(), 2);
      h.gesture.finish();
    });
  }
}
