import assert from 'node:assert/strict';
import test from 'node:test';

import { indexTimelineCues, timelineCuePage } from '../src/lib/timeline-layout.ts';

test('long intersecting cue does not expose off-viewport cue bodies', () => {
  const cues = [
    { id: 'long', startMs: 0, endMs: 100000 },
    { id: 'early-1', startMs: 100, endMs: 200 },
    { id: 'early-2', startMs: 300, endMs: 400 },
    { id: 'early-3', startMs: 500, endMs: 600 },
    { id: 'visible', startMs: 50000, endMs: 51000 },
  ];
  const page = timelineCuePage(indexTimelineCues(cues), 100000, 1000, { left: 500, right: 600 });
  assert.deepEqual(page.bodies.map((cue) => cue.id), ['long', 'visible']);
  assert.equal(page.density.length, 0);
  assert.equal(Object.hasOwn(page, 'height'), false);
  assert.equal(Object.hasOwn(page, 'probes'), false);
});

test('selected intersecting cue retains a body when the viewport is dense', () => {
  const cues = Array.from({ length: 80 }, (_, i) => ({ id: String(i), startMs: 0, endMs: 100000 }));
  const page = timelineCuePage(indexTimelineCues(cues), 100000, 1000, { left: 500, right: 700 }, '11');
  assert.ok(page.density.length > 0);
  assert.deepEqual(page.bodies.map((cue) => cue.id), ['11']);
});
