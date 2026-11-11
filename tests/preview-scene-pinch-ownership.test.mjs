import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreviewSceneController } from '../src/lib/preview-scene-controller.ts';
import { applyPreviewSceneGeometry } from '../src/lib/preview-scene-project.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { addImageLayer } from '../src/lib/project-editor.ts';
import { resolveLayerGeometry } from '../src/lib/layer-geometry.ts';

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

const lowerOverlay = (key = 'text', selection = selections[2][1]) => ({
  key: `lower:${key}`, selection, geometry: geometry(0.65, 0.7, 0.4), order: 1,
});

function setup(key = 'video-overlay', selection = selections[0][1], extraTargets = [], commit = () => {}) {
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
    onChange(target, geometry) { calls.changes.push({ key: target.key, selection: target.selection, geometry }); commit(target, geometry); },
    onDelete() { assert.fail('body gesture must not delete'); },
    onInteractionStart() { calls.starts++; }, onInteractionEnd() { calls.ends++; },
  };
  function configure(next) { options = { ...options, ...next }; controller.configure(options); }
  configure({}); controller.layout(size);
  function tap() { controller.grant([point(7)], origin); controller.end([], [point(7)]); controller.release(); }
  function preserved() {
    assert.deepEqual(targets, original);
    assert.deepEqual(controller.geometryFor('main', main.geometry), main.geometry);
    for (const target of extraTargets) assert.deepEqual(controller.geometryFor(target.key, target.geometry), target.geometry);
  }
  function balanced(count) { assert.equal(calls.starts, count); assert.equal(calls.ends, count); }
  return { controller, calls, key, foreground, main, configure, tap, preserved, balanced,
    draft() { return controller.geometryFor(key, foreground.geometry); } };
}

for (const [lowerKey, lowerSelection] of selections) {
  for (const simultaneous of [false, true]) test(`image: ${simultaneous ? 'simultaneous' : 'staggered'} pinch over lower passive ${lowerKey}`, () => {
    const lower = lowerOverlay(lowerKey, lowerSelection);
    const h = setup('image', selections[1][1], [lower]), c = h.controller;
    h.tap();
    c.grant(simultaneous ? [point(7), point(2, 300)] : [point(7)], origin);
    if (!simultaneous) c.start([point(2, 300), point(7)]);
    c.move([point(7, 150), point(2, 350)]);
    assert.equal(c.selectedKey, 'image');
    near(h.draft().scale, 2); near(h.draft().position.x, 0.375);
    near(h.draft().position.y, 0.5); near(h.draft().rotation, 0);
    near(h.draft().scaleX, 1); near(h.draft().scaleY, 1);
    assert.equal(h.calls.changes.length, 0); h.preserved();
    c.end([], [point(2, 350), point(7, 150)]); c.release(); c.release();
    assert.equal(h.calls.changes.length, 1);
    assert.equal(h.calls.changes[0].key, 'image');
    assert.deepEqual(h.calls.changes[0].geometry, { ...geometry(0.375), scale: 2 });
    assert.deepEqual(h.calls.selections, [selections[1][1], selections[1][1]]);
    h.balanced(2); h.preserved();
  });
}

for (const invalidation of ['cancel', 'layout', 'context']) test(`lower passive overlay pinch: ${invalidation} discards draft and recovers`, () => {
  const h = setup('image', selections[1][1], [lowerOverlay()]), c = h.controller;
  h.tap(); c.grant([point(7)], origin); c.start([point(7), point(2, 300)]);
  c.move([point(7, 150), point(2, 350)]);
  near(h.draft().scale, 2);
  if (invalidation === 'cancel') c.cancel();
  if (invalidation === 'layout') { c.layout({ width: 800, height: 600 }); c.layout(size); }
  if (invalidation === 'context') h.configure({ contextKey: 'project:next' });
  c.end([], [point(7, 150), point(2, 350)]); c.release();
  assert.equal(h.calls.changes.length, 0); assert.equal(c.active, false);
  assert.deepEqual(h.draft(), h.foreground.geometry); h.preserved(); h.balanced(2);
  h.tap(); assert.equal(c.selectedKey, 'image');
  c.grant([point(7), point(2, 300)], origin);
  c.end([], [point(7, 150), point(2, 350)]); c.release();
  assert.equal(h.calls.changes.length, 1); near(h.calls.changes[0].geometry.scale, 2);
  h.balanced(4); h.preserved();
});

