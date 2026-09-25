import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createCaptionProject } from '../src/lib/project-factory.ts';
import { setVideoClipTransform } from '../src/lib/project-editor.ts';
import { applyPreviewSceneGeometry } from '../src/lib/preview-scene-project.ts';
import { previewObjectAtPoint } from '../src/lib/preview-object-hit-test.ts';

const source = {
  id: 'source', uri: 'file:///source.mp4', storageMode: 'copied',
  displayName: 'source', durationMs: 5000, width: 1920, height: 1080, rotation: 0,
};
const geometry = (position = { x: 0.5, y: 0.5 }, scaleX = 1, scaleY = 1) => ({
  position, box: { width: 1, height: 1 }, scale: 1, scaleX, scaleY, rotation: 0,
});

test('video clip transform retains independent edge scale and the preview-safe position range', () => {
  const project = createCaptionProject({ id: 'video-gesture', name: 'Video gesture', sources: [source] });
  const next = setVideoClipTransform(project, project.clips[0].id, {
    position: { x: -0.25, y: 1.25 }, scaleX: 1.75, scaleY: 0.65,
  });
  assert.equal(next.clips[0].transform.position.x, -0.25);
  assert.equal(next.clips[0].transform.position.y, 1.25);
  assert.equal(next.clips[0].transform.scaleX, 1.75);
  assert.equal(next.clips[0].transform.scaleY, 0.65);
  assert.equal(project.clips[0].transform.scaleX ?? 1, 1);
});

test('video gesture commits by captured clip identity once and rejects stale geometry', () => {
  const project = createCaptionProject({ id: 'video-scene', name: 'Video scene', sources: [source] });
  const clip = project.clips[0];
  const target = { key: `video:${clip.id}`, order: 0, deletable: false,
    selection: { kind: 'video', id: clip.id }, geometry: geometry() };
  const next = applyPreviewSceneGeometry(project, target, geometry({ x: 0.7, y: 0.4 }, 1.4, 0.8));
  assert.notEqual(next, project);
  assert.equal(next.clips[0].transform.position.x, 0.7);
  assert.equal(next.clips[0].transform.scaleX, 1.4);
  assert.equal(next.clips[0].transform.scaleY, 0.8);
  assert.equal(next.layers, project.layers);
  assert.equal(next.captions, project.captions);
  assert.equal(applyPreviewSceneGeometry(next, target, geometry({ x: 0.2, y: 0.2 })), next);
});

test('paint order keeps image and both caption languages above the video', () => {
  const size = { width: 400, height: 300 };
  const common = geometry();
  const targets = [
    { key: 'video:one', order: 0, geometry: common, selection: { kind: 'video', id: 'one' } },
    { key: 'caption:one', order: 1, geometry: { ...common, box: { width: 0.4, height: 0.2 } },
      selection: { kind: 'captions', captionId: 'one' } },
    { key: 'translation:zh:one', order: 2, geometry: { ...common, box: { width: 0.2, height: 0.1 } },
      selection: { kind: 'translation', id: 'zh', captionId: 'one' } },
    { key: 'image:one', order: 3, geometry: { ...common, box: { width: 0.1, height: 0.1 } },
      selection: { kind: 'image', id: 'one' } },
  ];
  assert.equal(previewObjectAtPoint(targets, { x: 200, y: 150 }, size)?.key, 'image:one');
  assert.equal(previewObjectAtPoint(targets.slice(0, 3), { x: 200, y: 150 }, size)?.key, 'translation:zh:one');
  assert.equal(previewObjectAtPoint(targets.slice(0, 2), { x: 200, y: 150 }, size)?.key, 'caption:one');
  assert.equal(previewObjectAtPoint(targets, { x: 20, y: 20 }, size)?.key, 'video:one');
});

test('editor routes every preview object through one responder instead of a video-only overlay', () => {
  const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(editor, /enabled:\s*activeTool\s*!==\s*'video'/);
  assert.doesNotMatch(editor, /<VideoTransformOverlay\b/);
  assert.match(editor, /key:\s*`video:/);
});
