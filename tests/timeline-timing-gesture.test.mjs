import assert from 'node:assert/strict';
import test from 'node:test';

import { createTimelineTimingGesture } from '../src/lib/timeline-gesture.ts';

function owner(changes, overrides = {}) {
  return {
    startMs: 1_000,
    endMs: 2_000,
    durationMs: 5_000,
    trackWidth: 1_000,
    playheadMs: 2_500,
    onPress() {},
    onChangeStart() {},
    onChange(edge, startMs, endMs) { changes.push({ edge, startMs, endMs }); },
    onEnd() {},
    ...overrides,
  };
}

test('edge extension requires a real stationary dwell and resumes from the playhead without jumping', () => {
  let now = 0;
  const changes = [];
  const gesture = createTimelineTimingGesture({ now: () => now });
  gesture.begin(owner(changes), 'end');

  gesture.move(60, 0);
  assert.equal(changes.at(-1).endMs, 2_300, 'ordinary extension remains continuous');

  gesture.move(105, 0);
  assert.equal(changes.at(-1).endMs, 2_500, 'crossing the playhead snaps to it');

  for (const [time, dx] of [[100, 120], [200, 140], [300, 160], [400, 180]]) {
    now = time;
    gesture.move(dx, 0);
    assert.equal(changes.at(-1).endMs, 2_500, 'continuous movement cannot masquerade as a pause');
  }

  now = 700;
  gesture.move(180, 0);
  assert.equal(changes.at(-1).endMs, 2_500, 'a stationary dwell arms release without moving the edge');

  now = 710;
  gesture.move(184, 0);
  assert.equal(changes.at(-1).endMs, 2_520, 'post-dwell motion is rebased at the playhead');

  gesture.move(194, 0);
  assert.equal(changes.at(-1).endMs, 2_570, 'movement remains continuous after release');
});

test('a start edge uses the same playhead detent in either drag direction', () => {
  let now = 0;
  const changes = [];
  const gesture = createTimelineTimingGesture({ now: () => now });
  gesture.begin(owner(changes, { startMs: 3_000, endMs: 4_000 }), 'start');
  gesture.move(-105, 0);
  assert.equal(changes.at(-1).startMs, 2_500);
  now = 300;
  gesture.move(-105, 0);
  assert.equal(changes.at(-1).startMs, 2_500);
  now = 310;
  gesture.move(-109, 0);
  assert.equal(changes.at(-1).startMs, 2_480);
});

test('moving a whole timeline item never snaps to the playhead', () => {
  const changes = [];
  const gesture = createTimelineTimingGesture({ now: () => 0 });
  gesture.begin(owner(changes), 'move');
  gesture.move(105, 0);
  assert.deepEqual(changes.at(-1), { edge: 'move', startMs: 1_525, endMs: 2_525 });
});
