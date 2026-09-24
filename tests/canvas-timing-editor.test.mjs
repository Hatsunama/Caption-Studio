import assert from 'node:assert/strict';
import test from 'node:test';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { createEnglishChineseCaptionTrack, resolveCaptionPairs, setTranslationCueTiming } from '../src/lib/caption-tracks.ts';
import { createTextLayer, setCaptionTiming, setLayerTiming } from '../src/lib/project-editor.ts';
import { editCanvasTimelineRange } from '../src/lib/timeline-item-timing.ts';
import { decodeVersionTwoProject } from '../src/lib/project-schema.ts';
import { projectTimelineDuration, projectTimelineSegmentAt } from '../src/lib/project-timeline.ts';
import { captionPreviewState } from '../src/lib/caption-preview.ts';
import { buildTimelineRenderPlan } from '../src/lib/export-render-plan.ts';
import { exportCaptionPairs } from '../src/lib/export-caption-pairs.ts';
import { serializeAss, serializeSrt } from '../src/lib/subtitle-export.ts';

function fixture() {
  const project = createCaptionProject({ id: 'canvas-timing', name: 'Canvas timing', sources: [{
    id: 'video', uri: 'file:///video.mp4', storageMode: 'copied', displayName: 'video.mp4',
    durationMs: 4000, width: 1080, height: 1920, rotation: 0, frameRate: 30,
  }] });
  project.transcription.language = 'en';
  project.canvas.backgroundColor = '#123456';
  project.captions = [{ id: 'c1', text: 'Hello', startMs: 500, endMs: 1500, wordIds: [], timingMode: 'timeline' }];
  return createEnglishChineseCaptionTrack(project, { c1: '\u4f60\u597d' });
}

for (const kind of ['caption', 'translation', 'text']) {
  for (const edge of ['end', 'move']) {
    test(`${kind} ${edge} on canvas survives save/reopen and reaches preview/export unchanged`, () => {
      let project = fixture();
      project.clips = [];
      if (kind === 'text') project = createTextLayer(project, 'text', 500, 4000).project;
      const before = structuredClone(project);
      const trackId = project.captionTracks.translations[0].id;
      const expected = edge === 'end' ? [500, 7000] : [6000, kind === 'text' ? 9000 : 7000];
      const edited = kind === 'caption' ? setCaptionTiming(project, 'c1', edge, 6000, 7000)
        : kind === 'translation' ? setTranslationCueTiming(project, trackId, 'c1', edge, 6000, 7000)
          : setLayerTiming(project, 'text', edge, 6000, 7000);
      assert.deepEqual(project, before);
      const restored = decodeVersionTwoProject(JSON.parse(JSON.stringify(edited)));
      const range = kind === 'caption' ? restored.captions[0]
        : kind === 'translation' ? resolveCaptionPairs(restored, trackId)[0]
          : restored.layers.find((layer) => layer.id === 'text');
      assert.deepEqual([range.startMs, range.endMs], expected);
      assert.equal(projectTimelineDuration(restored), expected[1]);
      assert.deepEqual(projectTimelineSegmentAt(restored, 6500), { kind: 'gap', startMs: 0, endMs: expected[1] });
      assert.ok(range.startMs <= 6500 && range.endMs > 6500);
      if (kind === 'caption') {
        assert.equal(captionPreviewState(restored.captions, 6500).active.id, 'c1');
        assert.equal(range.timingMode, 'timeline');
        assert.equal(range.sourceAnchor, undefined);
      }
      const plan = buildTimelineRenderPlan(restored);
      assert.equal(plan.durationMs, expected[1]);
      assert.equal(plan.backgroundColor, '#123456');
      assert.deepEqual(plan.clips, []);
      const output = kind === 'text' ? plan.layers.find((layer) => layer.id === 'text')
        : plan.captions.find((caption) => caption.id === (kind === 'caption' ? 'c1' : range.translation.id));
      assert.deepEqual([output.startMs, output.endMs], expected);
      if (kind === 'translation') {
        const pair = exportCaptionPairs(restored)[0];
        assert.deepEqual([pair.startMs, pair.endMs], expected);
        assert.match(serializeSrt(restored), /00:00:07,000/);
        assert.match(serializeAss(restored), /0:00:07.00/);
      }
    });
  }
}

test('video-backed text insertion remains in footage; canvas insertion can extend output', () => {
  for (const [at, expected] of [[3000, [3000, 4000]], [6000, [3920, 4000]], [3990, [3920, 4000]]]) {
    const { project, layer } = createTextLayer(fixture(), 'text', at, 4000);
    assert.deepEqual([layer.startMs, layer.endMs], expected);
    assert.equal(projectTimelineDuration(project), 4000);
  }
  const canvas = fixture();
  canvas.clips = [];
  const inserted = createTextLayer(canvas, 'text', 6000, 4000);
  assert.deepEqual([inserted.layer.startMs, inserted.layer.endMs], [6000, 9000]);
  assert.equal(projectTimelineDuration(inserted.project), 9000);
});

test('canvas edits normalize invalid ranges and requests, preserve 80 ms, and reject numeric overflow', () => {
  for (const invalid of [NaN, Infinity, -Infinity]) {
    for (const edge of ['start', 'end', 'move']) {
      assert.deepEqual(editCanvasTimelineRange({ startMs: 500, endMs: 1500 }, edge, invalid, invalid), { startMs: 500, endMs: 1500 });
      assert.deepEqual(editCanvasTimelineRange({ startMs: invalid, endMs: invalid }, edge, invalid, invalid), { startMs: 0, endMs: 80 });
      const project = fixture();
      project.clips = [];
      project.captions[0].startMs = invalid;
      project.captions[0].endMs = invalid;
      const fixed = setCaptionTiming(project, 'c1', edge, invalid, invalid).captions[0];
      assert.deepEqual([fixed.startMs, fixed.endMs], [0, 80]);
      const textProject = createTextLayer(fixture(), 'text', 500, 4000).project;
      textProject.clips = [];
      const text = textProject.layers.find((layer) => layer.id === 'text');
      text.startMs = invalid; text.endMs = invalid;
      const fixedText = setLayerTiming(textProject, 'text', edge, invalid, invalid).layers.find((layer) => layer.id === 'text');
      assert.deepEqual([fixedText.startMs, fixedText.endMs], [0, 80]);
    }
  }
  assert.deepEqual(editCanvasTimelineRange({ startMs: 500, endMs: 1500 }, 'end', 0, 501), { startMs: 500, endMs: 580 });
  assert.throws(() => editCanvasTimelineRange({ startMs: 500, endMs: 1500 }, 'move', Number.MAX_VALUE, 0), /supported range/);
});
