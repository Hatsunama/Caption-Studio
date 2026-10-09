import assert from 'node:assert/strict';
import test from 'node:test';
import { createLayerGesture, layerExtent, positiveLayerScale } from '../src/lib/layer-geometry.ts';

const point = (x, y, id = 1) => ({ x, y, id });
const base = (patch = {}) => ({ position: { x: .5, y: .5 }, box: { width: .5, height: .06 }, rotation: 0, scale: 1, scaleX: 1, scaleY: 1, ...patch });
const sizes = [ { width: 360, height: 640, pageX: 13, pageY: 29 }, { width: 180, height: 320, pageX: 13, pageY: 29 } ];
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const center = (value, size) => point(size.pageX + value.position.x * size.width, size.pageY + value.position.y * size.height);
const shape = value => ({ box: value.box, scale: value.scale, scaleX: value.scaleX, scaleY: value.scaleY, rotation: value.rotation });
const finite = value => {
  for (const key of ['scale', 'scaleX', 'scaleY']) positiveLayerScale(value[key]);
  const extent = layerExtent(value);
  for (const dimension of Object.values(extent)) assert.ok(Number.isFinite(dimension) && dimension > 0 && dimension <= 10);
  assert.ok(Number.isFinite(value.rotation));
  for (const coordinate of Object.values(value.position)) assert.ok(Number.isFinite(coordinate) && coordinate >= -4 && coordinate <= 4);
};
const opposite = (value, size, mode) => {
  const horizontal = mode === 'left' || mode === 'right';
  const sign = mode === 'left' || mode === 'top' ? -1 : 1;
  const radians = value.rotation * Math.PI / 180;
  const axis = horizontal ? [Math.cos(radians), Math.sin(radians)] : [-Math.sin(radians), Math.cos(radians)];
  const extent = layerExtent(value);
  const length = horizontal ? extent.width * size.width : extent.height * size.height;
  const origin = center(value, size);
  return [origin.x - sign * length * axis[0] / 2, origin.y - sign * length * axis[1] / 2];
};

for (const delta of [0, .02]) {
  test(`actual move ${delta}: window size cannot resize saved content`, () => {
    const results = sizes.map(size => {
      const initial = base();
      const gesture = createLayerGesture(initial);
      assert.equal(gesture.begin('move', [point(40, 50)], size), true);
      const next = gesture.update([point(40 + delta * size.width, 50)]);
      assert.deepEqual(shape(next), shape(initial));
      near(next.position.x, .5 + delta);
      near(next.position.y, .5);
      assert.equal(gesture.end(), next);
      return next;
    });
    near(results[0].position.x, results[1].position.x);
    assert.deepEqual(shape(results[0]), shape(results[1]));
  });
}

for (const mode of ['left', 'right', 'top', 'bottom']) {
  for (const rotation of [0, 37, 90]) {
    test(`${mode} at ${rotation} degrees: resize only its axis and retain opposite edge across windows`, () => {
      const results = sizes.map(size => {
        const horizontal = mode === 'left' || mode === 'right';
        const initial = base({ rotation, box: { width: .03, height: .06 } });
        const radians = rotation * Math.PI / 180;
        const axis = horizontal ? [Math.cos(radians), Math.sin(radians)] : [-Math.sin(radians), Math.cos(radians)];
        const sign = mode === 'left' || mode === 'top' ? -1 : 1;
        const original = (horizontal ? .03 * size.width : .06 * size.height);
        const start = center(initial, size);
        const gesture = createLayerGesture(initial);
        gesture.begin(mode, [start], size);
        const next = gesture.update([point(start.x + sign * original * .25 * axis[0], start.y + sign * original * .25 * axis[1])]);
        near(next[horizontal ? 'scaleX' : 'scaleY'], 1.25);
        near(next[horizontal ? 'scaleY' : 'scaleX'], 1);
        assert.deepEqual(next.box, initial.box);
        near(next.scale, 1);
        near(next.rotation, rotation);
        opposite(next, size, mode).forEach((coordinate, index) => near(coordinate, opposite(initial, size, mode)[index]));
        return next;
      });
      near(results[0].position.x, results[1].position.x);
      near(results[0].position.y, results[1].position.y);
      assert.deepEqual(shape(results[0]), shape(results[1]));
    });
  }
}

