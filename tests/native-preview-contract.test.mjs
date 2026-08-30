import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const nativeModule = readFileSync(
  new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/CaptionMediaModule.kt', import.meta.url),
  'utf8',
);
const segmenter = readFileSync(
  new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/MediaPipePersonSegmenter.kt', import.meta.url),
  'utf8',
);
const orientation = readFileSync(
  new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/BitmapOrientation.kt', import.meta.url),
  'utf8',
);
const nativeContract = readFileSync(
  new URL('../modules/caption-media/src/CaptionMediaModule.ts', import.meta.url),
  'utf8',
);
const previewService = readFileSync(
  new URL('../src/services/person-compositor.ts', import.meta.url),
  'utf8',
);
const editor = readFileSync(
  new URL('../src/app/editor.tsx', import.meta.url),
  'utf8',
);
const renderTransforms = readFileSync(
  new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/RenderTransforms.kt', import.meta.url),
  'utf8',
);
const timelineExporter = readFileSync(
  new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/TimelineVideoExporter.kt', import.meta.url),
  'utf8',
);

test('person segmentation releases its input and every confidence-mask image', () => {
  assert.match(segmenter, /finally\s*\{\s*masks\.forEach\s*\{\s*mask\s*->\s*runCatching\s*\{\s*mask\.close\(\)/s);
  assert.match(segmenter, /finally\s*\{\s*inputImage\.close\(\)/s);
  assert.match(segmenter, /synchronized\(lifecycleLock\)/);
  assert.match(nativeModule, /if \(requestEpoch != previewEpoch\) throw CancellationException/);
});

test('preview background uses timeline time independently of foreground source time', () => {
  assert.match(nativeContract, /timeMs: number;\s*backgroundTimeMs: number;/s);
  assert.match(previewService, /timeMs: options\.sourceTimeMs,\s*backgroundTimeMs: options\.timelineTimeMs,/s);
  assert.match(nativeModule, /readBackground\(background, backgroundTimeMs,/);
});

test('preview backgrounds normalize video metadata and image EXIF orientation', () => {
  assert.match(nativeModule, /METADATA_KEY_VIDEO_ROTATION/);
  assert.match(nativeModule, /rotationSwapsDimensions\(sourceRotation\)/);
  assert.match(nativeModule, /BitmapOrientation\.fromExif\(ExifInterface\(stream\)\)/);
  assert.match(nativeModule, /drawBitmapFill\(canvas, requireNotNull\(backgroundBitmap\)/);
  assert.match(orientation, /flipHorizontal: Boolean/);
  assert.match(orientation, /normalizeRotationDegrees/);
});

test('MediaMetadataRetriever video frames are not rotated a second time', () => {
  assert.match(nativeModule, /foreground = decoded/);
  assert.match(nativeModule, /frame = recovered/);
  assert.doesNotMatch(nativeModule, /orientBitmapAndRecycle\((?:decoded|recovered|frame), (?:sourceRotation|rotation)\)/);
  assert.match(timelineExporter, /displayWidth = if \(rotationSwapsDimensions\(rotation\)\) height else width/);
  assert.doesNotMatch(timelineExporter, /orientBitmap\(decoded, rotation\)/);
});

test('background preview and export share the full output-canvas transform contract', () => {
  assert.match(nativeContract, /outputWidth: number;\s*outputHeight: number;/s);
  assert.match(nativeContract, /videoFit: 'fit' \| 'fill';\s*videoPositionX: number;\s*videoPositionY: number;\s*videoScale: number;\s*videoRotation: number;/s);
  assert.match(previewService, /outputWidth: Math\.max\(2, Math\.round\(options\.outputSize\.width\)\)/);
  assert.match(previewService, /videoFit: options\.videoTransform\.fit/);
  assert.match(previewService, /videoPositionX: options\.videoTransform\.position\.x/);
  assert.match(previewService, /videoPositionY: options\.videoTransform\.position\.y/);
  assert.match(previewService, /videoScale: options\.videoTransform\.scale/);
  assert.match(previewService, /videoRotation: options\.videoTransform\.rotation/);
  assert.match(nativeModule, /val personMatrix = personContentMatrix\(/);
  assert.match(renderTransforms, /fun contentMatrix/);
  assert.match(renderTransforms, /fun personContentMatrix/);
  assert.match(editor, /outputSize: \{ width: canvasWidth, height: canvasHeight \}/);
  assert.match(editor, /videoTransform: currentVideoTransform/);
});

test('persisted read grants have a symmetric read-only native release boundary', () => {
  assert.match(nativeContract, /releaseReadPermission\(inputUri: string\): Promise<boolean>/);
  assert.match(nativeModule, /if \(uri\.scheme != "content"\) return true/);
  assert.match(nativeModule, /releasePersistableUriPermission\(uri, Intent\.FLAG_GRANT_READ_URI_PERMISSION\)/);
  assert.doesNotMatch(nativeModule, /releasePersistableUriPermission\([^\n]*FLAG_GRANT_WRITE_URI_PERMISSION/);
});
