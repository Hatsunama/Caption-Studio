import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { constrainLayerGeometry, layerExtent } from '../src/lib/layer-geometry.ts';
import { previewCanvasPoint, previewInteractionAtPoint, previewObjectAtPoint,
  previewObjectContainsPoint } from '../src/lib/preview-object-hit-test.ts';

const requireLocal = createRequire(import.meta.url);
const size = { width: 400, height: 300 };
const origin = { pageX: 73, pageY: 149 };
const geometry = (x = 0.5, y = 0.5, width = 0.4, height = 0.4, rotation = 0) => ({
  position: { x, y }, box: { width, height }, rotation, scale: 1, scaleX: 1, scaleY: 1,
});
const target = (key, value, order = 1) => ({ key, selection: key, geometry: value, order });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const touch = (identifier, x, y) => ({ identifier, pageX: origin.pageX + x, pageY: origin.pageY + y,
  // Child-local coordinates must never substitute for canvas-local coordinates.
  locationX: 9999, locationY: -9999 });
const event = (touches, changedTouches = touches) => ({ nativeEvent: { touches, changedTouches } });
const plain = (value) => JSON.parse(JSON.stringify(value));

// Execute the real hook and geometry code; mock only React lifecycle, native
// measurement, and frame scheduling. Each render retains hook slots and refs.
function scene(initialTargets, selectedKey) {
  const slots = [];
  const frames = new Map();
  const effects = [];
  const calls = { select: [], clear: 0, start: 0, end: 0, changes: [], deletes: [] };
  let cursor = 0;
  let frameId = 0;
  let result;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useRef(value) { const index = cursor++; slots[index] ??= { current: value }; return slots[index]; },
    useState(value) {
      const index = cursor++;
      slots[index] ??= { value };
      return [slots[index].value, (next) => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }];
    },
    useMemo(factory, deps) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { deps, value: factory() };
      return slots[index].value;
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) {
        slots[index]?.cleanup?.();
        slots[index] = { deps };
        effects.push(() => { slots[index].cleanup = fn(); });
      }
    },
  };
  const exports = {};
  const source = readFileSync(new URL('../src/hooks/use-preview-scene-gesture.ts', import.meta.url), 'utf8');
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText, {
    exports,
    requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
    require(name) {
      if (name === 'react') return react;
      if (name.startsWith('@/lib/')) return requireLocal('../src/lib/' + name.slice(6) + '.ts');
      throw new Error('Unexpected runtime dependency: ' + name);
    },
  });
  const tracked = initialTargets.map((item) => ({ ...item, deletable: true }));
  let options = { targets: tracked, selectedKey, enabled: true,
    onSelect(key) { calls.select.push(key); }, onClearSelection() { calls.clear++; },
    onChange(item, value) { calls.changes.push({ key: item.key, geometry: plain(value) }); },
    onDelete(item) { calls.deletes.push(item.key); },
    onInteractionStart() { calls.start++; }, onInteractionEnd() { calls.end++; },
  };
  function render(update = {}) {
    options = { ...options, ...update };
    cursor = 0;
    result = exports.usePreviewSceneGesture(options);
    effects.splice(0).forEach((effect) => effect());
    return result;
  }
  render();
  result.canvasRef.current = { measureInWindow(callback) { callback(origin.pageX, origin.pageY); } };
  result.onLayout({ nativeEvent: { layout: size } });
  return { calls, render, targets: tracked,
    get handlers() { return result.responders; },
    get result() { return result; },
    get pendingFrames() { return frames.size; },
    frame() { const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn()); render(); },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

for (const selectedKey of [undefined, 'second']) {
  test(`first touch selects and drags the first sticker while selected=${selectedKey}`, () => {
    const s = scene([target('first', geometry(0.25, 0.5, 0.2, 0.2)),
      target('second', geometry(0.75, 0.5, 0.2, 0.2), 2)], selectedKey);
    s.handlers.onResponderGrant(event([touch(7, 100, 150)]));
    s.render({ selectedKey: 'first' });
    s.handlers.onResponderMove(event([touch(7, 140, 180)]));
    s.handlers.onResponderRelease();
    assert.deepEqual(s.calls.select, ['first']);
    assert.equal(s.calls.changes.length, 1);
    assert.equal(s.calls.changes[0].key, 'first');
    near(s.calls.changes[0].geometry.position.x, 0.35);
    near(s.calls.changes[0].geometry.position.y, 0.6);
    assert.equal(s.calls.start, 1);
    assert.equal(s.calls.end, 1);
  });
}

