import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addImageLayer, createTextLayer, deleteVideoClip, reorderVideoClip, setLayerTiming,
  setVideoClipGap, setVideoClipLeadingGap, splitVideoClip, splitVisualLayer, trimVideoClip,
} from '../src/lib/project-editor.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { decodeVersionTwoProject, serializeProjectSnapshot } from '../src/lib/project-schema.ts';
import { projectTimelineDuration, projectTimelineSegmentAt } from '../src/lib/project-timeline.ts';
import { projectHasEditorLayer } from '../src/lib/caption-preview.ts';
import { buildTimelineRenderPlan } from '../src/lib/export-render-plan.ts';

function fixture() {
  return createCaptionProject({ id: 'visual-canvas', name: 'Visual canvas', sources: ['a', 'b'].map(id => ({
    id, uri: `file:///${id}.mp4`, displayName: id, durationMs: 2000,
    width: 1080, height: 1920, rotation: 0,
  })) });
}

function add(project, kind, id = 'selected', startMs = 500, endMs = 1500) {
  return kind === 'text' ? createTextLayer(project, id, startMs, endMs)
    : addImageLayer(project, { id, name: id, uri: 'file:///image.png', currentMs: startMs, durationMs: endMs });
}

const layerAt = (project, id = 'selected') => project.layers.find(layer => layer.id === id);
const reopen = project => decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(project)));
const rangeOf = layer => [layer.startMs, layer.endMs];

function assertCanvas(project, expected, visible = true) {
  const layer = layerAt(project);
  assert.ok(layer);
  assert.equal(layer.kind === 'text' ? layer.text : layer.uri, layer.kind === 'text' ? 'New text' : 'file:///image.png');
  assert.deepEqual(rangeOf(layer), expected);
  assert.equal(layer.timingMode, 'timeline');
  assert.equal(layer.sourceAnchors, undefined);
  assert.notEqual(layer.timelineVisible, false);
  assert.equal(layer.visible, visible);
  assert.equal(projectHasEditorLayer(project, layer.id), true, 'selection retains the original identity');
  const plan = buildTimelineRenderPlan(project);
  assert.deepEqual(rangeOf(plan.layers.find(item => item.id === layer.id)), expected);
  assert.equal(plan.durationMs, projectTimelineDuration(project));
  assert.ok(plan.durationMs >= expected[1]);
}