for (const mode of ['corner', 'pinch']) {
  for (const ratio of [1, .001, 2, 1e5]) {
    test(`${mode} ratio ${ratio}: uniform scale retains anisotropy across windows`, () => {
      const results = sizes.map(size => {
        const initial = base({ scaleX: .6, scaleY: .4 });
        const c = center(initial, size);
        const radius = size.width * .2;
        const start = mode === 'corner' ? [point(c.x + radius, c.y)] : [point(c.x - radius, c.y), point(c.x + radius, c.y, 2)];
        const target = mode === 'corner' ? [point(c.x + radius * ratio, c.y)] : [point(c.x - radius * ratio, c.y), point(c.x + radius * ratio, c.y, 2)];
        const gesture = createLayerGesture(initial);
        gesture.begin(mode === 'pinch' ? 'move' : mode, start, size);
        const next = gesture.update(target);
        near(next.scale, Math.min(ratio, 10 / (.5 * .6)));
        near(next.scaleX, initial.scaleX);
        near(next.scaleY, initial.scaleY);
        near(next.position.x, .5);
        near(next.position.y, .5);
        finite(next);
        return next;
      });
      near(results[0].scale, results[1].scale);
    });
  }
}

test('collapsed edges remain positive and anchored without a pixel content minimum', () => {
  for (const size of sizes) for (const mode of ['left', 'right', 'top', 'bottom']) {
    const initial = base();
    const horizontal = mode === 'left' || mode === 'right';
    const sign = mode === 'left' || mode === 'top' ? -1 : 1;
    const gesture = createLayerGesture(initial);
    gesture.begin(mode, [point(0, 0)], size);
    const next = gesture.update([point(horizontal ? -sign * 1e5 : 0, horizontal ? 0 : -sign * 1e5)]);
    finite(next);
    assert.ok(layerExtent(next)[horizontal ? 'width' : 'height'] * (horizontal ? size.width : size.height) < 1);
    opposite(next, size, mode).forEach((coordinate, index) => near(coordinate, opposite(initial, size, mode)[index]));
  }
});

test('maximum edge extent is applied before rotated opposite-edge positioning', () => {
  const size = sizes[1];
  const initial = base({ rotation: 90 });
  const gesture = createLayerGesture(initial);
  gesture.begin('right', [point(0, 0)], size);
  const next = gesture.update([point(0, 1e5)]);
  near(layerExtent(next).width, 10);
  opposite(next, size, 'right').forEach((coordinate, index) => near(coordinate, opposite(initial, size, 'right')[index]));
  finite(next);
});

test('offscreen small content is positionally recoverable without changing its extent', () => {
  for (const size of sizes) {
    const initial = base({ box: { width: .01, height: .01 } });
    const gesture = createLayerGesture(initial);
    gesture.begin('move', [point(0, 0)], size);
    const next = gesture.update([point(-1e5, 1e5)]);
    assert.deepEqual(shape(next), shape(initial));
    near(next.position.x, 0);
    near(next.position.y, 1);
    finite(next);
    gesture.end();
    gesture.begin('move', [point(0, 0)], size);
    const recovered = gesture.update([point(size.width * .1, -size.height * .1)]);
    near(recovered.position.x, .1);
    near(recovered.position.y, .9);
  }
});

test('membership, centroid rotation, end/cancellation boundary and prop sync retain small geometry', () => {
  const initial = base();
  const size = sizes[1];
  const gesture = createLayerGesture(initial);
  assert.equal(gesture.begin('move', [], size), false);
  gesture.begin('move', [point(0, 0)], size);
  assert.equal(gesture.begin('right', [point(0, 0)], size), false);
  const moved = gesture.update([point(3.6, 0)]);
  gesture.sync(base({ scale: 2 }));
  assert.equal(gesture.current(), moved);
  assert.equal(gesture.update([]), moved);
  const c = center(moved, size);
  assert.equal(gesture.update([point(c.x + 20, c.y, 2), point(c.x - 20, c.y)]), moved);
  const rotated = gesture.update([point(c.x, c.y + 20, 2), point(c.x, c.y - 20)]);
  near(rotated.rotation, 90);
  near(rotated.position.x, moved.position.x);
  near(rotated.position.y, moved.position.y);
  near(rotated.scale, 1);
  near(rotated.scaleY, 1);
  assert.equal(gesture.update([point(0, 0)]), rotated);
  const final = gesture.update([point(1.8, 0)]);
  near(final.position.x, rotated.position.x + .01);
  assert.equal(gesture.end(), final);
  assert.equal(gesture.active(), false);
  assert.equal(gesture.end(), undefined);
  assert.equal(gesture.update([point(1e5, 1e5)]), final);
  gesture.sync(initial);
  assert.deepEqual(gesture.current(), initial);
});

test('unlocated multi-touch and corner ownership do not transform content', () => {
  const initial = base();
  const gesture = createLayerGesture(initial);
  const size = { ...sizes[1], located: false };
  assert.equal(gesture.begin('corner', [point(20, 20)], size), false);
  assert.equal(gesture.begin('move', [point(0, 0), point(20, 0, 2)], size), true);
  assert.deepEqual(gesture.update([point(0, 0), point(200, 200, 2)]), initial);
});
