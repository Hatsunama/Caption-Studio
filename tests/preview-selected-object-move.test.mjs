import assert from 'node:assert/strict';
import test from 'node:test';
import { previewInteractionAtPoint, previewObjectAtPoint } from '../src/lib/preview-object-hit-test.ts';
import { createPreviewSceneController } from '../src/lib/preview-scene-controller.ts';

const size = { width: 400, height: 300 };
const origin = { pageX: 71, pageY: 129 };
const geometry = (rotation = 0, width = .4, height = .4) => ({
  position: { x: .5, y: .5 }, box: { width, height },
  rotation, scale: 1, scaleX: 1, scaleY: 1,
});
const point = (id = 7, x = 200, y = 150) => ({ id, x: origin.pageX + x, y: origin.pageY + y });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const scenarios = [
  ['PiP', { kind: 'video-overlay', id: 'pip' }],
  ['image', { kind: 'image', id: 'image' }],
  ['text', { kind: 'text', id: 'text' }],
  ['watermark', { kind: 'text', id: 'watermark' }],
  ['primary caption', { kind: 'captions', captionId: 'cue' }, 'captions'],
  ['translated caption', { kind: 'translation', id: 'fr', captionId: 'cue' }, 'translation:fr'],
];

function setup(scenario = scenarios[0], rotation = 0) {
  const [label, selection, transformKey] = scenario;
  const lower = { key: `lower:${label}`, selection, transformKey,
    geometry: geometry(rotation), order: 1, deletable: selection.kind !== 'translation' };
  const front = { key: 'front', selection: { kind: 'image', id: 'front' },
    geometry: geometry(0, .9, .9), order: 2, deletable: true };
  const main = { key: 'main', selection: { kind: 'video', id: 'main' },
    geometry: geometry(0, 1, 1), order: -1, yieldToForeground: true };
  const targets = [main, lower, front], before = structuredClone(targets);
  const calls = { selections: [], changes: [], deletes: [], starts: 0, ends: 0 };
  const c = createPreviewSceneController();
  let options = { targets, selectedKey: lower.key, enabled: true, contextKey: 'project:0',
    onSelect(value) {
      calls.selections.push(value);
      configure({ selectedKey: targets.find(t => t.selection === value).key });
    },
    onClearSelection() { assert.fail('main fills the canvas'); },
    onChange(target, draft) { calls.changes.push({ key: target.key, draft }); },
    onDelete(target) { calls.deletes.push(target.key); },
    onInteractionStart() { calls.starts++; }, onInteractionEnd() { calls.ends++; },
  };
  function configure(next) { options = { ...options, ...next }; c.configure(options); }
  configure({}); c.layout(size);
  return { c, calls, lower, front, main, targets, configure,
    draft() { return c.geometryFor(lower.key, lower.geometry); },
    preserved() {
      assert.deepEqual(targets, before);
      for (const t of [main, front]) assert.deepEqual(c.geometryFor(t.key, t.geometry), t.geometry);
    },
    balanced(n) { assert.equal(calls.starts, n); assert.equal(calls.ends, n); },
    tap() { c.grant([point()], origin); c.end([], [point()]); c.release(); },
  };
}

