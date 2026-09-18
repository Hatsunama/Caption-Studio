import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
const videoOverlay = readFileSync(new URL('../src/components/editor/video-transform-overlay.tsx', import.meta.url), 'utf8');
const nativeExporter = readFileSync(new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/TimelineVideoExporter.kt', import.meta.url), 'utf8');

test('the permanent preview input plane sits above the render tree and owns non-video touches', () => {
  const renderLayers = editor.indexOf('{timelineLayers.map((layer) => {');
  const chrome = editor.indexOf('<LayerTransformOverlay', renderLayers);
  const surface = editor.indexOf('testID="preview-scene-input"', chrome);
  assert.ok(renderLayers >= 0 && chrome > renderLayers && surface > chrome);
  assert.match(editor.slice(surface, surface + 700), /collapsable=\{false\}/);
  assert.match(editor.slice(surface, surface + 700), /\{\.\.\.previewSceneResponders\}/);
});

test('video transform pauses playback and pins changes to the granting clip identity', () => {
  assert.match(editor, /id=\{currentClipEntry\.clip\.id\}/);
  assert.match(editor, /onInteractionStart=\{\(\) => \{ transport\.pause\(\); beginHistoryInteraction\(\); \}\}/);
  assert.match(editor, /updateVideoTransform\(patch, currentClipEntry\.clip\.id\)/);
  assert.match(videoOverlay, /owner\.current = \{[\s\S]*id: current\.id,[\s\S]*onChange: current\.onChange/);
  assert.doesNotMatch(videoOverlay, /onPanResponderMove:[\s\S]*propsRef\.current\.onChange/);
});

test('native export paints layers in the same forward order used by preview and hit testing', () => {
  assert.match(nativeExporter, /plan\.layers\.forEach \{ layer ->/);
  assert.doesNotMatch(nativeExporter, /plan\.layers\.asReversed\(\)/);
});
