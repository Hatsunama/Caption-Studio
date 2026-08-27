import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildTimelineRenderPlan } from '../src/lib/export-render-plan.ts';
import { assertSupportedVideo } from '../src/lib/media-validation.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { decodeVersionTwoProject } from '../src/lib/project-schema.ts';
import {
  canReuseSourceTranscription,
  createSourceTranscriptionFingerprint,
} from '../src/lib/source-transcription-fingerprint.ts';
import {
  selectExportFrameRate,
  validatedSourceFrameRate,
} from '../src/lib/video-source-metadata.ts';

test('source frame rates are bounded at import and normalized for legacy project creation', () => {
  assert.equal(validatedSourceFrameRate(undefined, 'Legacy.mp4'), 30);
  assert.equal(validatedSourceFrameRate(29.97, 'Camera.mp4'), 29.97);
  assert.throws(() => validatedSourceFrameRate(0, 'Broken.mp4'), /invalid frame-rate metadata/);
  assert.throws(() => validatedSourceFrameRate(241, 'Broken.mp4'), /invalid frame-rate metadata/);

  const legacySource = videoSource('legacy', 4_000, 1080, 1920, undefined);
  const project = createCaptionProject({ id: 'legacy-rate', name: 'Legacy rate', sources: [legacySource] });
  assert.equal(project.sources[0].frameRate, 30);
  assert.equal(selectExportFrameRate([{ frameRate: 10 }]), 15);
  assert.equal(selectExportFrameRate([{ frameRate: 23.976 }, { frameRate: 59.94 }]), 60);
  assert.equal(selectExportFrameRate([{ frameRate: 120 }]), 60);
});

test('project decoding hydrates legacy frame rates and rejects corrupt persisted metadata', () => {
  const project = createCaptionProject({
    id: 'schema-rate',
    name: 'Schema rate',
    sources: [videoSource('source', 4_000, 1920, 1080, 29.97)],
  });
  const legacy = structuredClone(project);
  delete legacy.sources[0].frameRate;
  assert.equal(decodeVersionTwoProject(legacy).sources[0].frameRate, 30);

  const corrupt = structuredClone(project);
  corrupt.sources[0].frameRate = Number.NaN;
  assert.throws(() => decodeVersionTwoProject(corrupt), /video source 1 frame rate is invalid/);
});

test('Original resolution and export frame rate use every active clip source and ignore inactive sources', () => {
  const project = createCaptionProject({
    id: 'active-quality',
    name: 'Active quality',
    sources: [
      videoSource('inactive-first', 4_000, 640, 360, 15),
      videoSource('active-hd', 4_000, 1920, 1080, 23.976),
      videoSource('active-4k', 4_000, 2160, 3840, 59.94, 90),
    ],
  });
  project.clips = project.clips.filter((clip) => clip.sourceId !== 'inactive-first');
  project.canvas = { ...project.canvas, preset: '16:9', aspectWidth: 16, aspectHeight: 9 };
  project.export = { ...project.export, resolution: 'original' };

  const plan = buildTimelineRenderPlan(project);
  assert.deepEqual({ width: plan.width, height: plan.height, frameRate: plan.frameRate }, {
    width: 3840,
    height: 2160,
    frameRate: 60,
  });
});

test('source-transcription reuse requires the same SHA-256 fingerprint and model', () => {
  const fingerprint = createSourceTranscriptionFingerprint('A'.repeat(64));
  const matching = {
    language: 'en',
    modelId: 'balanced',
    generatedAt: '2026-08-27T00:00:00.000Z',
    sourceFingerprint: fingerprint,
    words: [],
  };

  assert.equal(fingerprint.digest, 'a'.repeat(64));
  assert.equal(canReuseSourceTranscription(matching, 'balanced', fingerprint), true);
  assert.equal(canReuseSourceTranscription({ ...matching, sourceFingerprint: undefined }, 'balanced', fingerprint), false);
  assert.equal(canReuseSourceTranscription(matching, 'accurate', fingerprint), false);
  assert.equal(canReuseSourceTranscription(matching, 'balanced', createSourceTranscriptionFingerprint('b'.repeat(64))), false);
  assert.throws(() => createSourceTranscriptionFingerprint('not-a-digest'), /fingerprint is invalid/);
});