for (const scenario of scenarios) {
  test(`${scenario[0]}: timeline-selected lower body owns a single-finger drag`, () => {
    const h = setup(scenario), { c } = h;
    assert.equal(previewObjectAtPoint(h.targets, { x: 200, y: 150 }, size).key, 'front');
    c.grant([point()], origin);
    assert.equal(c.selectedKey, h.lower.key, 'selected body must capture before foreground');
    c.move([point(7, 220, 180)]);
    near(h.draft().position.x, .55); near(h.draft().position.y, .6);
    assert.equal(h.calls.changes.length, 0); h.preserved();
    c.end([], [point(7, 240, 180)]); c.release(); c.release();
    assert.deepEqual(h.calls.changes.map(v => v.key), [h.lower.key]);
    near(h.calls.changes[0].draft.position.x, .6);
    assert.deepEqual(h.calls.selections, [h.lower.selection]);
    assert.deepEqual(h.calls.deletes, []); h.balanced(1); h.preserved();
  });

  for (const secondX of [300, 395, 500]) for (const simultaneous of [false, true]) {
    test(`${scenario[0]}: ${simultaneous ? 'simultaneous' : 'staggered'} second finger at ${secondX} retains lower owner`, () => {
      const h = setup(scenario), { c } = h;
      c.grant(simultaneous ? [point(), point(2, secondX)] : [point()], origin);
      if (!simultaneous) c.start([point(2, secondX), point()]);
      c.start([point(0, 50, 20), point(2, secondX), point()]);
      c.move([point(2, secondX + 25), point(0, 350, 280), point(7, 175)]);
      assert.equal(c.selectedKey, h.lower.key);
      near(h.draft().scale, (secondX - 150) / (secondX - 200));
      near(h.draft().position.x, .4375); near(h.draft().rotation, 0);
      assert.equal(h.calls.changes.length, 0); h.preserved();
      c.end([point(2, secondX + 25)], [point(7, 175), point(0, 350, 280)]);
      c.move([point(2, secondX + 45)]);
      near(h.draft().position.x, .4875);
      c.end([], [point(2, secondX + 45)]);
      const drained = structuredClone(h.draft());
      c.start([point(2), point(3, 300)]); c.move([point(2, 100), point(3, 390)]);
      c.release(); c.release();
      assert.deepEqual(h.calls.changes, [{ key: h.lower.key, draft: drained }]);
      h.balanced(1); h.preserved();
    });
  }
}

test('no selection, missing selection, and points outside selected body acquire actual foreground', () => {
  const h = setup();
  for (const selected of [undefined, 'missing', h.lower.key]) {
    const p = selected === h.lower.key ? { x: 340, y: 150 } : { x: 200, y: 150 };
    assert.equal(previewInteractionAtPoint(h.targets, selected, p, size, true).target.key, 'front');
    h.configure({ selectedKey: selected });
    h.c.grant([point(7, p.x, p.y)], origin);
    h.c.end([], [point(7, p.x + 10, p.y)]); h.c.release();
    assert.equal(h.calls.changes.at(-1).key, 'front');
  }
  h.balanced(3); h.preserved();
});

test('selected main video still yields body and chrome hits to foreground', () => {
  const h = setup();
  for (const p of [{ x: 200, y: 150 }, { x: 390, y: 150 }]) {
    const covering = [h.main, h.lower, { ...h.front, geometry: geometry(0, 1, 1) }];
    assert.equal(previewInteractionAtPoint(covering, 'main', p, size).target.key, 'front');
  }
  h.configure({ selectedKey: 'main' });
  h.c.grant([point()], origin); h.c.end([], [point(7, 220)]); h.c.release();
  assert.deepEqual(h.calls.changes.map(v => v.key), ['front']); h.balanced(1);
  h.configure({ targets: [h.main], selectedKey: 'main' });
  h.c.grant([point()], origin); h.c.end([], [point(7, 220)]); h.c.release();
  assert.equal(h.calls.changes.at(-1).key, 'main'); h.balanced(2);
});

test('selected lower delete, corner, and all edge handles keep their existing priority', () => {
  for (const [mode, x, y] of [['delete', 120, 90], ['corner', 280, 210],
    ['left', 120, 150], ['right', 280, 150], ['top', 200, 90], ['bottom', 200, 210]]) {
    const h = setup();
    const hit = previewInteractionAtPoint(h.targets, h.lower.key, { x, y }, size, true);
    assert.equal(hit.target.key, h.lower.key); assert.equal(hit.mode, mode);
    h.c.grant([point(7, x, y)], origin);
    h.c.end([], [point(7, x + (['delete', 'top', 'bottom'].includes(mode) ? 0 : 10),
      y + (['top', 'bottom'].includes(mode) ? 10 : 0))]); h.c.release();
    if (mode === 'delete') { assert.deepEqual(h.calls.deletes, [h.lower.key]); h.balanced(0); }
    else { assert.equal(h.calls.changes[0].key, h.lower.key); h.balanced(1); }
    h.preserved();
  }
  const h = setup(scenarios[5]);
  assert.notEqual(previewInteractionAtPoint(h.targets, h.lower.key, { x: 120, y: 90 }, size, false).mode, 'delete');
});

