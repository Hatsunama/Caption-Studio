import assert from 'node:assert/strict';
import test from 'node:test';
import * as tracks from '../src/lib/timeline-tracks.ts';
import * as layout from '../src/lib/timeline-layout.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';

const item = (id, startMs = 0, endMs = 1000, extra = {}) => Object.freeze({
  id, kind: 'image', visible: true, startMs, endMs, ...extra,
});
const captions = Object.freeze({ id: 'captions', kind: 'captions', visible: true });
const ids = (layers) => layers.map((layer) => layer.id);
function project(layers) {
  return Object.freeze({ ...createCaptionProject({ id: 'stack', name: 'Stack', sources: [{
    id: 'source', uri: 'file:///video.mp4', storageMode: 'copied', displayName: 'Video',
    durationMs: 10_000, width: 1920, height: 1080, rotation: 0, frameRate: 30,
  }] }),
    layers: Object.freeze(layers), timelineTrackOrder: ['images', 'captions'],
    captionTracks: { schemaVersion: 1, primaryTrackId: 'captions', translations: [{ id: 'fr' }, { id: 'es' }] },
  });
}

test('appended duplicate is above original despite unequal starts, without mutating the snapshot', () => {
  const layers = Object.freeze([item('original', 0, 2000), item('duplicate', 500, 2500)]);
  const group = tracks.visualTimelineGroups(layers)[0];
  assert.deepEqual(ids(group.items), ['duplicate', 'original']);
  assert.equal(group.layout.laneById.get('duplicate'), 0);
  assert.equal(group.layout.laneById.get('original'), 1);
  assert.deepEqual(ids(layers), ['original', 'duplicate']);
});

test('ordered overlap paths require more lanes than concurrency; independent items reuse lanes', () => {
  const frontToBack = [item('a', 0, 2), item('b', 1, 4), item('c', 3, 6), item('d', 5, 7), item('free', 8, 9)];
  const packed = layout.packOrderedTimelineLanes(frontToBack);
  assert.equal(packed.laneCount, 4);
  assert.deepEqual([...packed.laneById.values()], [0, 1, 2, 3, 0]);
  assert.equal(layout.packTimelineLanes(frontToBack).laneCount, 2, 'legacy chronological packing stays unchanged');
  assert.equal(layout.packOrderedTimelineLanes([item('a', 0, 1), item('b', 1, 2)]).laneCount, 1);
});

test('kind interleaving and captions split segments; IDs and membership resolve repeat kinds', () => {
  const layers = [item('back'), item('title', 0, 1, { kind: 'text' }), item('middle'), captions, item('front')];
  const groups = tracks.visualTimelineGroups(layers);
  assert.deepEqual(groups.map((g) => g.id), ['images', 'images:middle', 'text', 'images:back']);
  assert.deepEqual(groups.map((g) => ids(g.items)), [['front'], ['middle'], ['title'], ['back']]);
  assert.equal(tracks.visualTimelineGroupForLayer(groups, 'back')?.id, 'images:back');
  assert.equal(tracks.visualTimelineGroupForLayer(groups, 'missing'), undefined);
  assert.deepEqual(tracks.visualTimelineRowIds(layers, ['fr', 'es']),
    ['images', 'translation:es', 'translation:fr', 'captions', 'images:middle', 'text', 'images:back']);
  assert.deepEqual(tracks.visualTimelineLayerIds(layers), ['front', 'captions', 'middle', 'title', 'back']);
});

