import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreviewSceneController } from '../src/lib/preview-scene-controller.ts';
import { applyPreviewSceneGeometry } from '../src/lib/preview-scene-project.ts';
import { previewInteractionAtPoint } from '../src/lib/preview-object-hit-test.ts';
import { resolveLayerGeometry } from '../src/lib/layer-geometry.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { createTranslationCaptionTrack, resolveCaptionPairs } from '../src/lib/caption-tracks.ts';
import { resolveCaptionStyle } from '../src/lib/style-resolver.ts';

const size = { width: 400, height: 300 };
const origin = { pageX: 71, pageY: 129 };
const geometry = (x = 0.5, y = 0.5, width = 0.3, height = 0.3) => ({
  position: { x, y }, box: { width, height }, scale: 1, scaleX: 1, scaleY: 1, rotation: 0,
});
const target = (key, x, order = 0, extra = {}) => ({ key, geometry: geometry(x), order,
  selection: { kind: key === 'image' ? 'image' : 'text', id: key }, deletable: true, ...extra });
const point = (id, x, y = 150, frame = origin) => ({ id, x: x + frame.pageX, y: y + frame.pageY });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

function setup(targets = [target('one', 0.2), target('two', 0.5, 1), target('image', 0.8, 2)], extra = {}) {
  const calls = { select: [], changes: [], deletes: [], starts: 0, ends: 0, clears: 0, renders: 0 };
  const controller = createPreviewSceneController(() => calls.renders++);
  let options = { targets, enabled: true, contextKey: 'project:500',
    onSelect: (selection) => calls.select.push(selection), onClearSelection: () => calls.clears++,
    onChange: (target, geometry) => calls.changes.push({ target, geometry }),
    onDelete: (target) => calls.deletes.push(target.key),
    onInteractionStart: () => calls.starts++, onInteractionEnd: () => calls.ends++, ...extra };
  controller.configure(options); controller.layout(size);
  return { controller, calls, targets,
    configure(next) { options = { ...options, ...next }; controller.configure(options); },
    draft(key = targets[0].key) { return controller.geometryFor(key, targets.find((t) => t.key === key).geometry); },
  };
}

test('repeated taps cycle two text objects and one image without any geometry commits', () => {
  const h = setup();
  for (let repeat = 0; repeat < 10; repeat++) for (const index of [2, 0, 1, 0, 2, 1]) {
    const t = h.targets[index], x = t.geometry.position.x * size.width;
    h.controller.grant([point(9, x)], origin);
    h.configure({ selectedKey: t.key, targets: [...h.targets].reverse() });
    assert.equal(h.controller.selectedKey, t.key);
    h.controller.move([point(9, x + 1.5, 151)]);
    h.controller.end([], [point(9, x + 1, 150)]);
    h.controller.release();
    h.controller.release();
  }
  assert.equal(h.calls.select.length, 60);
  assert.equal(h.calls.changes.length, 0);
  assert.equal(h.calls.starts, 60); assert.equal(h.calls.ends, 60);
});

test('three partially overlapping objects resolve exclusively in paint order regardless of selection', () => {
  const objects = [target('one', 0.3, 1), target('two', 0.5, 2), target('image', 0.7, 3)];
  const h = setup(objects);
  for (let repeat = 0; repeat < 5; repeat++) for (const [x, key] of [[90, 'one'], [180, 'two'], [240, 'image']]) {
    h.configure({ selectedKey: undefined, targets: repeat % 2 ? [...objects].reverse() : objects });
    h.controller.grant([point(1, x)], origin);
    assert.equal(h.controller.selectedKey, key);
    h.controller.move([point(1, x + 10)]);
    h.controller.release();
    assert.equal(h.calls.changes.at(-1).target.key, key);
  }
  assert.equal(h.calls.changes.length, 15);
});