test('page conversion subtracts the measured canvas origin, including negative offsets', () => {
  assert.deepEqual(previewCanvasPoint(173, 299, origin), { x: 100, y: 150 });
  assert.deepEqual(previewCanvasPoint(20, 40, { pageX: -10, pageY: -60 }), { x: 30, y: 100 });
});

test('overlap chooses saved scene order for the body regardless of selection or array order', () => {
  const back = target('back', geometry(), 1);
  const front = target('front', geometry(), 8);
  for (const targets of [[back, front], [front, back]]) {
    assert.equal(previewObjectAtPoint(targets, { x: 200, y: 150 }, size).key, 'front');
    const hit = previewInteractionAtPoint(targets, 'back', { x: 200, y: 150 }, size, true);
    assert.equal(hit.target.key, 'front');
    assert.equal(hit.mode, 'move');
  }
});

test('three stickers remain independently selectable and empty canvas clears selection', () => {
  const targets = [0.2, 0.5, 0.8].map((x, index) => target(`sticker-${index}`, geometry(x, 0.5, 0.15, 0.2), index));
  const s = scene(targets, 'sticker-2');
  for (let index = 0; index < 3; index++) {
    s.handlers.onResponderGrant(event([touch(index, targets[index].geometry.position.x * size.width, 150)]));
    s.handlers.onResponderRelease();
  }
  s.handlers.onResponderGrant(event([touch(9, 10, 10)]));
  s.handlers.onResponderMove(event([touch(9, 200, 150)]));
  s.handlers.onResponderRelease();
  assert.deepEqual(s.calls.select, ['sticker-0', 'sticker-1', 'sticker-2']);
  assert.equal(s.calls.clear, 1);
  assert.equal(s.calls.changes.length, 0);
});

test('a foreign sticker finger cannot steal, scale, or continue the owning sticker gesture', () => {
  const s = scene([target('first', geometry(0.25, 0.5, 0.2, 0.2)), target('second', geometry(0.75, 0.5, 0.2, 0.2), 2)]);
  s.handlers.onResponderGrant(event([touch(7, 100, 150)]));
  s.handlers.onResponderStart(event([touch(2, 300, 150), touch(7, 100, 150)], [touch(2, 300, 150)]));
  s.render({ selectedKey: 'second', targets: [...s.targets].reverse() });
  s.handlers.onResponderMove(event([touch(2, 350, 240), touch(7, 120, 150)]));
  s.frame();
  assert.equal(s.calls.changes.length, 1);
  near(s.calls.changes[0].geometry.position.x, 0.3);
  near(s.calls.changes[0].geometry.scale, 1);
  s.handlers.onResponderEnd(event([touch(2, 350, 240)], [touch(7, 120, 150)]));
  s.handlers.onResponderMove(event([touch(2, 10, 10)]));
  s.handlers.onResponderRelease();
  assert.deepEqual(s.calls.changes.map((change) => change.key), ['first']);
  assert.deepEqual(s.calls.select, ['first']);
  assert.equal(s.calls.end, 1);
});

test('same-object pinch survives reversed touch order and rebases to one finger without jumping', () => {
  const s = scene([target('first', geometry())]);
  s.handlers.onResponderGrant(event([touch(7, 180, 150)]));
  s.handlers.onResponderStart(event([touch(2, 220, 150), touch(7, 180, 150)], [touch(2, 220, 150)]));
  s.handlers.onResponderMove(event([touch(7, 160, 150), touch(2, 240, 150)]));
  s.frame();
  near(s.calls.changes.at(-1).geometry.scale, 2);
  near(s.calls.changes.at(-1).geometry.position.x, 0.5);
  s.handlers.onResponderEnd(event([touch(7, 160, 150)], [touch(2, 240, 150)]));
  s.handlers.onResponderMove(event([touch(7, 180, 150)]));
  s.handlers.onResponderRelease();
  near(s.calls.changes.at(-1).geometry.scale, 2);
  near(s.calls.changes.at(-1).geometry.position.x, 0.55);
});

