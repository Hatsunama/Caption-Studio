import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SCROLL_SPRING_POLICY, createScrollSpringAxisState, beginScrollSpringDrag,
  updateScrollSpringDrag, releaseScrollSpringDrag, resetScrollSpringAxis,
} from '../src/lib/scroll-spring-policy.ts';

const sample = (patch = {}) => ({ pointerDp: 0, timeMs: 0, viewportDp: 400,
  offsetDp: 0, rangeDp: 1000, nativeActive: true, scrollEnabled: true,
  touchCount: 1, dominantAxis: true, reducedMotion: false, ...patch });
const near = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const drag = (patch = {}, presented = 0) => {
  const s = createScrollSpringAxisState();
  assert.equal(beginScrollSpringDrag(s, sample(patch), presented), true);
  return s;
};

test('both native boundaries produce signed, capped displacement and reusable state', () => {
  assert.equal(SCROLL_SPRING_POLICY.maxDisplacementDp, 96);
  assert.equal(SCROLL_SPRING_POLICY.viewportFraction, 0.25);
  for (const viewportDp of [1, 100, 400, 2000]) for (const sign of [1, -1]) {
    const base = { viewportDp, offsetDp: sign > 0 ? 0 : 1000 };
    const s = drag(base);
    const keys = Object.keys(s);
    updateScrollSpringDrag(s, sample({ ...base, pointerDp: sign * 40, timeMs: 16 }));
    assert.ok(s.displacementDp * sign > 0);
    assert.ok(Math.abs(s.displacementDp) < 40);
    updateScrollSpringDrag(s, sample({ ...base, pointerDp: sign * 1e9, timeMs: 32 }));
    near(s.displacementDp, sign * Math.min(96, viewportDp / 4));
    assert.deepEqual(Object.keys(s), keys);
    assert.equal(releaseScrollSpringDrag(s, 32), 0); // flat at the cap
    resetScrollSpringAxis(s);
    assert.equal(s.displacementDp, 0);
  }
});

test('native interior and inward drags never request recoil; boundary entry rebases', () => {
  const s = createScrollSpringAxisState();
  assert.equal(beginScrollSpringDrag(s, sample({ offsetDp: 50 }), 0), false);
  updateScrollSpringDrag(s, sample({ offsetDp: 50, pointerDp: 500, timeMs: 16 }));
  assert.equal(s.displacementDp, 0);
  updateScrollSpringDrag(s, sample({ pointerDp: 520, timeMs: 32 }));
  assert.equal(s.displacementDp, 0);
  updateScrollSpringDrag(s, sample({ pointerDp: 540, timeMs: 48 }));
  assert.ok(s.displacementDp > 0);
  const inward = drag();
  updateScrollSpringDrag(inward, sample({ pointerDp: -40, timeMs: 16 }));
  assert.equal(inward.displacementDp, 0);
  assert.equal(releaseScrollSpringDrag(inward, 16), 0);
});

test('reversal crosses zero without opposite-edge recoil or saturation dead travel', () => {
  const s = drag();
  updateScrollSpringDrag(s, sample({ pointerDp: 10000, timeMs: 16 }));
  updateScrollSpringDrag(s, sample({ pointerDp: 9990, timeMs: 32 }));
  assert.ok(s.displacementDp < 96);
  assert.ok(s.velocityDpPerSecond < 0);
  updateScrollSpringDrag(s, sample({ pointerDp: 9000, timeMs: 48 }));
  assert.equal(s.displacementDp, 0);
  assert.equal(releaseScrollSpringDrag(s, 48), 0);
});

test('interrupting settling in either direction preserves position, including at cap', () => {
  for (const presented of [20, -20, 96, -96]) {
    const offsetDp = presented > 0 ? 0 : 1000;
    const s = drag({ offsetDp, pointerDp: 300 }, presented);
    near(s.displacementDp, presented);
    updateScrollSpringDrag(s, sample({ offsetDp, pointerDp: 300, timeMs: 16 }));
    near(s.displacementDp, presented);
    assert.equal(releaseScrollSpringDrag(s, 16), 0);
    const resumed = drag({ offsetDp, pointerDp: 300 }, presented);
    updateScrollSpringDrag(resumed, sample({ offsetDp, pointerDp: 300 - Math.sign(presented), timeMs: 16 }));
    assert.ok(Math.abs(resumed.displacementDp) < Math.abs(presented));
  }
});

test('release velocity is the resistance derivative in dp/sec at 60/120/irregular cadence', () => {
  for (const sign of [1, -1]) for (const times of [
    Array.from({ length: 12 }, (_, i) => (i + 1) * 100 / 12),
    Array.from({ length: 6 }, (_, i) => (i + 1) * 100 / 6),
    [7, 19, 33, 60, 73, 100],
  ]) {
    const offsetDp = sign > 0 ? 0 : 1000;
    const s = drag({ offsetDp });
    for (const timeMs of times) updateScrollSpringDrag(s, sample({ offsetDp, timeMs, pointerDp: sign * timeMs }));
    const expected = sign * 1000 * 0.5 * (1 - 100 / (4 * 96));
    near(releaseScrollSpringDrag(s, 100), expected);
    assert.equal(releaseScrollSpringDrag(s, 100), 0); // finalization is idempotent
  }
});

test('all eligibility gates cancel displacement and prevent velocity leaking on re-entry', () => {
  for (const patch of [{ nativeActive: false }, { scrollEnabled: false }, { touchCount: 2 },
    { touchCount: 0 }, { dominantAxis: false }, { reducedMotion: true }, { offsetDp: 50 }]) {
    const s = drag();
    updateScrollSpringDrag(s, sample({ pointerDp: 40, timeMs: 16 }));
    updateScrollSpringDrag(s, sample({ ...patch, pointerDp: 80, timeMs: 32 }));
    assert.equal(s.displacementDp, 0);
    assert.equal(releaseScrollSpringDrag(s, 32), 0);
    assert.equal(beginScrollSpringDrag(s, sample(patch), 20), false);
    updateScrollSpringDrag(s, sample({ pointerDp: 100, timeMs: 48 }));
    assert.equal(s.displacementDp, 0);
  }
});

