import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createExportCacheFileName,
  estimateVideoExportStorageBytes,
  isCaptionStudioExportCacheArtifact,
  isLegacyCaptionStudioExportCacheArtifact,
  isStaleCaptionStudioExportCacheArtifact,
  isStaleLegacyCaptionStudioExportCacheArtifact,
} from '../src/services/export-storage-policy.ts';

test('export storage estimate grows with duration and rendered pixel rate', () => {
  const short1080 = estimateVideoExportStorageBytes({
    width: 1080,
    height: 1920,
    durationMs: 10_000,
    frameRate: 30,
  });
  const long1080 = estimateVideoExportStorageBytes({
    width: 1080,
    height: 1920,
    durationMs: 120_000,
    frameRate: 30,
  });
  const long4k = estimateVideoExportStorageBytes({
    width: 2160,
    height: 3840,
    durationMs: 120_000,
    frameRate: 30,
  });
  assert.ok(short1080 >= 96 * 1024 * 1024);
  assert.ok(long1080 > short1080);
  assert.ok(long4k > long1080);
  assert.throws(
    () => estimateVideoExportStorageBytes({ width: 0, height: 1080, durationMs: 1_000, frameRate: 30 }),
    /render width is invalid/,
  );
});

test('cache filenames are human-readable, unique, and narrowly recognizable', () => {
  const fileName = createExportCacheFileName('Birthday / beach!', 'mp4', 1_777_777_777_777, 'Ab_12$xyz');
  assert.equal(fileName, 'caption-studio-Birthday-beach-1777777777777-ab12xyz0.mp4');
  assert.equal(isCaptionStudioExportCacheArtifact(fileName), true);
  assert.equal(isCaptionStudioExportCacheArtifact(`.${fileName.slice(0, -4)}-base.png`), true);
  assert.equal(isCaptionStudioExportCacheArtifact('Birthday-beach-1777777777777-ab12xyz0.mp4'), false);
  assert.equal(isCaptionStudioExportCacheArtifact('../caption-studio-export-1777777777777-ab12xyz0.mp4'), false);
  assert.equal(isLegacyCaptionStudioExportCacheArtifact('Birthday-beach-1777777777777.mp4'), true);
  assert.equal(isLegacyCaptionStudioExportCacheArtifact('unrelated.tmp'), false);
});

test('stale cleanup policy fails closed and never claims fresh or unrelated cache files', () => {
  const nowMs = 2_000_000_000_000;
  const name = createExportCacheFileName('Project', 'ass', nowMs, '12345678');
  assert.equal(isStaleCaptionStudioExportCacheArtifact(name, (nowMs - 25 * 60 * 60 * 1_000) / 1_000, nowMs), true);
  assert.equal(isStaleCaptionStudioExportCacheArtifact(name, (nowMs - 23 * 60 * 60 * 1_000) / 1_000, nowMs), false);
  assert.equal(isStaleCaptionStudioExportCacheArtifact(name, undefined, nowMs), false);
  assert.equal(isStaleCaptionStudioExportCacheArtifact('shared-cache.mp4', 0, nowMs), false);
  assert.equal(isStaleLegacyCaptionStudioExportCacheArtifact('Project-1999913600000.mp4', 0, nowMs), true);
  assert.equal(isStaleLegacyCaptionStudioExportCacheArtifact('../Project-1999913600000.mp4', 0, nowMs), false);
});

test('project export preflights space and owns temporary cleanup around native execution', () => {
  const service = readFileSync(new URL('../src/services/project-export.ts', import.meta.url), 'utf8');
  const native = readFileSync(new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/TimelineVideoExporter.kt', import.meta.url), 'utf8');
  assert.match(service, /estimateVideoExportStorageBytes\(unresolvedPlan\)/);
  assert.match(service, /requireFreeSpace\([\s\S]*'export this video'/);
  assert.match(service, /protectTemporaryVideoExportArtifacts\(outputUri\)/);
  assert.match(service, /session\.startNative[\s\S]*FileSystem\.getInfoAsync\(outputUri\)[\s\S]*Sharing\.shareAsync\(outputUri[\s\S]*finally \{[\s\S]*removeTemporaryVideoExportArtifacts\(outputUri\);/);
  assert.match(service, /outputInfo\.size !== result\.sizeBytes/);
  assert.match(native, /val outputSize = verifyLocalVideo\(task\.output\)[\s\S]*publishToMediaLibrary\(task\)[\s\S]*verifyPublishedVideo\(mediaUri, outputSize\)/);
  assert.match(native, /"outputUri" to Uri\.fromFile\(task\.output\)\.toString\(\)/);
  assert.match(native, /does not contain a video track/);
  assert.match(service, /catch \(error\) \{\s*await removeFailedSubtitleExportArtifact\(uri\);\s*throw error;/);
});
