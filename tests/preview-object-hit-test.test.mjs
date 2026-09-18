import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { previewObjectAtPoint, previewObjectContainsPoint } from '../src/lib/preview-object-hit-test.ts';

const size = { width: 300, height: 600 };
const geometry = (x, y, width = 0.2, height = 0.1, rotation = 0) => ({
  position: { x, y }, box: { width, height }, rotation,
});

test('preview hit testing uses the saved scene order instead of current selection state', () => {
  const back = { key: 'back', selection: 'back', geometry: geometry(0.5, 0.5, 0.5, 0.4), order: 2 };
  const front = { key: 'front', selection: 'front', geometry: geometry(0.5, 0.5, 0.25, 0.2), order: 7 };
  assert.equal(previewObjectAtPoint([front, back], { x: 150, y: 300 }, size)?.key, 'front');
  assert.equal(previewObjectAtPoint([back, front], { x: 150, y: 300 }, size)?.key, 'front');
});

test('preview hit testing follows rotation and rejects points outside the authored object', () => {
  const rotated = geometry(0.5, 0.5, 0.4, 0.08, 45);
  assert.equal(previewObjectContainsPoint(rotated, { x: 165, y: 330 }, size), true);
  assert.equal(previewObjectContainsPoint(rotated, { x: 210, y: 300 }, size), false);
});

test('preview interaction has one scene owner and no per-object selection pressables', () => {
  const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
  const transform = readFileSync(new URL('../src/components/editor/layer-transform-overlay.tsx', import.meta.url), 'utf8');
  const gesture = readFileSync(new URL('../src/hooks/use-preview-scene-gesture.ts', import.meta.url), 'utf8');
  assert.match(editor, /usePreviewSceneGesture\(\{/);
  assert.match(editor, /ref=\{previewCanvasRef\}/);
  assert.match(editor, /\{\.\.\.previewSceneResponders\}/);
  assert.doesNotMatch(transform, /Select layer|selectable|onSelect/);
  assert.match(transform, /pointerEvents="none"/);
  assert.match(gesture, /createPreviewSceneController/);
  assert.match(gesture, /onStartShouldSetResponder:/);
  assert.doesNotMatch(gesture, /ShouldSetResponderCapture|requestAnimationFrame/);
  assert.match(editor, /testID="preview-scene-input"/);
  assert.match(editor, /collapsable=\{false\}/);
});
