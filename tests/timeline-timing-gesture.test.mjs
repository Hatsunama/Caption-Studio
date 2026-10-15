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

test('a jittering tap selects immediately without opening a timing transaction', () => {
  const calls = [];
  const changes = [];
  const gesture = createTimelineTimingGesture();
  gesture.begin(owner(changes, {
    onPress() { calls.push('select'); },
    onChangeStart() { calls.push('start'); },
    onEnd() { calls.push('end'); },
    onCancel() { calls.push('cancel'); },
  }), 'move');
  assert.deepEqual(calls, ['select']);
  gesture.move(8, 0);
  gesture.move(-8, 8);
  gesture.finish();
  assert.deepEqual(calls, ['select']);
  assert.deepEqual(changes, []);
});

test('a near diagonal cannot edit until horizontal intent becomes clear', () => {
  for (const edge of ['move', 'start', 'end']) {
    const changes = [];
    let starts = 0;
    const gesture = createTimelineTimingGesture();
    gesture.begin(owner(changes, { onChangeStart() { starts += 1; } }), edge);
    gesture.move(12, 11);
    assert.equal(starts, 0, edge);
    assert.deepEqual(changes, [], edge);
    gesture.move(15, 10);
    assert.equal(starts, 1, edge);
    assert.equal(changes.length, 1, edge);
    gesture.finish();
  }
});

test('vertical scrolling cannot turn into an item edit later in the same touch', () => {
  const changes = [];
  const calls = [];
  const gesture = createTimelineTimingGesture();
  const activeOwner = owner(changes, {
    onPress() { calls.push('select'); },
    onChangeStart() { calls.push('start'); },
    onEnd() { calls.push('end'); },
    onCancel() { calls.push('cancel'); },
  });
  gesture.begin(activeOwner, 'move');
  gesture.move(8, 12);
  gesture.move(100, 12);
  gesture.finish();
  assert.deepEqual(changes, []);
  assert.deepEqual(calls, ['select']);
  gesture.begin(activeOwner, 'move');
  gesture.move(20, 0);
  gesture.finish();
  assert.deepEqual(changes, [{ edge: 'move', startMs: 1_100, endMs: 2_100 }]);
  assert.deepEqual(calls, ['select', 'select', 'start', 'end']);
});

test('claimed horizontal timing stays active through later vertical displacement', () => {
  const changes = [];
  let commits = 0;
  const gesture = createTimelineTimingGesture();
  gesture.begin(owner(changes, { onEnd() { commits += 1; } }), 'move');
  gesture.move(-20, 0);
  gesture.move(-30, 100);
  gesture.finish();
  assert.deepEqual(changes.at(-1), { edge: 'move', startMs: 850, endMs: 1_850 });
  assert.equal(commits, 1);
});

test('release commits once even when the owner offers cancellation rollback', () => {
  const changes = [];
  const calls = [];
  const gesture = createTimelineTimingGesture();
  gesture.begin(owner(changes, {
    onChangeStart() { calls.push('start'); },
    onEnd() { calls.push('commit'); },
    onCancel() { calls.push('rollback'); },
  }), 'end');
  gesture.move(20, 0);
  gesture.finish();
  gesture.finish();
  gesture.cancel();
  assert.deepEqual(calls, ['start', 'commit']);
});

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

test('cancelling an activated trim discards its draft without committing on later release', () => {
  const changes = [];
  let commits = 0;
  let cancellations = 0;
  const gesture = createTimelineTimingGesture();
  gesture.begin(owner(changes, {
    onEnd() { commits += 1; },
    onCancel() { cancellations += 1; },
  }), 'end');
  gesture.move(60, 0);
  gesture.cancel();
  gesture.move(120, 0);
  gesture.finish();
  gesture.cancel();
  assert.equal(changes.length, 1);
  assert.equal(cancellations, 1);
  assert.equal(commits, 0);
});

test('cancelling a tap does not start or end a history transaction', () => {
  const calls = [];
  const gesture = createTimelineTimingGesture();
  gesture.begin(owner([], {
    onChangeStart() { calls.push('start'); },
    onEnd() { calls.push('end'); },
    onCancel() { calls.push('cancel'); },
  }), 'move');
  gesture.cancel();
  gesture.move(90, 0);
  gesture.finish();
  assert.deepEqual(calls, []);
});

test('cancelling live item timing closes its existing transaction only once', () => {
  const calls = [];
  const gesture = createTimelineTimingGesture();
  gesture.begin(owner([], {
    onChangeStart() { calls.push('start'); },
    onEnd() { calls.push('end'); },
  }), 'move');
  gesture.move(90, 0);
  gesture.cancel();
  gesture.finish();
  assert.deepEqual(calls, ['start', 'end']);
});
