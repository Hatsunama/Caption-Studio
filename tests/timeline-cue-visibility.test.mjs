import assert from 'node:assert/strict';
import test from 'node:test';

import { indexTimelineCues, timelineCuePage } from '../src/lib/timeline-layout.ts';

test('dense but individually drawable captions remain real timeline blocks', () => {
  const cues = Array.from({ length: 80 }, (_, index) => ({
    id: `cue-${index}`,
    startMs: index * 1_000,
    endMs: index * 1_000 + 800,
  }));
  const page = timelineCuePage(indexTimelineCues(cues), 80_000, 400, { left: 0, right: 400 }, 'cue-40');

  assert.equal(page.bodies.length, 80);
  assert.equal(page.overview.length, 0);
  assert.equal(page.layout.laneCount, 1);
  assert.equal(Object.hasOwn(page, 'density'), false);
});

test('subpixel cue density uses bounded unlabeled overview and keeps the selected cue aligned', () => {
  const cues = Array.from({ length: 2_000 }, (_, index) => ({
    id: `cue-${index}`,
    startMs: index * 40,
    endMs: index * 40 + 35,
  }));
  const page = timelineCuePage(indexTimelineCues(cues), 80_000, 400, { left: 0, right: 400 }, 'cue-1000');

  assert.deepEqual(page.bodies.map((cue) => cue.id), ['cue-1000']);
  assert.ok(page.overview.length > 0 && page.overview.length <= 128);
  assert.ok(page.overview.every((segment) => segment.width > 0 && !Object.hasOwn(segment, 'count')));
  assert.equal(page.layout.laneById.get('cue-1000'), 0);
  assert.equal(page.layout.laneCount, 1);
  assert.equal(Object.hasOwn(page, 'density'), false);
});

test('overlapping cues cannot create an unbounded stack of timeline lanes', () => {
  const cues = Array.from({ length: 80 }, (_, index) => ({
    id: `overlap-${index}`,
    startMs: 10_000,
    endMs: 20_000,
  }));
  const page = timelineCuePage(indexTimelineCues(cues), 30_000, 400, { left: 0, right: 400 }, 'overlap-10');

  assert.deepEqual(page.bodies.map((cue) => cue.id), ['overlap-10']);
  assert.ok(page.overview.length > 0);
  assert.equal(page.layout.laneCount, 1);
});
