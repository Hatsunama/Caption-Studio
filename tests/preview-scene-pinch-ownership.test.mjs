import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreviewSceneController } from '../src/lib/preview-scene-controller.ts';

const size = { width: 400, height: 300 };
const origin = { pageX: 71, pageY: 129 };
const geometry = (x = 0.5, width = 0.2, height = 0.2) => ({
  position: { x, y: 0.5 }, box: { width, height }, rotation: 0, scale: 1, scaleX: 1, scaleY: 1,
});
const point = (id, x = 200, y = 150) => ({ id, x: x + origin.pageX, y: y + origin.pageY });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const selections = [
  ['video-overlay', { kind: 'video-overlay', id: 'pip' }],
  ['image', { kind: 'image', id: 'image' }],
  ['text', { kind: 'text', id: 'text' }],
  ['watermark', { kind: 'text', id: 'watermark' }],
  ['primary-cue', { kind: 'captions', captionId: 'cue' }],
  ['translation-cue', { kind: 'translation', id: 'fr', captionId: 'cue' }],
];

function setup(key = 'video-overlay', selection = selections[0][1], extraTargets = []) {
  const foreground = { key, selection, geometry: geometry(), order: 2, deletable: true,
    ...(selection.kind === 'captions' ? { transformKey: 'captions' } : {}),
    ...(selection.kind === 'translation' ? { transformKey: 'translation:fr' } : {}) };
  const main = { key: 'main', selection: { kind: 'video', id: 'main' },
    geometry: geometry(0.5, 1, 1), order: -1, yieldToForeground: true };
  const targets = [main, foreground, ...extraTargets];
  const original = structuredClone(targets);
  const calls = { selections: [], changes: [], starts: 0, ends: 0 };
  const controller = createPreviewSceneController();
  let options = { targets, selectedKey: key, enabled: true, contextKey: 'project:0',
    onSelect(selection) {
      calls.selections.push(selection);
      configure({ selectedKey: targets.find((t) => t.selection === selection).key });
    },
    onClearSelection() { assert.fail('full-canvas main should prevent empty selection'); },
    onChange(target, geometry) { calls.changes.push({ key: target.key, selection: target.selection, geometry }); },
    onDelete() { assert.fail('body gesture must not delete'); },
    onInteractionStart() { calls.starts++; }, onInteractionEnd() { calls.ends++; },
  };
  function configure(next) { options = { ...options, ...next }; controller.configure(options); }
  configure({}); controller.layout(size);
  function tap() { controller.grant([point(7)], origin); controller.end([], [point(7)]); controller.release(); }
  function preserved() {
    assert.deepEqual(targets, original);
    assert.deepEqual(controller.geometryFor('main', main.geometry), main.geometry);
  }
  function balanced(count) { assert.equal(calls.starts, count); assert.equal(calls.ends, count); }
  return { controller, calls, key, foreground, main, configure, tap, preserved, balanced,
    draft() { return controller.geometryFor(key, foreground.geometry); } };
}

for (const [key, selection] of selections) {
  test(`${key}: overlap cycles once on true tap release, never on grant or as geometry`, () => {
    const h = setup(key, selection), c = h.controller;
    h.tap();
    c.grant([point(7)], origin);
    assert.equal(c.selectedKey, key, 'first pointer must retain foreground until tap is known');
    assert.deepEqual(h.calls.selections, [selection, selection], 'pending overlap tap reselects its owner to restore editor tools');
    c.end([], [point(7)]);
    assert.equal(c.selectedKey, key, 'end alone must not cycle');
    c.release(); c.release();
    assert.equal(c.selectedKey, 'main');
    assert.deepEqual(h.calls.selections, [selection, selection, h.main.selection]);
    assert.equal(h.calls.changes.length, 0);
    h.balanced(2); h.preserved();
  });

  for (const simultaneous of [false, true]) test(`${key}: ${simultaneous ? 'simultaneous' : 'staggered'} repeat pinch adopts yielding main background`, () => {
    const h = setup(key, selection), c = h.controller;
    h.tap();
    c.grant(simultaneous ? [point(7), point(2, 300)] : [point(7)], origin);
    if (!simultaneous) c.start([point(2, 300), point(7)]);
    c.move([point(7, 150), point(2, 350)]);
    assert.equal(c.selectedKey, key);
    near(h.draft().scale, 2); near(h.draft().position.x, 0.375);
    near(h.draft().position.y, 0.5); near(h.draft().rotation, 0);
    assert.equal(h.calls.changes.length, 0);
    c.end([], [point(2, 350), point(7, 150)]); c.release(); c.release();
    assert.equal(h.calls.changes.length, 1);
    assert.equal(h.calls.changes[0].key, key);
    assert.equal(h.calls.changes[0].selection, selection);
    near(h.calls.changes[0].geometry.scale, 2);
    assert.deepEqual(h.calls.selections, [selection, selection]);
    h.balanced(2); h.preserved();
  });

  test(`${key}: repeat drag keeps captured foreground and clears the tap cycle`, () => {
    const h = setup(key, selection), c = h.controller;
    h.tap(); c.grant([point(7)], origin);
    c.end([], [point(7, 220, 180)]); c.release();
    assert.equal(h.calls.changes.length, 1); assert.equal(h.calls.changes[0].key, key);
    near(h.calls.changes[0].geometry.position.x, 0.55);
    near(h.calls.changes[0].geometry.position.y, 0.6);
    h.tap();
    assert.equal(c.selectedKey, key, 'drag must not seed a following overlap cycle');
    h.balanced(3); h.preserved();
  });

  for (const foreign of [false, true]) test(`${key}: unmoved ${foreign ? 'rejected foreground' : 'background'} second finger disqualifies this and following tap cycle`, () => {
    const other = { key: 'foreign', selection: { kind: 'image', id: 'foreign' },
      geometry: geometry(0.8), order: 3 };
    const h = setup(key, selection, foreign ? [other] : []), c = h.controller;
    h.tap(); c.grant([point(7)], origin);
    c.start([point(7), point(2, 320)]);
    c.end([point(7)], [point(2, 320)]);
    c.end([], [point(7)]); c.release();
    assert.equal(c.selectedKey, key);
    h.tap(); assert.equal(c.selectedKey, key);
    assert.equal(h.calls.changes.length, 0);
    assert.deepEqual(h.calls.selections, [selection, selection, selection]);
    h.balanced(3); h.preserved();
  });
}

