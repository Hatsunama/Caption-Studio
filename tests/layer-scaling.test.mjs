import assert from 'node:assert/strict';
import test from 'node:test';
import { createGeometryFrameQueue, createLayerGesture, layerExtent, positiveLayerScale, resolveLayerGeometry } from '../src/lib/layer-geometry.ts';
import { DEFAULT_CAPTION_STYLE } from '../src/types/project.ts';
import { decodeVersionTwoProject, serializeProjectSnapshot } from '../src/lib/project-schema.ts';
import { buildTimelineRenderPlan, serializeStyle, toNativeRenderPlan } from '../src/lib/export-render-plan.ts';
import { mergeStyle } from '../src/lib/style-resolver.ts';
import { serializeAss } from '../src/lib/subtitle-export.ts';

const size = { width: 400, height: 800, pageX: 10, pageY: 20 };
const point = (x, y, id = 1) => ({ x, y, id });
const geometry = () => ({ position: { x: .5, y: .5 }, box: { width: .5, height: .25 }, rotation: 0 });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, a + ' != ' + b);

for (const kind of ['caption', 'text', 'image']) {
  test(kind + ': horizontal and vertical edges preserve the opposite edge and base typography', () => {
    for (const [mode, dx, dy, axis] of [['right', 100, 0, 'width'], ['left', -100, 0, 'width'], ['top', 0, -100, 'height'], ['bottom', 0, 100, 'height']]) {
      const base = { ...geometry(), fontSize: 48 };
      const gesture = createLayerGesture(base);
      gesture.begin(mode, [point(200, 400)], size);
      const next = gesture.update([point(200 + dx, 400 + dy)]);
      near(layerExtent(next)[axis], axis === 'width' ? .75 : .375);
      near(next.scale, 1);
      near(next[axis === 'width' ? 'scaleY' : 'scaleX'], 1);
      near(next.position[axis === 'width' ? 'x' : 'y'], .5 + (dx || dy) / (axis === 'width' ? 800 : 1600));
      assert.deepEqual(next.box, base.box);
      assert.equal(base.fontSize, 48);
      assert.equal('fontSize' in next, false);
    }
  });
}

test('rotated edge movement is projected in pixels on a non-square canvas', () => {
  const gesture = createLayerGesture({ ...geometry(), rotation: 90 });
  gesture.begin('right', [point(0, 0)], size);
  const next = gesture.update([point(0, 100)]);
  near(next.scaleX, 1.5);
  near(next.position.x, .5);
  near(next.position.y, .5625);
});

test('corner and pinch scale both axes without overwriting nonuniform scale', () => {
  for (const mode of ['corner', 'move']) {
    const base = { ...geometry(), scale: 2, scaleX: 3, scaleY: .4 };
    const gesture = createLayerGesture(base);
    const center = point(210, 420);
    const initial = mode === 'corner' ? [point(center.x + 100, center.y)] : [point(110, 420), point(310, 420, 2)];
    const nextTouches = mode === 'corner' ? [point(center.x + 200, center.y)] : [point(10, 420), point(410, 420, 2)];
    gesture.begin(mode, initial, size);
    const next = gesture.update(nextTouches);
    near(next.scale, 4);
    near(next.scaleX, 3);
    near(next.scaleY, .4);
    near(next.position.x, .5);
    near(next.position.y, .5);
  }
});

test('pinch pivots around its centroid and preserves angle across wraparound', () => {
  const gesture = createLayerGesture(geometry());
  gesture.begin('move', [point(210, 420), point(310, 420, 2)], size);
  const next = gesture.update([point(260, 370), point(260, 470, 2)]);
  near(next.rotation, 90);
  near(next.position.x, .625);
  near(next.position.y, .4375);
});

test('touch membership rebases synchronously despite stale props, reordered IDs, and frame backlog', () => {
  const initial = geometry();
  const gesture = createLayerGesture(initial);
  gesture.begin('move', [point(0, 0)], size);
  gesture.update([point(80, 80)]);
  gesture.sync(initial);
  near(gesture.current().position.x, .7);
  gesture.update([point(180, 80, 2), point(80, 80)]);
  const enlarged = gesture.update([point(230, 80, 2), point(30, 80)]);
  near(enlarged.scale, 2);
  gesture.update([point(30, 80)]);
  const moved = gesture.update([point(70, 80)]);
  near(moved.scale, 2);
  near(moved.position.x, enlarged.position.x + .1);
  assert.equal(gesture.end(), moved);
  assert.equal(gesture.end(), undefined);
  gesture.begin('right', [point(0, 0)], size);
  near(gesture.current().scale, 2);
});