test('second finger can join the current moved sticker bounds, not its obsolete grant bounds', () => {
  const s = scene([target('first', geometry(0.25, 0.5, 0.2, 0.2))]);
  s.handlers.onResponderGrant(event([touch(7, 100, 150)]));
  s.handlers.onResponderMove(event([touch(7, 200, 150)]));
  s.frame();
  const moved = s.calls.changes.at(-1).geometry;
  s.render({ selectedKey: 'first', targets: [{ ...s.targets[0], geometry: moved }] });
  s.handlers.onResponderStart(event([touch(7, 200, 150), touch(8, 220, 150)], [touch(8, 220, 150)]));
  s.handlers.onResponderMove(event([touch(8, 240, 150), touch(7, 200, 150)]));
  s.handlers.onResponderRelease();
  near(s.calls.changes.at(-1).geometry.scale, 2);
});

for (const [mode, x, y] of [['delete', 120, 90], ['left', 120, 150], ['right', 280, 150],
  ['top', 200, 90], ['bottom', 200, 210], ['corner', 280, 210], ['move', 200, 150]]) {
  test(`selected ${mode} has an exclusive action even with another object behind it`, () => {
    const s = scene([target('behind', geometry(0.5, 0.5, 0.8, 0.8), 0), target('selected', geometry(), 1)], 'selected');
    const hit = previewInteractionAtPoint(s.targets, 'selected', { x, y }, size, true);
    assert.equal(hit.mode, mode);
    s.handlers.onResponderGrant(event([touch(3, x, y)]));
    s.handlers.onResponderMove(event([touch(3, x + 10, y + 10)]));
    s.handlers.onResponderRelease();
    s.handlers.onResponderRelease();
    assert.deepEqual(s.calls.select, ['selected']);
    assert.deepEqual(s.calls.deletes, mode === 'delete' ? ['selected'] : []);
    assert.equal(s.calls.start, mode === 'delete' ? 0 : 1);
    assert.equal(s.calls.end, mode === 'delete' ? 0 : 1);
    assert.equal(s.calls.changes.length, mode === 'delete' ? 0 : 1);
    if (mode === 'left' || mode === 'right') {
      near(s.calls.changes[0].geometry.scaleY, 1);
      near(s.calls.changes[0].geometry.scale, 1);
    }
    if (mode === 'top' || mode === 'bottom') {
      near(s.calls.changes[0].geometry.scaleX, 1);
      near(s.calls.changes[0].geometry.scale, 1);
    }
    if (mode === 'corner') {
      near(s.calls.changes[0].geometry.position.x, 0.5);
      near(s.calls.changes[0].geometry.position.y, 0.5);
    }
  });
}

test('unselected chrome coordinates select and move rather than resize or delete', () => {
  const s = scene([target('first', geometry())]);
  s.handlers.onResponderGrant(event([touch(1, 120, 90)]));
  s.handlers.onResponderMove(event([touch(1, 140, 105)]));
  s.handlers.onResponderRelease();
  assert.deepEqual(s.calls.deletes, []);
  near(s.calls.changes[0].geometry.position.x, 0.55);
  near(s.calls.changes[0].geometry.scaleX, 1);
});

test('rotated chrome and anisotropic hit bounds follow the visible object axes', () => {
  const g = { ...geometry(0.5, 0.5, 0.2, 0.2, 90), scaleX: 2, scaleY: 0.5 };
  const t = target('rotated', g);
  assert.equal(previewInteractionAtPoint([t], t.key, { x: 200, y: 230 }, size).mode, 'right');
  assert.equal(previewObjectContainsPoint(g, { x: 200, y: 220 }, size), true);
  assert.equal(previewObjectContainsPoint(g, { x: 230, y: 150 }, size), false);
});

