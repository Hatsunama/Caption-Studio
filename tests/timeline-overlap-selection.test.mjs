import assert from 'node:assert/strict';
import test from 'node:test';

import { indexTimelineCues, timelineCueChoices, timelineCuePage } from '../src/lib/timeline-layout.ts';

test('every coincident primary and translated cue is reachable from bounded overview choices at any zoom', () => {
  for (const row of ['primary', 'translated']) {
    const cues = Array.from({ length: 80 }, (_, index) => ({
      id: `${row}-${index}`,
      text: `${row} cue ${index}`,
      startMs: 10_000,
      endMs: 20_000,
    }));
    const cueIndex = indexTimelineCues(cues);
    for (const trackWidth of [400, 40_000]) {
      const page = timelineCuePage(cueIndex, 30_000, trackWidth, { left: 0, right: trackWidth });
      assert.equal(page.bodies.length, 0);
      assert.equal(page.layout.laneCount, 1);
      assert.ok(page.overview.length > 0);
      const segment = page.overview.find(({ startMs, endMs }) => startMs <= 15_000 && endMs >= 15_000);
      assert.ok(segment);
      const found = [];
      for (let offset = 0; ; offset += 32) {
        const choices = timelineCueChoices(cueIndex, segment.startMs, segment.endMs, offset);
        assert.ok(choices.cues.length > 0 && choices.cues.length <= 32);
        found.push(...choices.cues.map((cue) => cue.id));
        if (!choices.hasMore) break;
      }
      assert.deepEqual(found, cues.map((cue) => cue.id));
    }
  }
});
