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

test('edge extension has one deliberate playhead detent and no arbitrary stops', () => {
  let now = 0;
  const changes = [];
  const gesture = createTimelineTimingGesture({ now: () => now });
  gesture.begin(owner(changes), 'end');

  gesture.move(60, 0);
  assert.equal(changes.at(-1).endMs, 2_300, 'ordinary extension remains continuous');

  gesture.move(105, 0);
  assert.equal(changes.at(-1).endMs, 2_500, 'crossing the playhead snaps to it');

  now = 200;
  gesture.move(130, 0);
  assert.equal(changes.at(-1).endMs, 2_500, 'the detent holds briefly while drag continues');

  now = 400;
  gesture.move(130, 0);
  assert.equal(changes.at(-1).endMs, 2_650, 'continued drag passes the playhead after the hold');

  gesture.move(160, 0);
  assert.equal(changes.at(-1).endMs, 2_800, 'movement remains continuous after release');
});

test('moving a whole timeline item never snaps to the playhead', () => {
  const changes = [];
  const gesture = createTimelineTimingGesture({ now: () => 0 });
  gesture.begin(owner(changes), 'move');
  gesture.move(105, 0);
  assert.deepEqual(changes.at(-1), { edge: 'move', startMs: 1_525, endMs: 2_525 });
});

