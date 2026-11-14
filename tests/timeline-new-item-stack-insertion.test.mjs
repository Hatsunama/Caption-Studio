import assert from 'node:assert/strict';
import test from 'node:test';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import {
  addImageLayer, addVideoLayer, createTextLayer, createWatermarkLayer, duplicateVisualLayer,
} from '../src/lib/project-editor.ts';
import {
  applyTimelineStackOrder, reorderVisualTimelineLayer, visualTimelineGroups,
  visualTimelineLayerIds, visualTimelineRowIds,
} from '../src/lib/timeline-tracks.ts';
import { buildTimelineRenderPlan } from '../src/lib/export-render-plan.ts';
import { serializeProjectSnapshot } from '../src/lib/project-schema.ts';
import { decodePersistedProject } from '../src/lib/project-codec.ts';

const kinds = ['text', 'watermarks', 'images', 'videos'];
const ids = layers => layers.map(layer => layer.id);
const translationIds = project => project.captionTracks.translations.map(track => track.id);
const rows = project => visualTimelineRowIds(project.layers, translationIds(project));
const saved = project => decodePersistedProject(serializeProjectSnapshot(project));

// Exercise the same public domain creators used by editor/import actions. No
// proposed insertion helper or extracted implementation participates in tests.
function add(project, kind, id) {
  const options = { id, name: id, uri: `file:///${id}.${kind === 'videos' ? 'mp4' : 'png'}`,
    currentMs: 0, durationMs: 5000, sourceDurationMs: 5000 };
  const result = kind === 'text' ? createTextLayer(project, id, 0, 5000)
    : kind === 'watermarks' ? createWatermarkLayer(project, id, 5000, id)
      : kind === 'images' ? addImageLayer(project, options) : addVideoLayer(project, options);
  assert.ok(result, `creator must return ${kind} ${id}`);
  return result;
}

function fixture() {
  const project = createCaptionProject({ id: 'new-item-stack', name: 'New item stack', sources: [{
    id: 'source', uri: 'file:///source.mp4', storageMode: 'copied', displayName: 'Source',
    durationMs: 5000, width: 1920, height: 1080, rotation: 0, frameRate: 30,
  }] });
  project.captionTracks.translations = [{
    id: 'fr', kind: 'translation', sourceTrackId: 'captions', sourceLanguageTag: 'en',
    languageTag: 'fr', displayName: 'French', visible: true, origin: 'manual',
    provider: { id: 'manual' }, cues: [],
  }];
  return project;
}

function placedGroup(kind) {
  let project = fixture();
  project = add(project, kind, 'target-back').project;
  project = add(project, kind, 'target-front').project;
  for (const other of kinds.filter(value => value !== kind)) {
    project = add(project, other, `other-${other}`).project;
  }
  const otherRows = kinds.filter(value => value !== kind);
  project = applyTimelineStackOrder(project, [
    ...otherRows, 'translation:fr', 'captions', kind, 'video', 'audio',
  ]);
  assert.deepEqual(rows(project), [...otherRows, 'translation:fr', 'captions', kind]);
  assert.deepEqual(ids(visualTimelineGroups(project.layers).find(group => group.id === kind).items),
    ['target-front', 'target-back']);
  return project;
}

function assertUnchangedExisting(before, after, insertedId) {
  assert.deepEqual(after.layers.filter(layer => layer.id !== insertedId), before.layers,
    'insertion preserves every existing layer and its relative paint order');
  for (const layer of before.layers) {
    assert.equal(after.layers.find(candidate => candidate.id === layer.id), layer,
      'insertion retains existing layer identity');
  }
  for (const key of ['clips', 'audioClips', 'sources', 'audioSources', 'captions', 'captionTracks', 'timelineTrackOrder']) {
    assert.equal(after[key], before[key], `${key} remains authoritative and unchanged`);
  }
}

