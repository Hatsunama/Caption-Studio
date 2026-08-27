import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { assertSupportedVideo } from '../src/lib/media-validation.ts';
import {
  encodeModelVerificationMarker,
  modelVerificationMarkerMatches,
} from '../src/lib/model-verification.ts';
import {
  buildPcm16MonoWave,
  parseCaptionPcmWave,
  planOverlappingPcmChunks,
} from '../src/lib/wav-chunking.ts';

test('video import validation distinguishes audio-only and undecodable video tracks', () => {
  const valid = {
    durationMs: 1_000,
    width: 1920,
    height: 1080,
    rotation: 0,
    hasAudio: true,
    hasVideo: true,
    hasVideoTrack: true,
    videoMimeType: 'video/avc',
  };
  assert.doesNotThrow(() => assertSupportedVideo(valid, 'clip.mp4'));
  assert.throws(
    () => assertSupportedVideo({ ...valid, hasVideo: false, hasVideoTrack: false }, 'voice.m4a'),
    /does not contain a video track/,
  );
  assert.throws(
    () => assertSupportedVideo({ ...valid, hasVideo: false }, 'broken.mp4'),
    /damaged or uses a video format/,
  );
});

test('model marker is bound to the verified file identity rather than size alone', () => {
  const identity = {
    fileName: 'ggml-base-q5_1.bin',
    sizeBytes: 59_707_625,
    modifiedAtMs: 1_777_777,
    createdAtMs: 1_666_666,
  };
  const sha256 = 'a'.repeat(64);
  const marker = encodeModelVerificationMarker(identity, sha256);
  assert.ok(marker);
  assert.equal(modelVerificationMarkerMatches(marker, identity, sha256), true);
  assert.equal(modelVerificationMarkerMatches(marker, { ...identity, modifiedAtMs: 1_888_888 }, sha256), false);
  assert.equal(modelVerificationMarkerMatches(marker, { ...identity, createdAtMs: 1_555_555 }, sha256), false);
  assert.equal(modelVerificationMarkerMatches(sha256, identity, sha256), false);
});

test('cooperative VAD chunks preserve valid WAV headers and bounded overlap', () => {
  const pcm = new Uint8Array(16_000 * 2 * 65);
  const wave = buildPcm16MonoWave(pcm, 16_000);
  const format = parseCaptionPcmWave(wave.subarray(0, 44), wave.byteLength);
  const ranges = planOverlappingPcmChunks(format.dataBytes, format.bytesPerSecond, 30, 2);
  assert.deepEqual(ranges, [
    { start: 0, end: 960_000 },
    { start: 896_000, end: 1_856_000 },
    { start: 1_792_000, end: 2_080_000 },
  ]);
  assert.equal(format.sampleRate, 16_000);
  assert.equal(format.channelCount, 1);
  assert.throws(() => parseCaptionPcmWave(new Uint8Array(44), 44), /not a WAV file/);
});

test('durable media and font imports validate staging before atomic promotion', () => {
  const native = readFileSync(new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/CaptionMediaModule.kt', import.meta.url), 'utf8');
  const mediaImport = readFileSync(new URL('../src/services/media-import.ts', import.meta.url), 'utf8');
  const projectMedia = readFileSync(new URL('../src/services/project-media.ts', import.meta.url), 'utf8');
  const fontStorage = readFileSync(new URL('../src/services/font-storage.ts', import.meta.url), 'utf8');
  const transcription = readFileSync(new URL('../src/services/transcription.ts', import.meta.url), 'utf8');

  assert.match(native, /mime\.startsWith\("video\/"\)/);
  assert.match(native, /probeVideoFrame\(retriever,/);
  assert.match(native, /"hasVideo" to frameDecodable/);
  assert.match(mediaImport, /probeVideoForImport\(asset\.uri, asset\.name\)[\s\S]*persistReadPermission/);
  assert.match(projectMedia, /copyAsync\(\{ from: options\.sourceUri, to: stagingUri \}\)[\s\S]*validateImageFile\(stagingUri\)[\s\S]*moveAsync/);
  assert.match(fontStorage, /copyAsync\(\{ from: asset\.uri, to: stagingUri \}\)[\s\S]*validateFontFile\(stagingUri\)[\s\S]*moveAsync/);
  assert.match(transcription, /modelVerificationMarkerMatches/);
  assert.match(transcription, /model\.downloadBytes \+ MODEL_REPLACEMENT_HEADROOM_BYTES/);
  assert.match(transcription, /planOverlappingPcmChunks[\s\S]*session\?\.throwIfCancelled\(\)/);
});
