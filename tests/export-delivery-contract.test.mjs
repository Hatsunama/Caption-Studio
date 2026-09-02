import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const exporter = readFileSync(
  new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/TimelineVideoExporter.kt', import.meta.url),
  'utf8',
);
const delivery = readFileSync(
  new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/TimelineExportDelivery.kt', import.meta.url),
  'utf8',
);
const compositorTest = readFileSync(
  new URL('../modules/caption-media/android/src/test/java/app/captionstudio/media/TimelineVideoCompositorSettingsTest.kt', import.meta.url),
  'utf8',
);
const projectExport = readFileSync(
  new URL('../src/services/project-export.ts', import.meta.url),
  'utf8',
);
const editor = readFileSync(
  new URL('../src/app/editor.tsx', import.meta.url),
  'utf8',
);

test('native export keeps the local MP4 until JS delivery and never covers the video with the canvas', () => {
  assert.match(exporter, /sequences \+= EditedMediaItemSequence\.withVideoFrom\(listOf\(baseVideo\)\)/);
  assert.equal([...exporter.matchAll(/withVideoFrom\(listOf\(baseVideo\)\)/g)].length, 1);
  assert.match(exporter, /if \(inputId != VIDEO_SEQUENCE_INDEX\) return StaticOverlaySettings\.Builder\(\)\.build\(\)/);
  assert.doesNotMatch(exporter, /CLOCK_SEQUENCE_INDEX/);
  assert.doesNotMatch(compositorTest, /getOverlaySettings\(2,/);
  assert.match(compositorTest, /getOverlaySettings\(0, 500_000\)\.alphaScale/);
  assert.match(exporter, /requireRenderedVideoFile\(task\.output\)/);
  assert.match(exporter, /inspectRenderedVideo\(context, Uri\.fromFile\(task\.output\), sizeBytes\)/);
  assert.match(exporter, /inspectRenderedVideo\(context, mediaUri, verified\.sizeBytes\)/);
  assert.match(exporter, /task\.publishedVerified\.set\(true\)/);
  assert.match(exporter, /"outputUri" to Uri\.fromFile\(task\.output\)\.toString\(\)/);
  assert.doesNotMatch(exporter, /task\.output\.delete\(\)\s*\n\s*promise\.resolve/);
  assert.match(exporter, /return scanned \?: throw IllegalStateException/);
  assert.match(delivery, /put\(MediaStore\.Video\.Media\.DURATION, verified\.durationMs\)/);
  assert.match(delivery, /put\(MediaStore\.Video\.Media\.SIZE, verified\.sizeBytes\)/);
  assert.match(exporter, /if \(!resolve\(task, result\)\)/);
  assert.match(exporter, /if \(current == null \|\| current\.publishedVerified\.get\(\)\)/);
  assert.match(exporter, /task\.promise\.reject\("E_EXPORT_CANCELLED"/);
});

test('JS export proves the file exists, opens a share sheet, then deletes only the cache copy', () => {
  assert.match(projectExport, /assertVideoExportDelivery\(nativeResult\)/);
  assert.match(projectExport, /confirmLocalExportFile\(outputUri, delivered\.sizeBytes\)/);
  assert.match(projectExport, /Sharing\.shareAsync\(outputUri, \{[\s\S]*mimeType: 'video\/mp4'/);
  assert.match(projectExport, /The exported video file is missing/);
  assert.match(projectExport, /The exported video file is empty/);
  assert.match(projectExport, /The exported video file is incomplete/);
  assert.match(editor, /Saved to Movies\/Caption Studio/);
  assert.match(editor, /reportCaptionCommitFailure/);
  assert.match(editor, /Second language visibility not saved/);
  assert.match(editor, /Canvas size not saved/);
  assert.doesNotMatch(editor, /commitCaptionStructure\(mutation\)\.catch\(\(\) => undefined\)/);
});
