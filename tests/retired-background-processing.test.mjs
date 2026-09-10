import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('background processing and person motion have no executable product path', () => {
  const removed = [
    '../src/components/editor/background-tools.tsx',
    '../src/services/background-processing-consent.ts',
    '../src/services/person-compositor.ts',
    '../src/lib/person-motion.ts',
    '../src/lib/person-matte-presets.ts',
    '../modules/caption-media/android/src/main/java/app/captionstudio/media/MediaPipePersonSegmenter.kt',
    '../modules/caption-media/android/src/main/java/app/captionstudio/media/PersonMatteProcessor.kt',
    '../modules/caption-media/android/src/main/java/app/captionstudio/media/PersonMotionPath.kt',
    '../modules/caption-media/android/src/main/java/app/captionstudio/media/BitmapMatte.kt',
    '../modules/caption-media/android/src/main/assets/selfie_multiclass_256x256.tflite',
  ];
  removed.forEach((path) => assert.equal(existsSync(new URL(path, import.meta.url)), false, path));

  const editor = source('../src/app/editor.tsx');
  const renderPlan = source('../src/lib/export-render-plan.ts');
  const nativePlan = source('../modules/caption-media/android/src/main/java/app/captionstudio/media/TimelineRenderPlan.kt');
  const nativeModule = source('../modules/caption-media/android/src/main/java/app/captionstudio/media/CaptionMediaModule.kt');
  const nativeExporter = source('../modules/caption-media/android/src/main/java/app/captionstudio/media/TimelineVideoExporter.kt');
  const nativeGradle = source('../modules/caption-media/android/build.gradle');
  for (const runtime of [editor, renderPlan, nativePlan, nativeModule, nativeExporter]) {
    assert.doesNotMatch(runtime, /backgroundReplacement|renderPersonPreview|PersonMotion|PersonMatte|MediaPipePerson/);
  }
  assert.doesNotMatch(nativeGradle, /mediapipe|face-detection/);
});

test('legacy project metadata is inert but remains visible to asset cleanup', () => {
  const schema = source('../src/lib/project-schema.ts');
  const database = source('../src/services/database.ts');
  const lifecycle = source('../src/lib/media-lifecycle.ts');
  assert.match(schema, /function decodeBackgroundReplacement[\s\S]*enabled: false[\s\S]*keyframes: \[\]/);
  assert.match(database, /function hydrateBackgroundReplacement[\s\S]*enabled: false[\s\S]*keyframes: \[\]/);
  assert.match(lifecycle, /project\.backgroundReplacement\.source/);
});