test('a selected owner rejects competing responders and clamps only degenerate box inversion', () => {
  const gesture = createLayerGesture(geometry());
  assert.equal(gesture.begin('right', [point(0, 0)], size), true);
  assert.equal(gesture.begin('move', [point(0, 0)], size), false);
  const tiny = gesture.update([point(-1e5, 0)]);
  near(layerExtent(tiny).width * size.width, 1);
  assert.ok(tiny.scaleX > 0);
  const large = gesture.update([point(1e5, 0)]);
  assert.ok(large.scaleX > 400);
});

test('frame scheduling coalesces latest geometry and cancellation prevents stale publication', () => {
  const callbacks = new Map();
  const published = [];
  let sequence = 0;
  const queue = createGeometryFrameQueue(cb => { callbacks.set(++sequence, cb); return sequence; }, id => callbacks.delete(id), value => published.push(value));
  for (let i = 0; i < 100; i++) queue.push(i);
  assert.equal(sequence, 1);
  callbacks.get(1)();
  assert.deepEqual(published, [99]);
  queue.push(100);
  queue.clear();
  assert.equal(callbacks.has(2), false);
});

function project() {
  return decodeVersionTwoProject({
    schemaVersion: 2, id: 'scale-project', name: 'Scaling', createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z',
    sources: [{ id: 'source', uri: 'file:///video.mp4', displayName: 'Video', durationMs: 2000, width: 1080, height: 1920, rotation: 0 }],
    clips: [{ id: 'clip', sourceId: 'source', sourceStartMs: 0, sourceEndMs: 2000 }],
    transcription: { language: 'en', modelId: 'fast', words: [] },
    captions: [{ id: 'caption', text: 'Latin\n\u4e16\u754c \u0645\u0631\u062d\u0628\u0627 \ud83d\udc69\u200d\ud83d\udcbb', startMs: 0, endMs: 2000, wordIds: [] }],
    projectStyle: { ...structuredClone(DEFAULT_CAPTION_STYLE), scale: undefined, scaleX: undefined, scaleY: undefined },
    layers: [{ id: 'captions', kind: 'captions', name: 'Captions', visible: true },
      { id: 'text', kind: 'text', name: 'Text', visible: true, text: 'Keep\nall lines', startMs: 0, endMs: 2000 },
      { id: 'image', kind: 'image', name: 'Image', visible: true, uri: 'file:///image.png', startMs: 0, endMs: 2000, ...geometry(), opacity: 1 }],
  });
}

test('old projects hydrate identity scale and scaling survives persistence, caption overrides, text, image and native serialization', () => {
  const value = project();
  assert.equal(value.projectStyle.scale, 1);
  for (const layer of value.layers.slice(1)) assert.equal((layer.kind === 'text' ? layer.style : layer).scaleY, 1);
  const patch = { scale: 7, scaleX: .125, scaleY: 3, rotation: 37 };
  value.captions[0].styleOverride = patch;
  value.layers[1].style = mergeStyle(value.layers[1].style, patch);
  Object.assign(value.layers[2], patch);
  const restored = decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(value)));
  const plan = toNativeRenderPlan(buildTimelineRenderPlan(restored));
  for (const transform of [plan.captions[0].style, plan.layers[1].style, plan.layers[2]]) {
    for (const key of Object.keys(patch)) assert.equal(transform[key], patch[key]);
  }
  assert.equal(plan.captions[0].text, value.captions[0].text);
  assert.match(serializeAss(restored), /\\fscx87\.5\\fscy2100/);
  const native = serializeStyle({ ...value.projectStyle, ...patch }, new Map());
  assert.equal(native.fontSize, DEFAULT_CAPTION_STYLE.fontSize);
});

test('scale validation rejects non-finite, nonnumeric, zero and reflected input without silently clamping', () => {
  for (const value of [NaN, Infinity, -Infinity, 0, -1, '2', null]) {
    assert.throws(() => positiveLayerScale(value), /positive finite/);
    assert.throws(() => resolveLayerGeometry({ ...geometry(), scaleX: value }), /positive finite/);
  }
  const invalid = project();
  invalid.layers[1].style.scaleY = 0;
  assert.throws(() => serializeProjectSnapshot(invalid), /positive finite/);
});