test('selected chrome remains above overlapping bodies, but a stale selection creates no chrome', () => {
  const back = target('back', geometry(), 1);
  const front = target('front', geometry(0.5, 0.5, 0.9, 0.9), 10);
  const point = { x: 120, y: 90 };
  const hit = previewInteractionAtPoint([back, front], 'back', point, size, true);
  assert.equal(hit.target.key, 'back');
  assert.equal(hit.mode, 'delete');
  assert.equal(previewInteractionAtPoint([back, front], 'removed', point, size, true).target.key, 'front');
});

test('termination cancels a pending delete instead of deleting without a completed release', () => {
  const s = scene([target('first', geometry())], 'first');
  s.handlers.onResponderGrant(event([touch(1, 120, 90)]));
  s.handlers.onResponderTerminate();
  assert.deepEqual(s.calls.deletes, []);
  assert.equal(s.calls.changes.length, 0);
});

test('frame coalescing flushes only the latest geometry once before interaction end', () => {
  const s = scene([target('first', geometry())]);
  s.handlers.onResponderGrant(event([touch(1, 200, 150)]));
  s.handlers.onResponderMove(event([touch(1, 210, 150)]));
  s.handlers.onResponderMove(event([touch(1, 240, 150)]));
  assert.equal(s.pendingFrames, 1);
  assert.equal(s.calls.changes.length, 0);
  s.handlers.onResponderRelease();
  assert.equal(s.pendingFrames, 0);
  assert.equal(s.calls.changes.length, 1);
  near(s.calls.changes[0].geometry.position.x, 0.6);
  s.frame();
  assert.equal(s.calls.changes.length, 1);
  assert.equal(s.result.geometryFor('first', s.targets[0].geometry), s.targets[0].geometry);
});

test('unmount cancels pending frame writes and disabled scene declines capture', () => {
  const s = scene([target('first', geometry())]);
  s.handlers.onResponderGrant(event([touch(1, 200, 150)]));
  s.handlers.onResponderMove(event([touch(1, 240, 150)]));
  s.unmount();
  assert.equal(s.pendingFrames, 0);
  assert.equal(s.calls.changes.length, 0);
  s.render({ enabled: false });
  assert.equal(s.handlers.onStartShouldSetResponderCapture(), false);
  assert.equal(s.handlers.onMoveShouldSetResponderCapture(), false);
});

test('extreme axis-aligned geometry retains a 24px recovery area and bounded dimensions', () => {
  for (const scale of [0.000001, 1, 1000000]) {
    for (const position of [-100000, 100000]) {
      const g = constrainLayerGeometry({ ...geometry(position, position), scale }, size);
      const extent = layerExtent(g);
      assert.ok(extent.width * size.width >= 24 - 1e-8);
      assert.ok(extent.height * size.height >= 24 - 1e-8);
      assert.ok(extent.width <= 10 + 1e-8 && extent.height <= 10 + 1e-8);
      const visibleWidth = Math.min(size.width, (g.position.x + extent.width / 2) * size.width)
        - Math.max(0, (g.position.x - extent.width / 2) * size.width);
      const visibleHeight = Math.min(size.height, (g.position.y + extent.height / 2) * size.height)
        - Math.max(0, (g.position.y - extent.height / 2) * size.height);
      assert.ok(visibleWidth >= Math.min(24, extent.width * size.width / 2) - 1e-8);
      assert.ok(visibleHeight >= Math.min(24, extent.height * size.height / 2) - 1e-8);
    }
  }
});

test('a rotated narrow sticker dragged beyond the canvas must remain reachable', () => {
  const s = scene([target('first', geometry(0.5, 0.5, 0.8, 0.1, 90))]);
  s.handlers.onResponderGrant(event([touch(1, 200, 150)]));
  s.handlers.onResponderMove(event([touch(1, 10000, 150)]));
  s.handlers.onResponderRelease();
  const g = s.calls.changes[0].geometry;
  // At 90 degrees the unrotated height is the visible horizontal extent.
  const leftmostVisibleX = g.position.x * size.width - layerExtent(g).height * size.height / 2;
  assert.ok(leftmostVisibleX < size.width, `sticker is wholly offscreen: left edge ${leftmostVisibleX}`);
});
