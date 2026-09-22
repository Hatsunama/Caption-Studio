import assert from 'node:assert/strict';
import test from 'node:test';

import { indexTimelineCues, timelineCuePage } from '../src/lib/timeline-layout.ts';

test('an actively dragged caption stays mounted outside the viewport until release', () => {
  const cues = [
    { id: 'visible', startMs: 0, endMs: 500 },
    { id: 'dragged', startMs: 8_000, endMs: 9_000 },
  ];
  const page = timelineCuePage(indexTimelineCues(cues), 10_000, 1_000, { left: 0, right: 100 }, 'dragged', true);
  assert.deepEqual(page.bodies.map((cue) => cue.id).sort(), ['dragged', 'visible']);
});