test('rotated selected body uses local bounds and selected chrome still works outside the body', () => {
  const h = setup(scenarios[1], 90);
  const targets = [h.main, { ...h.lower, geometry: geometry(90, .6, .2) }, h.front];
  const hit = p => previewInteractionAtPoint(targets, h.lower.key, p, size, true);
  assert.equal(hit({ x: 220, y: 195 }).target.key, h.lower.key);
  assert.equal(hit({ x: 220, y: 195 }).mode, 'move');
  assert.equal(hit({ x: 250, y: 150 }).target.key, 'front');
  assert.equal(hit({ x: 200, y: 280 }).mode, 'right');
});

test('repeated true taps cycle overlapping objects only on release; drag clears tap history', () => {
  const h = setup(), { c } = h;
  h.tap();
  assert.equal(c.selectedKey, h.lower.key);
  for (const next of ['main', 'front', h.lower.key]) {
    const current = c.selectedKey;
    c.grant([point()], origin); assert.equal(c.selectedKey, current === 'main' ? 'front' : current);
    const captured = c.selectedKey;
    c.end([], [point()]); assert.equal(c.selectedKey, captured);
    c.release(); c.release(); assert.equal(c.selectedKey, next);
  }
  assert.equal(h.calls.changes.length, 0);
  c.grant([point()], origin); c.end([], [point(7, 220)]); c.release();
  assert.deepEqual(h.calls.changes.map(v => v.key), [h.lower.key]);
  h.tap(); assert.equal(c.selectedKey, h.lower.key); h.balanced(6); h.preserved();
});

for (const invalidation of ['cancel', 'rotation-layout', 'origin', 'context', 'remove', 'geometry', 'disable', 'transform-key']) {
  test(`${invalidation}: selected lower draft cancels without a commit and next grant recovers`, () => {
    const h = setup(), { c } = h;
    c.grant([point()], origin); c.move([point(7, 220)]);
    near(h.draft().position.x, .55);
    if (invalidation === 'cancel') c.cancel();
    if (invalidation === 'rotation-layout') c.layout({ width: 300, height: 400 });
    if (invalidation === 'origin') c.locate({ ...origin, pageY: origin.pageY + 50 });
    if (invalidation === 'context') h.configure({ contextKey: 'other:0' });
    if (invalidation === 'remove') h.configure({ targets: [h.main, h.front] });
    if (invalidation === 'geometry') h.configure({ targets: [h.main, { ...h.lower, geometry: geometry(45) }, h.front] });
    if (invalidation === 'disable') h.configure({ enabled: false });
    if (invalidation === 'transform-key') h.configure({ targets: [h.main, { ...h.lower, transformKey: 'replacement' }, h.front] });
    c.end([], [point(7, 240)]); c.release(); c.cancel();
    assert.equal(c.active, false); assert.deepEqual(h.calls.changes, []);
    assert.deepEqual(h.draft(), h.lower.geometry); h.balanced(1); h.preserved();
    h.configure({ targets: h.targets, enabled: true, selectedKey: h.lower.key }); c.layout(size);
    c.grant([point()], origin); c.end([], [point(7, 220)]); c.release();
    assert.equal(h.calls.changes[0].key, h.lower.key); h.balanced(2); h.preserved();
  });
}

test('selection rerender and target reorder retain captured lower geometry and pointer identity', () => {
  const h = setup(scenarios[4]), { c } = h;
  c.grant([point()], origin);
  h.configure({ selectedKey: 'front', targets: h.targets.map(t => structuredClone(t)).reverse() });
  c.start([point(2, 300), point()]);
  c.move([point(2, 200, 250), point(7, 200, 50)]);
  assert.equal(c.selectedKey, h.lower.key);
  near(h.draft().scale, 2); near(h.draft().rotation, 90);
  c.end([point(7, 200, 50)], [point(2, 200, 250)]);
  c.start([point(2, 300, 50), point(7, 200, 50)]);
  c.move([point(7, 175, 50), point(2, 325, 50)]);
  near(h.draft().scale, 3); near(h.draft().rotation, 90);
  c.end([], [point(2, 325, 50), point(7, 175, 50)]); c.release();
  assert.deepEqual(h.calls.changes.map(v => v.key), [h.lower.key]);
  assert.equal(c.selectedKey, 'front'); h.balanced(1); h.preserved();
});