test('fingerprints persist canonically while legacy results remain intentionally non-reusable', () => {
  const project = createCaptionProject({
    id: 'fingerprint-schema',
    name: 'Fingerprint schema',
    sources: [videoSource('source', 4_000, 1920, 1080, 30)],
  });
  project.transcription.sourceResults.source = {
    language: 'en',
    modelId: 'balanced',
    generatedAt: '2026-08-27T00:00:00.000Z',
    sourceFingerprint: { algorithm: 'sha256', digest: 'A'.repeat(64) },
    words: [],
  };

  const decoded = decodeVersionTwoProject(structuredClone(project));
  assert.equal(decoded.transcription.sourceResults.source.sourceFingerprint.digest, 'a'.repeat(64));

  const legacy = structuredClone(project);
  delete legacy.transcription.sourceResults.source.sourceFingerprint;
  assert.equal(decodeVersionTwoProject(legacy).transcription.sourceResults.source.sourceFingerprint, undefined);

  const corrupt = structuredClone(project);
  corrupt.transcription.sourceResults.source.sourceFingerprint.digest = 'abcd';
  assert.throws(() => decodeVersionTwoProject(corrupt), /fingerprint digest is invalid/);
});

test('native probing, import, and generation retain one explicit metadata and cache contract', () => {
  const nativeTypes = readFileSync(new URL('../modules/caption-media/src/CaptionMedia.types.ts', import.meta.url), 'utf8');
  const nativeProbe = readFileSync(new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/CaptionMediaModule.kt', import.meta.url), 'utf8');
  const importer = readFileSync(new URL('../src/services/media-import.ts', import.meta.url), 'utf8');
  const pipeline = readFileSync(new URL('../src/services/project-transcription.ts', import.meta.url), 'utf8');

  assert.match(nativeTypes, /frameRate: number/);
  assert.match(nativeProbe, /detectedVideoFrameRate\(retriever, durationMs, trackFrameRate\)/);
  assert.match(nativeProbe, /"frameRate" to frameRate/);
  assert.match(importer, /frameRate: info\.frameRate/);
  assert.match(pipeline, /CaptionMedia\.sha256\(source\.uri\)/);
  assert.match(pipeline, /canReuseSourceTranscription\(sourceResults\[sourceId\], modelId, sourceFingerprint\)/);
  assert.match(pipeline, /sourceFingerprint,[\s\S]*words: result\.words/);
});

test('video validation rejects invalid probed frame rates without rejecting a legacy omission', () => {
  const valid = {
    durationMs: 4_000,
    width: 1920,
    height: 1080,
    rotation: 0,
    frameRate: 29.97,
    hasAudio: true,
    hasVideo: true,
    hasVideoTrack: true,
    videoMimeType: 'video/avc',
  };
  assert.doesNotThrow(() => assertSupportedVideo(valid, 'Camera.mp4'));
  assert.throws(() => assertSupportedVideo({ ...valid, frameRate: Number.POSITIVE_INFINITY }, 'Broken.mp4'), /invalid frame-rate metadata/);
  assert.doesNotThrow(() => assertSupportedVideo({ ...valid, frameRate: undefined }, 'Legacy.mp4'));
});

function videoSource(id, durationMs, width, height, frameRate, rotation = 0) {
  return {
    id,
    uri: `content://media/video/${id}`,
    storageMode: 'linked',
    displayName: `${id}.mp4`,
    durationMs,
    width,
    height,
    rotation,
    ...(frameRate === undefined ? {} : { frameRate }),
  };
}