for (const kind of ['text', 'image']) {
  for (const edge of ['end', 'move']) {
    test(`${kind} ${edge}: canvas ownership survives reopen and every later clip operation`, () => {
      let project = add(fixture(), kind).project;
      project = add(project, kind, 'sibling', 2500, 3500).project;
      const before = structuredClone(project);
      const expected = edge === 'end' ? [500, 7000] : [6000, 7000];
      project = setLayerTiming(project, 'selected', edge, 6000, 7000);
      assert.deepEqual(rangeOf(layerAt(before)), [500, 1500]);
      assert.deepEqual(layerAt(project, 'sibling'), layerAt(before, 'sibling'));
      assertCanvas(project, expected);
      project = reopen(project);
      assertCanvas(project, expected);
      assert.deepEqual(projectTimelineSegmentAt(project, 6500), { kind: 'gap', startMs: 4000, endMs: 7000 });
      const [first, second] = project.clips;
      const operations = [
        value => trimVideoClip(value, first.id, 'end', 1000).project,
        value => deleteVideoClip(value, first.id).project,
        value => reorderVideoClip(value, first.id, 1).project,
        value => setVideoClipGap(value, second.id, 750, 'before').project,
        value => setVideoClipLeadingGap(value, first.id, 800).project,
        value => splitVideoClip(value, first.id, 1000, 'left', 'right').project,
      ];
      for (const operation of operations) {
        const edited = reopen(operation(project));
        assertCanvas(edited, expected);
      }
      project = reopen(deleteVideoClip(project, first.id).project);
      project = reopen(deleteVideoClip(project, second.id).project);
      assertCanvas(project, expected);
      assert.equal(projectTimelineDuration(project), 7000);
      assert.equal(projectTimelineSegmentAt(project, 6500).kind, 'gap');
      assert.deepEqual(buildTimelineRenderPlan(project).clips, []);
    });
  }

  test(`${kind}: gap overlap and gap-only insertion own their complete interval`, () => {
    let project = fixture();
    const secondId = project.clips[1].id;
    project = setVideoClipGap(project, secondId, 2000, 'before').project;
    for (const [start, end] of [[1500, 4500], [2500, 3500]]) {
      let inserted = add(project, kind, 'selected', start, end).project;
      assertCanvas(inserted, [start, end]);
      inserted = reopen(setVideoClipGap(reopen(inserted), secondId, 0, 'before').project);
      assertCanvas(inserted, [start, end]);
      // Footage now covers the gap: ownership must remain timeline-based.
      inserted = reopen(reorderVideoClip(inserted, secondId, 0).project);
      assertCanvas(inserted, [start, end]);
    }
    const contained = add(project, kind, 'selected', 500, 1500).project;
    const extended = setLayerTiming(contained, 'selected', 'end', 500, 4500);
    assertCanvas(reopen(extended), [500, 4500]);
    assertCanvas(reopen(deleteVideoClip(extended, extended.clips[0].id).project), [500, 4500]);
  });

  test(`${kind}: insertion at/beyond footage and on an empty canvas creates a usable range`, () => {
    for (const start of [4000, 6000]) {
      const project = add(fixture(), kind, 'selected', start, 4000).project;
      assertCanvas(reopen(project), [start, start + 3000]);
    }
    const empty = fixture();
    empty.clips = [];
    assertCanvas(reopen(add(empty, kind, 'selected', 0, 0).project), [0, 3000]);
    const nearEnd = add(fixture(), kind, 'selected', 3990, 4000).project;
    assertCanvas(reopen(nearEnd), [3990, 4070]);
  });

  test(`${kind}: user visibility, split identity and sticky ownership survive later edits`, () => {
    let project = add(fixture(), kind).project;
    layerAt(project).visible = false;
    project = setLayerTiming(project, 'selected', 'end', 500, 7000);
    assertCanvas(reopen(project), [500, 7000], false);
    project = setLayerTiming(project, 'selected', 'end', 500, 1500);
    project = reopen(setVideoClipGap(project, project.clips[0].id, 1000).project);
    assertCanvas(project, [500, 1500], false);
    const split = splitVisualLayer(project, 'selected', 1000, 'text-left', 'text-right');
    assert.ok(split);
    const edited = reopen(deleteVideoClip(split.project, project.clips[0].id).project);
    assert.equal(layerAt(edited), undefined);
    for (const [id, range] of [['text-left', [500, 1000]], ['text-right', [1000, 1500]]]) {
      const layer = layerAt(edited, id);
      assert.deepEqual(rangeOf(layer), range);
      assert.equal(layer.timingMode, 'timeline');
      assert.equal(layer.sourceAnchors, undefined);
      assert.equal(layer.visible, false);
    }
  });

  test(`${kind}: fully contained anchors follow their clip without sibling drift`, () => {
    let project = add(fixture(), kind).project;
    project = add(project, kind, 'sibling', 2500, 3500).project;
    const [first, second] = project.clips;
    project = setLayerTiming(project, 'selected', 'move', 750, 1750);
    assert.equal(layerAt(project).timingMode, 'source');
    assert.equal(layerAt(project).sourceAnchors[0].clipId, first.id);
    const sibling = structuredClone(layerAt(project, 'sibling'));
    const trimmed = trimVideoClip(project, first.id, 'end', 1000).project;
    assert.deepEqual(rangeOf(layerAt(trimmed)), [750, 1000]);
    assert.deepEqual(layerAt(trimmed, 'sibling'), sibling);
    project = reopen(reorderVideoClip(project, first.id, 1).project);
    assert.deepEqual(rangeOf(layerAt(project)), [2750, 3750]);
    assert.deepEqual(rangeOf(layerAt(project, 'sibling')), [500, 1500]);
    project = reopen(setVideoClipGap(project, first.id, 500, 'before').project);
    assert.deepEqual(rangeOf(layerAt(project)), [3250, 4250]);
    assert.deepEqual(rangeOf(layerAt(project, 'sibling')), [500, 1500]);
    assert.equal(layerAt(project, 'sibling').sourceAnchors[0].clipId, second.id);
  });

  test(`${kind}: a deleted owner never resurrects or loses its hidden orphan`, () => {
    let project = add(fixture(), kind).project;
    const [first, second] = project.clips;
    project = reopen(deleteVideoClip(project, first.id).project);
    const orphan = structuredClone(layerAt(project));
    assert.equal(orphan.timelineVisible, false);
    assert.deepEqual(orphan.sourceAnchors, []);
    assert.equal(setLayerTiming(project, 'selected', 'end', 500, 9000), project);
    assert.equal(splitVisualLayer(project, 'selected', 1000, 'left', 'right'), null);
    project = reopen(setVideoClipGap(project, second.id, 500).project);
    project = reopen(setVideoClipGap(project, second.id, 0).project);
    project = reopen(deleteVideoClip(project, second.id).project);
    assert.deepEqual(layerAt(project), orphan);
    assert.equal(projectTimelineDuration(project), 0);
  });
}