test('release velocity matches numerical presentation derivative, including reversal', () => {
  for (const position of [20, -20, 80, -80]) for (const direction of [1, -1]) {
    const offsetDp = position > 0 ? 0 : 1000;
    const h = 0.001;
    const left = drag({ offsetDp }, position), right = drag({ offsetDp }, position);
    const low = updateScrollSpringDrag(left, sample({ offsetDp, pointerDp: -h, timeMs: 16 }));
    const high = updateScrollSpringDrag(right, sample({ offsetDp, pointerDp: h, timeMs: 16 }));
    const s = drag({ offsetDp }, position);
    updateScrollSpringDrag(s, sample({ offsetDp, pointerDp: direction * 1e-6, timeMs: 1e-6 }));
    near(releaseScrollSpringDrag(s, 1e-6), direction * 1000 * (high - low) / (2 * h), 1e-4);
  }
});

test('geometry changes and switching boundaries safely reset before reacquiring', () => {
  for (const patch of [{ viewportDp: 200 }, { rangeDp: 2000 }, { offsetDp: 1000 }]) {
    const s = drag();
    updateScrollSpringDrag(s, sample({ pointerDp: 40, timeMs: 16 }));
    updateScrollSpringDrag(s, sample({ ...patch, pointerDp: 60, timeMs: 32 }));
    assert.equal(s.displacementDp, 0);
    assert.equal(s.velocityDpPerSecond, 0);
  }
  const short = drag({ rangeDp: 0 });
  updateScrollSpringDrag(short, sample({ rangeDp: 0, pointerDp: -30, timeMs: 16 }));
  assert.ok(short.displacementDp < 0);
});

test('nonfinite, out-of-range geometry and overflow reset safely', () => {
  for (const field of ['pointerDp', 'timeMs', 'viewportDp', 'offsetDp', 'rangeDp', 'touchCount']) {
    for (const value of [NaN, Infinity, -Infinity]) {
      const s = drag();
      updateScrollSpringDrag(s, sample({ [field]: value, timeMs: field === 'timeMs' ? value : 16 }));
      assert.equal(s.displacementDp, 0);
      assert.equal(s.tracking, false);
      for (const v of Object.values(s)) if (typeof v === 'number') assert.ok(Number.isFinite(v));
    }
  }
  for (const patch of [{ viewportDp: 0 }, { viewportDp: -1 }, { rangeDp: -1 },
    { offsetDp: -1 }, { offsetDp: 1001 }, { timeMs: -1 }]) {
    assert.equal(beginScrollSpringDrag(createScrollSpringAxisState(), sample(patch), 0), false);
  }
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.equal(beginScrollSpringDrag(createScrollSpringAxisState(), sample(), bad), false);
  }
  const s = drag({ pointerDp: -Number.MAX_VALUE });
  updateScrollSpringDrag(s, sample({ pointerDp: Number.MAX_VALUE, timeMs: 16 }));
  assert.equal(s.displacementDp, 0);
});

test('duplicate/backward timestamps and long gaps rebase without displacement or fling', () => {
  for (const timeMs of [16, 8, 1000]) {
    const s = drag();
    updateScrollSpringDrag(s, sample({ pointerDp: 40, timeMs: 16 }));
    const before = s.displacementDp;
    updateScrollSpringDrag(s, sample({ pointerDp: 100, timeMs }));
    near(s.displacementDp, before);
    assert.equal(s.velocityDpPerSecond, 0);
    assert.ok(s.lastTimeMs >= 16);
  }
  for (const timeMs of [NaN, Infinity, 8, 1000]) {
    const s = drag();
    updateScrollSpringDrag(s, sample({ pointerDp: 40, timeMs: 16 }));
    assert.equal(releaseScrollSpringDrag(s, timeMs), 0);
  }
});

test('axis-neutral independent states do not leak velocity or allocate per update', () => {
  const x = drag(), y = drag();
  const keys = Object.keys(x);
  for (let i = 1; i <= 10000; i++) {
    updateScrollSpringDrag(x, sample({ pointerDp: i % 100, timeMs: i * 8 }));
  }
  assert.deepEqual(Object.keys(x), keys);
  assert.equal(y.rawOverscrollDp, 0);
  assert.equal(y.velocityDpPerSecond, 0);
  resetScrollSpringAxis(x);
  assert.deepEqual(x, createScrollSpringAxisState());
});

test('extreme finite inputs and explicit cancellation keep all outputs finite', () => {
  for (const viewportDp of [Number.MAX_VALUE, Number.MIN_VALUE * 4]) {
    const s = drag({ viewportDp });
    updateScrollSpringDrag(s, sample({ viewportDp, pointerDp: Number.MAX_VALUE, timeMs: Number.MIN_VALUE }));
    assert.ok(Number.isFinite(s.displacementDp));
    assert.ok(Number.isFinite(releaseScrollSpringDrag(s, Number.MIN_VALUE)));
    assert.ok(Math.abs(s.displacementDp) <= Math.min(96, viewportDp / 4));
  }
  const s = drag();
  updateScrollSpringDrag(s, sample({ pointerDp: 40, timeMs: 16 }));
  resetScrollSpringAxis(s);
  assert.equal(releaseScrollSpringDrag(s, 16), 0);
  assert.equal(s.displacementDp, 0);
});
