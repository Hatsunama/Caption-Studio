import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
const previewGesture = readFileSync(new URL('../src/hooks/use-preview-scene-gesture.ts', import.meta.url), 'utf8');
const nativeExporter = readFileSync(new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/TimelineVideoExporter.kt', import.meta.url), 'utf8');

test('the permanent preview input plane sits above the render tree and owns every preview object touch', () => {
  const renderLayers = editor.indexOf('{timelineLayers.map((layer) => {');
  const chrome = editor.indexOf('<LayerTransformOverlay', renderLayers);
  const surface = editor.indexOf('testID="preview-scene-input"', chrome);
  assert.ok(renderLayers >= 0 && chrome > renderLayers && surface > chrome);
  assert.match(editor.slice(surface, surface + 700), /collapsable=\{false\}/);
  assert.match(editor.slice(surface, surface + 700), /\{\.\.\.previewSceneResponders\}/);
});

test('video uses the same event-owned preview scene as foreground objects', () => {
  assert.match(editor, /selection: \{ kind: 'video', id: currentClipEntry\.clip\.id \}/);
  assert.match(editor, /onInteractionStart: \(\) => transport\.pause\(\)/);
  assert.match(editor, /const next = applyPreviewSceneGeometry\(before, target, geometry\)/);
  assert.match(editor, /currentTransform=\{previewVideoTransform\}/);
  assert.doesNotMatch(editor, /VideoTransformOverlay/);
});

test('one event-local canvas frame owns a complete video, text, image, or caption gesture', () => {
  const dispatchStart = previewGesture.indexOf("const dispatch =");
  const grantStart = previewGesture.indexOf('onResponderGrant:', dispatchStart);
  const startHandler = previewGesture.indexOf('onResponderStart:', grantStart);
  assert.ok(dispatchStart >= 0 && grantStart > dispatchStart && startHandler > grantStart);
  assert.doesNotMatch(previewGesture.slice(dispatchStart, grantStart), /locate\(event\)/);
  assert.doesNotMatch(previewGesture.slice(grantStart, startHandler), /measureInWindow/);
});

test('native export paints layers in the same forward order used by preview and hit testing', () => {
  assert.match(nativeExporter, /plan\.layers\.forEach \{ layer ->/);
  assert.doesNotMatch(nativeExporter, /plan\.layers\.asReversed\(\)/);
});