for (const kind of kinds) {
  test(`${kind}: repeated public additions inherit the moved group below captions, including saved paint order`, () => {
    let project = placedGroup(kind);
    // Stale legacy presentation preferences must not override the actual stack.
    project = { ...project, timelineTrackOrder: [kind, 'captions', ...kinds.filter(value => value !== kind)] };
    const original = project;
    const originalRows = rows(project);
    const originalIds = ids(project.layers);
    for (const id of ['fresh-one', 'fresh-two']) {
      const before = project;
      const result = add(before, kind, id);
      project = result.project;
      assert.deepEqual(rows(project), originalRows, 'adding into a moved group must not create a row at the front');
      const group = visualTimelineGroups(project.layers).find(value => value.id === kind);
      assert.deepEqual(ids(group.items), id === 'fresh-one'
        ? ['fresh-one', 'target-front', 'target-back']
        : ['fresh-two', 'fresh-one', 'target-front', 'target-back']);
      assert.equal(group.layout.laneById.get(id), 0, 'fresh overlapping item is top within its group');
      assert.equal(project.layers.find(layer => layer.id === id), result.layer);
      assertUnchangedExisting(before, project, id);
      const restored = saved(project);
      assert.deepEqual(ids(restored.layers), ids(project.layers), 'draft save/load retains insertion depth');
      assert.deepEqual(rows(restored), originalRows);
      assert.deepEqual(ids(buildTimelineRenderPlan(restored).layers), ids(project.layers),
        'export paints the same authoritative back-to-front stack');
    }
    assert.deepEqual(ids(original.layers), originalIds, 'creator never mutates the undo snapshot');
    const moved = reorderVisualTimelineLayer(project, 'fresh-one', 0);
    assert.equal(visualTimelineLayerIds(moved.layers)[0], 'fresh-one', 'new item can later move independently');
    assert.deepEqual(ids(moved.layers).filter(id => id !== 'fresh-one'),
      ids(project.layers).filter(id => id !== 'fresh-one'));
    assert.deepEqual(ids(saved(moved).layers), ids(moved.layers));
  });

  test(`${kind}: explicit split groups stay separate; new item joins only the frontmost matching group`, () => {
    let project = placedGroup(kind);
    project = reorderVisualTimelineLayer(project, 'target-back', 0);
    // Keep a caption boundary ahead of the frontmost target segment, so a
    // global append cannot accidentally satisfy the insertion policy.
    project = reorderVisualTimelineLayer(project, 'captions', 0);
    const originalRows = rows(project);
    const oldGroups = visualTimelineGroups(project.layers).filter(group => group.baseId === kind);
    assert.equal(oldGroups.length, 2);
    assert.deepEqual(oldGroups.map(group => ids(group.items)), [['target-back'], ['target-front']]);
    const result = add(project, kind, 'fresh');
    assert.deepEqual(rows(result.project), originalRows, 'no extra row and no merging across intervening depths');
    const groups = visualTimelineGroups(result.project.layers).filter(group => group.baseId === kind);
    assert.deepEqual(groups.map(group => ids(group.items)), [['fresh', 'target-back'], ['target-front']]);
    assertUnchangedExisting(project, result.project, 'fresh');
    assert.deepEqual(ids(buildTimelineRenderPlan(saved(result.project)).layers), ids(result.project.layers));
  });

  test(`${kind}: hidden timeline tombstones do not select a group; invisible participating layers do`, () => {
    let project = placedGroup(kind);
    const target = project.layers.find(layer => layer.id === 'target-front');
    const tombstone = { ...target, id: 'hidden-front', timelineVisible: false };
    project = { ...project, layers: project.layers.map(layer => layer === target ? { ...layer, visible: false } : layer) };
    project = { ...project, layers: [...project.layers, tombstone] };
    const originalRows = rows(project);
    const result = add(project, kind, 'fresh');
    assert.deepEqual(rows(result.project), originalRows);
    const group = visualTimelineGroups(result.project.layers).find(value => value.baseId === kind);
    assert.deepEqual(ids(group.items), ['fresh', 'target-front', 'target-back']);
    assert.equal(result.project.layers.at(-1), tombstone, 'hidden front item is retained above all old layers');
    assertUnchangedExisting(project, result.project, 'fresh');
    assert.deepEqual(ids(buildTimelineRenderPlan(saved(result.project)).layers),
      ids(result.project.layers.filter(layer => layer.kind === 'captions' || (layer.visible && layer.timelineVisible !== false))));
  });

  test(`${kind}: older saved projects without row preferences derive insertion from their existing array`, () => {
    const legacy = placedGroup(kind);
    delete legacy.timelineTrackOrder;
    const project = saved(legacy);
    const before = ids(project.layers);
    const result = add(project, kind, 'fresh');
    const expected = [...before];
    expected.splice(expected.indexOf('target-front') + 1, 0, 'fresh');
    assert.deepEqual(ids(result.project.layers), expected);
    assert.deepEqual(ids(saved(result.project).layers), expected);
    assert.equal(result.project.schemaVersion, project.schemaVersion);
    assert.deepEqual(Object.keys(result.project).sort(), Object.keys(project).sort(), 'no ordering metadata added');
  });
}

for (const kind of ['text', 'images', 'videos']) {
  test(`${kind}: duplication remains immediately above its source inside a deeper split group`, () => {
    let project = placedGroup(kind);
    project = reorderVisualTimelineLayer(project, 'target-front', 0);
    project = reorderVisualTimelineLayer(project, 'captions', 0);
    const result = duplicateVisualLayer(project, 'target-back', 'copy');
    assert.ok(result);
    const expected = ids(project.layers);
    expected.splice(expected.indexOf('target-back') + 1, 0, 'copy');
    assert.deepEqual(ids(result.project.layers), expected, 'duplicate bypasses default group insertion');
    assert.deepEqual(visualTimelineGroups(result.project.layers).filter(group => group.baseId === kind)
      .map(group => ids(group.items)), [['target-front'], ['copy', 'target-back']]);
    assertUnchangedExisting(project, result.project, 'copy');
    assert.deepEqual(ids(buildTimelineRenderPlan(saved(result.project)).layers), expected);
    const moved = reorderVisualTimelineLayer(result.project, 'copy', 0);
    assert.equal(visualTimelineLayerIds(moved.layers)[0], 'copy');
    assert.deepEqual(ids(moved.layers).filter(id => id !== 'copy'), ids(project.layers));
  });
}

test('caption container and watermark duplication restrictions remain unchanged', () => {
  const project = placedGroup('watermarks');
  assert.equal(duplicateVisualLayer(project, 'captions', 'caption-copy'), undefined);
  assert.equal(duplicateVisualLayer(project, 'target-back', 'watermark-copy'), undefined);
  assert.equal(project.layers.filter(layer => layer.kind === 'captions').length, 1);
});