test('first touch drags its snapshot through selection and target-array identity changes', () => {
  const h = setup();
  h.controller.grant([point(7, 80)], origin);
  h.configure({ selectedKey: 'image', targets: h.targets.map((t) => ({ ...t, geometry: resolveLayerGeometry(t.geometry) })).reverse() });
  h.controller.move([point(7, 120, 180)]);
  assert.equal(h.calls.changes.length, 0);
  near(h.draft().position.x, 0.3);
  assert.equal(h.controller.selectedKey, 'one');
  h.controller.release();
  assert.equal(h.calls.changes.length, 1);
  assert.equal(h.calls.changes[0].target.key, 'one');
  near(h.calls.changes[0].geometry.position.y, 0.6);
  assert.equal(h.controller.selectedKey, 'image');
});

for (const action of ['terminate', 'disable', 'remove', 'seek', 'project', 'resize', 'origin', 'replace-geometry']) {
  test(`${action} rolls back the draft and balances the lifecycle exactly once`, () => {
    const h = setup();
    h.controller.grant([point(1, 80)], origin);
    h.controller.move([point(1, 120)]);
    if (action === 'terminate') h.controller.cancel();
    if (action === 'disable') h.configure({ enabled: false });
    if (action === 'remove') h.configure({ targets: h.targets.slice(1) });
    if (action === 'seek') h.configure({ contextKey: 'project:700' });
    if (action === 'project') h.configure({ contextKey: 'other-project:500' });
    if (action === 'resize') h.controller.layout({ width: 800, height: 600 });
    if (action === 'origin') h.controller.locate({ pageX: origin.pageX, pageY: origin.pageY - 60 });
    if (action === 'replace-geometry') h.configure({ targets: [{ ...h.targets[0], geometry: geometry(0.1) }, ...h.targets.slice(1)] });
    h.controller.release(); h.controller.cancel(); h.controller.move([point(1, 160)]);
    assert.equal(h.calls.changes.length, 0);
    assert.equal(h.calls.ends, 1);
    assert.equal(h.controller.active, false);
    assert.equal(h.draft(), h.targets[0].geometry);
  });
}

test('a new grant after canvas movement uses its current origin and dimensions', () => {
  const h = setup();
  const shifted = { pageX: -130, pageY: 25 };
  h.controller.layout({ width: 800, height: 600 });
  h.controller.grant([point(1, 160, 300, shifted)], shifted);
  h.controller.move([point(1, 240, 360, shifted)]);
  h.controller.release();
  near(h.calls.changes[0].geometry.position.x, 0.3);
  near(h.calls.changes[0].geometry.position.y, 0.6);
});

test('empty canvas never acquires an object halfway through a touch sequence', () => {
  const h = setup();
  h.controller.grant([point(1, 10, 10)], origin);
  h.controller.move([point(1, 80)]); h.controller.start([point(2, 200)]); h.controller.release();
  assert.equal(h.calls.clears, 1);
  assert.equal(h.calls.select.length, 0);
  assert.equal(h.calls.changes.length, 0);
});

test('pinch and rotation preserve pointer identity and rebase when one finger lifts', () => {
  const h = setup([target('one', 0.5)]);
  h.controller.grant([point(7, 180)], origin);
  h.controller.start([point(2, 220), point(7, 180)]);
  h.controller.move([point(7, 200, 110), point(2, 200, 190)]);
  near(h.draft().scale, 2); near(h.draft().rotation, 90);
  h.controller.end([point(7, 200, 110)], [point(2, 200, 190)]);
  h.controller.move([point(7, 220, 110)]);
  near(h.draft().position.x, 0.55);
  h.controller.release();
  assert.equal(h.calls.changes.length, 1);
  near(h.calls.changes[0].geometry.scale, 2);
});

test('small-object pinch accepts empty canvas but never adopts a finger on another object', () => {
  const h = setup([target('one', 0.2), target('image', 0.8)]);
  h.controller.grant([point(7, 80)], origin);
  h.controller.start([point(7, 80), point(2, 320)]);
  h.controller.move([point(7, 100), point(2, 340)]);
  near(h.draft().scale, 1);
  h.controller.end([point(2, 340)], [point(7, 100)]);
  h.controller.start([point(2, 100), point(3, 110)]);
  h.controller.move([point(2, 160), point(3, 190)]);
  h.controller.release();
  near(h.calls.changes[0].geometry.position.x, 0.25);
  assert.equal(h.calls.select.length, 1);
  const second = setup([target('one', 0.2)]);
  second.controller.grant([point(7, 80)], origin);
  second.controller.start([point(7, 80), point(2, 160)]);
  second.controller.move([point(7, 80), point(2, 240)]);
  near(second.draft().scale, 2);
});

