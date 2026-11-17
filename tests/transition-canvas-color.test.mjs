import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createHarness } from './transition-integration-host.mjs';

test('actual export plan normalizes canvas RGBA once over black without changing project selection', () => {
  const h = createHarness('crossfade');
  const load = name => h.load(fileURLToPath(new URL(`../src/lib/${name}.ts`, import.meta.url)));
  const { createCaptionProject } = load('project-factory');
  const { buildTimelineRenderPlan } = load('export-render-plan');
  const project = createCaptionProject({ id: 'color', name: 'Color', sources: [{ id: 'video', uri: 'file:///video.mp4', durationMs: 4000, width: 1920, height: 1080, rotation: 0, frameRate: 30, displayName: 'video.mp4' }] });
  for (const [color, expected] of [['#123456', '#123456'], ['#FF000080', '#800000'], ['#00FF0000', '#000000'], ['#abcdefFF', '#ABCDEF'], ['#FFFFFF01', '#010101']]) {
    project.canvas.backgroundColor = color;
    assert.equal(buildTimelineRenderPlan(project).backgroundColor, expected);
    assert.equal(project.canvas.backgroundColor, color);
  }
  for (const invalid of ['red', '#abc', '#12345G', '#123456789', '', '#123456\n']) {
    project.canvas.backgroundColor = invalid;
    assert.throws(() => buildTimelineRenderPlan(project), /canvas.*color/i);
  }
  h.unmount();
});