test('background pinch rebases reordered/reused IDs through 2 -> 1 -> 2 and keeps third fingers out', () => {
  const h = setup(), c = h.controller;
  c.grant([point(7), point(2, 300)], origin);
  c.start([point(0, 20), point(2, 300), point(7)]);
  c.move([point(0, 390, 20), point(7, 150), point(2, 350)]);
  near(h.draft().scale, 2); near(h.draft().position.x, 0.375);
  c.end([point(7, 150)], [point(2, 350), point(0, 390, 20)]);
  c.move([point(7, 170)]);
  near(h.draft().position.x, 0.425);
  c.start([point(2, 270), point(7, 170)]);
  near(h.draft().scale, 2); near(h.draft().position.x, 0.425);
  // The last native movement arrives only in changedTouches.
  c.end([], [point(7, 120), point(2, 320)]); c.release();
  assert.equal(h.calls.changes.length, 1); assert.equal(h.calls.changes[0].key, h.key);
  near(h.calls.changes[0].geometry.scale, 4);
  near(h.calls.changes[0].geometry.position.x, 0.3);
  near(h.calls.changes[0].geometry.rotation, 0);
  h.balanced(1); h.preserved();
});

test('rejected foreign foreground cannot scale or continue the owner after its pointer drains', () => {
  const other = { key: 'foreign', selection: { kind: 'image', id: 'foreign' },
    geometry: geometry(0.8), order: 3 };
  const h = setup('video-overlay', selections[0][1], [other]), c = h.controller;
  c.grant([point(7)], origin); c.start([point(2, 320), point(7)]);
  c.move([point(7, 220), point(2, 370)]);
  near(h.draft().scale, 1); near(h.draft().position.x, 0.55);
  c.end([point(2, 370)], [point(7, 220)]);
  c.start([point(2, 220), point(3, 300)]);
  c.move([point(2, 100), point(3, 390)]); c.release();
  assert.equal(h.calls.changes.length, 1); assert.equal(h.calls.changes[0].key, h.key);
  near(h.calls.changes[0].geometry.scale, 1); near(h.calls.changes[0].geometry.position.x, 0.55);
  h.balanced(1); h.preserved();
});

for (const invalidation of ['cancel', 'layout', 'context']) test(`${invalidation} discards repeat pinch and permits next gesture without stale tap history`, () => {
  const h = setup(), c = h.controller;
  h.tap(); c.grant([point(7)], origin); c.start([point(7), point(2, 300)]);
  c.move([point(7, 150), point(2, 350)]);
  if (invalidation === 'cancel') c.cancel();
  if (invalidation === 'layout') { c.layout({ width: 800, height: 600 }); c.layout(size); }
  if (invalidation === 'context') h.configure({ contextKey: 'project:1000' });
  c.end([], [point(7, 100), point(2, 390)]); c.release();
  assert.equal(h.calls.changes.length, 0); assert.equal(c.active, false);
  h.balanced(2); h.preserved();
  h.tap(); assert.equal(c.selectedKey, h.key);
  c.grant([point(7)], origin); c.end([], [point(7, 220)]); c.release();
  assert.equal(h.calls.changes.length, 1); assert.equal(h.calls.changes[0].key, h.key);
  near(h.calls.changes[0].geometry.position.x, 0.55);
  h.balanced(4); h.preserved();
});

for (const change of ['remove', 'move']) test(`pending overlap target ${change} cannot select stale content on release`, () => {
  const h = setup(), c = h.controller;
  h.tap(); c.grant([point(7)], origin);
  h.configure({ targets: change === 'remove' ? [h.foreground]
    : [h.foreground, { ...h.main, geometry: geometry(.1, .1, .1) }] });
  c.end([], [point(7)]); c.release();
  assert.equal(c.selectedKey, h.key);
  assert.deepEqual(h.calls.selections, [h.foreground.selection, h.foreground.selection]);
  assert.equal(h.calls.changes.length, 0); h.balanced(2);
});
