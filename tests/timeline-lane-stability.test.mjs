import assert from 'node:assert/strict';
import test from 'node:test';
import { packTimelineLanes, indexTimelineCues, timelineCuePage } from '../src/lib/timeline-layout.ts';
import { visualTimelineGroups } from '../src/lib/timeline-tracks.ts';

for (const kind of ['image', 'text', 'watermark']) {
  for (const endMs of [1500, 4583]) {
    test(`${kind}: changing an equal-start item's end to ${endMs} preserves project-order lanes`, () => {
      const layers = ['a', 'b', 'c', 'd', 'e'].map((id) => Object.freeze({
        id, kind: kind === 'image' ? 'image' : 'text', watermark: kind === 'watermark',
        visible: true, startMs: 0, endMs: 3000,
      }));
      Object.freeze(layers);
      const before = visualTimelineGroups(layers)[0];
      const edited = layers.map((layer) => layer.id === 'c' ? { ...layer, endMs } : layer);
      const after = visualTimelineGroups(edited)[0];
      assert.deepEqual([...after.layout.laneById], [...before.layout.laneById]);
      assert.equal(after.layout.laneCount, 5);
      assert.deepEqual(after.items.map((layer) => layer.id), layers.map((layer) => layer.id));
      assert.equal(after.items[0], layers[0]);
      assert.equal(layers[2].endMs, 3000);
      const restored = visualTimelineGroups(JSON.parse(JSON.stringify(edited)))[0];
      assert.deepEqual([...restored.layout.laneById], [...after.layout.laneById]);
    });
  }
}

test('separate overlap clusters reuse two lanes, including touching endpoints', () => {
  const intervals = Object.freeze([
    { id: 'late-long', startMs: 60_000, endMs: 64_000 },
    { id: 'early-long', startMs: 30_000, endMs: 34_000 },
    { id: 'early-short', startMs: 30_000, endMs: 32_000 },
    { id: 'early-touch', startMs: 32_000, endMs: 34_000 },
    { id: 'late-short', startMs: 60_000, endMs: 62_000 },
  ].map(Object.freeze));
  const layout = packTimelineLanes(intervals);
  assert.equal(layout.laneCount, 2);
  assert.equal(layout.laneById.get('early-long'), 0);
  assert.equal(layout.laneById.get('late-long'), 0);
  assert.equal(layout.laneById.get('early-short'), layout.laneById.get('early-touch'));
  assert.equal(intervals[0].id, 'late-long');
});

test('indexed subtitle callers retain their existing cue order and non-overlap lane', () => {
  const cues = [{ id: 'later', startMs: 1000, endMs: 2000 }, { id: 'first', startMs: 0, endMs: 1000 }];
  const page = timelineCuePage(indexTimelineCues(cues), 2000, 1000, { left: 0, right: 1000 });
  assert.deepEqual(page.bodies.map((cue) => cue.id), ['first', 'later']);
  assert.equal(page.layout.laneCount, 1);
});