test('individual drag uses global front indexes for every visual kind and keeps hidden slots', () => {
  for (const moving of [item('moving', 50, 500, { kind: 'video' }), item('moving'),
    item('moving', 0, 1000, { kind: 'text' }), item('moving', 0, 1000, { kind: 'text', watermark: true }), captions]) {
    const hidden = item('hidden', 0, 1000, { timelineVisible: false });
    const p = project([moving, hidden, item('front', 0, 1000, { visible: false })]);
    const next = tracks.reorderVisualTimelineLayer(p, moving.id, 0);
    assert.deepEqual(ids(next.layers), ['front', 'hidden', moving.id]);
    assert.equal(next.layers[1], hidden);
    assert.equal(next.layers[2], moving);
    assert.deepEqual(ids(p.layers), [moving.id, 'hidden', 'front']);
    for (const key of ['clips', 'audioClips', 'captions', 'captionTracks', 'timelineTrackOrder']) assert.equal(next[key], p[key]);
    assert.deepEqual(ids(tracks.reorderVisualTimelineLayers(p.layers, moving.id, 0)), ids(next.layers));
    assert.equal(tracks.reorderVisualTimelineLayer(next, moving.id, 0), next);
    assert.equal(tracks.reorderVisualTimelineLayer(p, 'unknown', 0), p);
    assert.equal(tracks.reorderVisualTimelineLayer(p, 'hidden', 0), p);
    assert.equal(tracks.reorderVisualTimelineLayer(p, moving.id, NaN), p);
  }
});

test('explicit row order applies actual paint, translating subtitle rows to the caption bundle', () => {
  const p = project([item('back'), captions, item('title', 0, 1000, { kind: 'text' }), item('front')]);
  const next = tracks.applyTimelineStackOrder(p, ['translation:fr', 'images', 'text', 'captions', 'images:back', 'video', 'audio']);
  assert.deepEqual(ids(next.layers), ['back', 'title', 'front', 'captions']);
  assert.equal(next.captionTracks, p.captionTracks, 'internal translation order and cue data stay intact');
  assert.equal(next.timelineTrackOrder, p.timelineTrackOrder, 'no new persisted ordering schema');
  assert.equal(tracks.applyTimelineStackOrder(p, ['unknown']), p);
  assert.equal(tracks.applyTimelineStackOrder(p, ['translation:missing', 'images']), p);
  assert.equal(tracks.applyTimelineStackOrder(p, ['images', 'images']), p);
  assert.deepEqual(tracks.visualTimelineRowIds(p.layers, ['fr', 'es']),
    ['images', 'text', 'translation:es', 'translation:fr', 'captions', 'images:back']);
  assert.equal(tracks.setTimelineTrackOrder(p, ['text', 'captions']).layers, p.layers, 'legacy API remains presentation only');
});

test('group application reuses lane ordering and leaves unmentioned visuals in relative order', () => {
  const p = project([item('back', 0, 2000), item('front', 500, 2500), captions, item('title', 0, 1000, { kind: 'text' })]);
  const next = tracks.applyTimelineStackOrder(p, ['images']);
  assert.deepEqual(ids(next.layers), ['captions', 'title', 'back', 'front']);
  assert.equal(tracks.applyTimelineStackOrder(next, ['images']), next);
});

test('caption bundle row order is the reverse of actual primary-then-translation paint order', () => {
  const layers = [item('back'), captions, item('front')];
  const rows = tracks.visualTimelineRowIds(layers, ['fr', 'es', 'de']);
  const captionPaintOrder = ['captions', 'translation:fr', 'translation:es', 'translation:de'];
  assert.deepEqual(rows.slice(1, 5), [...captionPaintOrder].reverse());
  assert.deepEqual(tracks.visualTimelineRowIds([captions]), ['captions']);
  assert.deepEqual(tracks.visualTimelineRowIds([], ['fr']), []);
});

test('array preview clamps final indexes and retains snapshot identity on invalid or unchanged moves', () => {
  const layers = Object.freeze([item('back'), captions, item('front')]);
  assert.equal(tracks.reorderVisualTimelineLayers(layers, 'front', -100), layers);
  assert.equal(tracks.reorderVisualTimelineLayers(layers, 'back', Infinity), layers);
  assert.deepEqual(ids(tracks.reorderVisualTimelineLayers(layers, 'front', 100)), ['front', 'back', 'captions']);
  assert.deepEqual(ids(tracks.reorderVisualTimelineLayers(layers, 'back', 0.7)), ['captions', 'back', 'front']);
});