test('simultaneous pinch and third finger do not jump or replace the two owned pointers', () => {
  const h = setup([target('one', 0.5)]);
  h.controller.grant([point(7, 180), point(2, 220)], origin);
  h.controller.start([point(0, 200), point(2, 220), point(7, 180)]);
  h.controller.move([point(0, 350), point(7, 160), point(2, 240)]);
  near(h.draft().scale, 2);
  h.controller.release();
  assert.equal(h.calls.changes.length, 1);
});

test('release includes the final native position even without a preceding move event', () => {
  const h = setup();
  h.controller.grant([point(1, 80)], origin);
  h.controller.end([], [point(1, 120)]);
  h.controller.release();
  near(h.calls.changes[0].geometry.position.x, 0.3);
});

for (const finish of ['away', 'terminate', 'disable', 'remove', 'multitouch', 'release']) test(`delete ${finish} is exclusive and release-armed`, () => {
  const h = setup([target('one', 0.5)], { selectedKey: 'one' });
  h.controller.grant([point(1, 140, 105)], origin);
  if (finish === 'away') h.controller.end([], [point(1, 200)]);
  if (finish === 'terminate') h.controller.cancel();
  if (finish === 'disable') h.configure({ enabled: false });
  if (finish === 'remove') h.configure({ targets: [] });
  if (finish === 'multitouch') h.controller.start([point(1, 140, 105), point(2, 200)]);
  h.controller.release(); h.controller.release();
  assert.deepEqual(h.calls.deletes, finish === 'release' ? ['one'] : []);
  assert.equal(h.calls.changes.length, 0); assert.equal(h.calls.starts, 0); assert.equal(h.calls.ends, 0);
});

test('exterior handle halves use the same pixel dimensions and rotation as visible chrome', () => {
  const t = target('one', 0.5);
  for (const [x, y, mode] of [[125, 150, 'left'], [275, 150, 'right'], [200, 90, 'top'],
    [200, 210, 'bottom'], [275, 210, 'corner'], [130, 95, 'delete']]) {
    assert.equal(previewInteractionAtPoint([t], t.key, { x, y }, size, true)?.mode, mode);
  }
  const rotated = { ...t, geometry: { ...t.geometry, rotation: 90 } };
  assert.equal(previewInteractionAtPoint([rotated], t.key, { x: 200, y: 225 }, size, true)?.mode, 'right');
  assert.equal(previewInteractionAtPoint([t], t.key, { x: NaN, y: 0 }, size, true), undefined);
});

test('overlapping primary cues have separate hit identities and one track draft', () => {
  const h = setup([target('caption:a', 0.5, 1, { transformKey: 'captions', selection: { kind: 'captions', captionId: 'a' } }),
    target('caption:b', 0.5, 2, { transformKey: 'captions', selection: { kind: 'captions', captionId: 'b' } }),
    target('translation:fr:a', 0.8, 3, { transformKey: 'translation:fr', selection: { kind: 'translation', id: 'fr', captionId: 'a' } })]);
  h.controller.grant([point(1, 200)], origin);
  assert.equal(h.controller.selectedKey, 'caption:b');
  h.controller.move([point(1, 220)]);
  near(h.draft('caption:a').position.x, 0.55); near(h.draft('caption:b').position.x, 0.55);
  near(h.draft('translation:fr:a').position.x, 0.8);
  h.controller.release();
  assert.equal(h.calls.changes[0].target.selection.captionId, 'b');
});