test('lower overlay and equal/higher peers cannot block the captured owner pinch', () => {
  for (const order of [2, 3]) {
    const foreign = { key: 'z:foreign', selection: selections[0][1], geometry: geometry(0.8), order };
    const h = setup('image', selections[1][1], [lowerOverlay(), foreign]), c = h.controller;
    c.grant([point(7), point(2, 320)], origin);
    c.move([point(7, 220), point(2, 370)]);
    near(h.draft().scale, 1.25); near(h.draft().position.x, 0.55);
    c.end([point(2, 370)], [point(7, 220)]);
    c.end([], [point(2, 370)]);
    const drained = structuredClone(h.draft());
    c.start([point(2, 220), point(3, 300)]);
    c.move([point(2, 100), point(3, 390)]); c.release();
    assert.equal(h.calls.changes.length, 1);
    assert.deepEqual(h.calls.changes[0].geometry, drained);
    assert.equal(h.calls.changes[0].key, 'image');
    h.balanced(1); h.preserved();
  }
});

test('lower overlay pinch commits only selected image geometry through the project adapter', () => {
  let project = createCaptionProject({ id: 'lower-pinch', name: 'Lower pinch', sources: [{
    id: 'source', uri: 'file:///main.mp4', storageMode: 'copied', displayName: 'main.mp4',
    durationMs: 5000, width: 1920, height: 1080, rotation: 0,
  }] });
  project.layers.push({ id: 'text', kind: 'text', name: 'Lower text', text: 'Wide text',
    visible: true, startMs: 0, endMs: 3000, style: { ...project.projectStyle, ...lowerOverlay().geometry } });
  project = addImageLayer(project, { id: 'image', name: 'Image', uri: 'file:///image.png',
    currentMs: 0, durationMs: 5000 }).project;
  project.layers = project.layers.map(layer => layer.id === 'image' ? { ...layer, ...geometry() } : layer);
  const original = structuredClone(project);
  const lower = lowerOverlay();
  lower.geometry = project.layers.find(layer => layer.id === 'text').style;
  const h = setup('image', selections[1][1], [lower], (target, draft) => {
    project = applyPreviewSceneGeometry(project, target, draft);
  }), c = h.controller;
  c.grant([point(7), point(2, 300)], origin);
  // A third contact over the lower overlay cannot affect the captured pair.
  c.start([point(0, 390), point(2, 300), point(7)]);
  c.move([point(0, 20, 20), point(7, 150), point(2, 350)]);
  near(h.draft().scale, 2); h.preserved(); assert.deepEqual(project, original);
  c.end([], [point(0, 20, 20), point(7, 150), point(2, 350)]); c.release(); c.release();
  assert.equal(h.calls.changes.length, 1);
  const committed = resolveLayerGeometry(project.layers.find(layer => layer.id === 'image'));
  assert.deepEqual(committed, { ...geometry(0.375), scale: 2 });
  assert.deepEqual(project.layers.filter(layer => layer.id !== 'image'), original.layers.filter(layer => layer.id !== 'image'));
  assert.deepEqual(project.clips, original.clips);
  assert.deepEqual(project.sources, original.sources);
  assert.deepEqual(project.canvas, original.canvas);
  const expectedImage = { ...original.layers.find(layer => layer.id === 'image'), ...committed };
  assert.deepEqual(project.layers.find(layer => layer.id === 'image'), expectedImage);
  h.balanced(1); h.preserved();
});

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

  for (const foreign of [false, true]) test(`${key}: unmoved ${foreign ? 'peer foreground' : 'background'} second finger disqualifies this and following tap cycle`, () => {
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

test('peer foreground contact scales only the owner and cannot continue after both pointers drain', () => {
  const other = { key: 'foreign', selection: { kind: 'image', id: 'foreign' },
    geometry: geometry(0.8), order: 3 };
  const h = setup('video-overlay', selections[0][1], [other]), c = h.controller;
  c.grant([point(7)], origin); c.start([point(2, 320), point(7)]);
  c.move([point(7, 220), point(2, 370)]);
  near(h.draft().scale, 1.25); near(h.draft().position.x, 0.55);
  c.end([point(2, 370)], [point(7, 220)]);
  // The admitted second pointer can continue the same owner after the first lifts.
  c.move([point(2, 350)]);
  near(h.draft().position.x, 0.5);
  c.end([], [point(2, 350)]);
  const drained = structuredClone(h.draft());
  c.start([point(2, 220), point(3, 300)]);
  c.move([point(2, 100), point(3, 390)]); c.release();
  assert.equal(h.calls.changes.length, 1); assert.equal(h.calls.changes[0].key, h.key);
  assert.deepEqual(h.calls.changes[0].geometry, drained);
  h.balanced(1); h.preserved();
});

for (const invalidation of ['cancel', 'layout', 'origin', 'context', 'remove', 'replace-geometry', 'disable']) {
  test(`peer-contact pinch: ${invalidation} discards only the owner draft and balances lifecycle`, () => {
    const peer = { key: 'foreign', selection: { kind: 'image', id: 'foreign' }, geometry: geometry(.8), order: 3 };
    const h = setup('video-overlay', selections[0][1], [peer]), c = h.controller;
    c.grant([point(7)], origin); c.start([point(2, 320), point(7)]);
    c.move([point(7, 180), point(2, 360)]);
    near(h.draft().scale, 1.5); h.preserved();
    if (invalidation === 'cancel') c.cancel();
    if (invalidation === 'layout') c.layout({ width: 800, height: 600 });
    if (invalidation === 'origin') c.locate({ ...origin, pageY: origin.pageY + 60 });
    if (invalidation === 'context') h.configure({ contextKey: 'project:next' });
    if (invalidation === 'remove') h.configure({ targets: [h.main, peer] });
    if (invalidation === 'replace-geometry') h.configure({ targets: [h.main, peer, { ...h.foreground, geometry: geometry(.4) }] });
    if (invalidation === 'disable') h.configure({ enabled: false });
    c.end([], [point(7, 100), point(2, 390)]); c.release(); c.cancel();
    assert.equal(c.active, false); assert.deepEqual(h.calls.changes, []);
    assert.deepEqual(h.draft(), h.foreground.geometry); h.balanced(1); h.preserved();
    h.configure({ targets: [h.main, h.foreground, peer], enabled: true }); c.layout(size);
    c.grant([point(7), point(2, 320)], origin);
    c.end([], [point(7, 180), point(2, 360)]); c.release();
    assert.equal(h.calls.changes.length, 1); assert.equal(h.calls.changes[0].key, h.key);
    near(h.calls.changes[0].geometry.scale, 1.5); h.balanced(2); h.preserved();
  });
}

test('second contact outside canvas retains existing admission behavior without changing first-touch hits', () => {
  const h = setup(), c = h.controller;
  c.grant([point(7), point(2, 500)], origin);
  c.move([point(7, 150), point(2, 600)]);
  near(h.draft().scale, 1.5); near(h.draft().position.x, .375);
  c.end([], [point(7, 150), point(2, 600)]); c.release();
  assert.equal(h.calls.changes.length, 1); assert.equal(h.calls.changes[0].key, h.key);
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
