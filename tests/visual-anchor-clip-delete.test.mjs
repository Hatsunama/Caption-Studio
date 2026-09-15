import assert from 'node:assert/strict';
import test from 'node:test';

import { deleteVideoClip, setVideoClipGap } from '../src/lib/project-editor.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { decodeVersionTwoProject, serializeProjectSnapshot } from '../src/lib/project-schema.ts';

function fixture(kind, mixed = false) {
  const project = createCaptionProject({
    id: 'visual-anchor-delete', name: 'Visual anchor deletion',
    sources: ['first', 'second'].map((id) => ({
      id, uri: `file:///${id}.mp4`, displayName: id,
      durationMs: 2_000, width: 1080, height: 1920, rotation: 0,
    })),
  });
  const [first, second] = project.clips;
  const sourceAnchors = [{ clipId: first.id, sourceStartMs: 500, sourceEndMs: 1_500 }];
  if (mixed) sourceAnchors.push({ clipId: second.id, sourceStartMs: 250, sourceEndMs: 1_250 });
  project.layers.push({
    id: 'overlay', kind, name: 'Overlay', visible: true, timelineVisible: true,
    startMs: 500, endMs: mixed ? 3_250 : 1_500, sourceAnchors,
    ...(kind === 'text' ? { text: 'Anchored text' } : {
      uri: 'file:///overlay.png', position: { x: 0.5, y: 0.5 },
      box: { width: 0.5, height: 0.25 }, rotation: 0, opacity: 1,
    }),
  });
  return decodeVersionTwoProject(project);
}

function assertPersistable(project, deletedClipId, checkLayer) {
  const check = (value) => {
    assert.equal(value.clips.some((clip) => clip.id === deletedClipId), false);
    const clipIds = new Set(value.clips.map((clip) => clip.id));
    for (const layer of value.layers) {
      for (const anchor of layer.sourceAnchors ?? []) {
        assert.ok(clipIds.has(anchor.clipId), `stale anchor on ${layer.id}: ${anchor.clipId}`);
      }
    }
    const layer = value.layers.find((candidate) => candidate.id === 'overlay');
    assert.ok(layer, 'deletion retains the visual layer');
    assert.equal(layer.visible, true, 'timeline remapping preserves the user visibility setting');
    checkLayer(layer);
  };
  check(project);
  check(decodeVersionTwoProject(structuredClone(project)));
  const reopened = decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(project)));
  check(reopened);
  return reopened;
}

for (const kind of ['text', 'image']) {
  test(`${kind}: deleting its only anchored clip hides the layer and saves without stale references`, () => {
    const project = fixture(kind);
    const [first, second] = project.clips;
    const result = deleteVideoClip(project, first.id);
    assert.ok(result);
    assert.deepEqual(result.project.clips.map((clip) => clip.id), [second.id]);
    const reopened = assertPersistable(result.project, first.id, (layer) => {
      assert.equal(layer.timelineVisible, false);
      assert.deepEqual(layer.sourceAnchors, []);
    });
    const shifted = setVideoClipGap(reopened, second.id, 400, 'before');
    assert.ok(shifted);
    assertPersistable(shifted.project, first.id, (layer) => {
      assert.equal(layer.timelineVisible, false);
      assert.deepEqual(layer.sourceAnchors, []);
    });
    assert.equal(project.layers.at(-1).sourceAnchors[0].clipId, first.id);
    assert.equal(project.layers.at(-1).timelineVisible, true);
  });

  test(`${kind}: mixed anchors retain only the surviving clip and remain visible after reopen and a later splice`, () => {
    const project = fixture(kind, true);
    const [first, second] = project.clips;
    const survivingAnchor = structuredClone(project.layers.at(-1).sourceAnchors[1]);
    const result = deleteVideoClip(project, first.id);
    assert.ok(result);
    const checkAt = (offset) => (layer) => {
      assert.equal(layer.timelineVisible, true);
      assert.deepEqual(layer.sourceAnchors, [survivingAnchor]);
      assert.deepEqual([layer.startMs, layer.endMs], [250 + offset, 1_250 + offset]);
    };
    const reopened = assertPersistable(result.project, first.id, checkAt(0));
    const inserted = setVideoClipGap(reopened, second.id, 400, 'before');
    assert.ok(inserted);
    const afterInsertion = assertPersistable(inserted.project, first.id, checkAt(400));
    const removed = setVideoClipGap(afterInsertion, second.id, 0, 'before');
    assert.ok(removed);
    assertPersistable(removed.project, first.id, checkAt(0));
    assert.equal(project.layers.at(-1).sourceAnchors.length, 2);
  });
}