function projectFixture() {
  let p = createCaptionProject({ id: 'scene', name: 'Scene', sources: [{ id: 'video', uri: 'file:///video.mp4',
    storageMode: 'copied', displayName: 'video', durationMs: 5000, width: 1080, height: 1920, rotation: 0 }] });
  p.captions = [0, 1].map((i) => ({ id: `c${i}`, text: `Caption ${i}`, startMs: i * 1000,
    endMs: i * 1000 + 2000, wordIds: [], styleOverride: { italic: true } }));
  p.layers.push({ id: 'one', kind: 'text', name: 'one', text: 'One', visible: true, startMs: 0, endMs: 5000, style: { ...p.projectStyle, ...geometry(0.2) } },
    { id: 'two', kind: 'text', name: 'two', text: 'Two', visible: true, startMs: 0, endMs: 5000, style: { ...p.projectStyle, ...geometry(0.5) } },
    { id: 'image', kind: 'image', name: 'image', uri: 'file:///image.png', opacity: 0.7, visible: true, startMs: 0, endMs: 5000, ...geometry(0.8) });
  for (const id of ['fr', 'de']) p = createTranslationCaptionTrack(p, { id, languageTag: id, displayName: id,
    translations: { c0: `${id} zero`, c1: `${id} one` } });
  return p;
}

function domainTarget(p, kind) {
  const selection = kind === 'captions' ? { kind, captionId: 'c0' } : kind === 'translation' ? { kind, id: 'fr', captionId: 'c0' }
    : { kind, id: kind === 'image' ? 'image' : 'one' };
  const geometry = kind === 'captions' ? resolveCaptionStyle(p.projectStyle, p.captions[0])
    : kind === 'translation' ? resolveCaptionPairs(p, 'fr')[0].style
    : kind === 'text' ? p.layers.find((l) => l.id === 'one').style : p.layers.find((l) => l.id === 'image');
  return { key: kind, selection, order: 1, geometry: resolveLayerGeometry(geometry) };
}

for (const kind of ['text', 'image', 'captions', 'translation']) test(`${kind} commits by captured identity with the established domain scope`, () => {
  const p = projectFixture(), original = structuredClone(p), t = domainTarget(p, kind);
  const nextGeometry = geometry(0.35, 0.25);
  const next = applyPreviewSceneGeometry(p, t, nextGeometry);
  assert.notEqual(next, p); assert.deepEqual(p, original);
  assert.equal(next.clips, p.clips); assert.equal(next.audioClips, p.audioClips);
  if (kind === 'text' || kind === 'image') {
    assert.equal(next.captions, p.captions); assert.equal(next.captionTracks, p.captionTracks);
    for (const layer of p.layers.filter((l) => l.id !== t.selection.id)) assert.equal(next.layers.find((l) => l.id === layer.id), layer);
    assert.deepEqual(domainTarget(next, kind).geometry, nextGeometry);
  } else {
    assert.equal(next.layers, p.layers);
    if (kind === 'captions') {
      for (const cue of next.captions) assert.deepEqual(resolveLayerGeometry(resolveCaptionStyle(next.projectStyle, cue)), nextGeometry);
      assert.deepEqual(resolveCaptionPairs(next, 'fr').map((pair) => resolveLayerGeometry(pair.style)), resolveCaptionPairs(p, 'fr').map((pair) => resolveLayerGeometry(pair.style)));
    } else {
      assert.equal(next.captions, p.captions);
      for (const pair of resolveCaptionPairs(next, 'fr')) assert.deepEqual(resolveLayerGeometry(pair.style), nextGeometry);
      assert.deepEqual(resolveCaptionPairs(next, 'de'), resolveCaptionPairs(p, 'de'));
    }
  }
  assert.equal(applyPreviewSceneGeometry(p, t, t.geometry), p);
  assert.equal(applyPreviewSceneGeometry(next, t, geometry(0.8)), next, 'stale geometry cannot overwrite newer edits');
  const removed = kind === 'captions' ? { ...p, captions: [] } : kind === 'translation'
    ? { ...p, captionTracks: { ...p.captionTracks, translations: [] } }
    : { ...p, layers: p.layers.filter((l) => l.id !== t.selection.id) };
  assert.equal(applyPreviewSceneGeometry(removed, t, nextGeometry), removed);
});
