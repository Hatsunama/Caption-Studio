import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  decodeModelDownloadResume,
  encodeModelDownloadResume,
  remainingModelDownloadBytes,
} from '../src/lib/model-download-resume.ts';

const identity = {
  url: 'https://models.example.invalid/model.bin',
  fileUri: 'file:///data/user/0/app/files/model.bin.download',
  expectedBytes: 1_600_000_000,
  sha256: 'a'.repeat(64),
};

test('resume state is bound to the exact immutable model identity', () => {
  const encoded = encodeModelDownloadResume(identity, 'opaque-native-resume-data');
  assert.equal(decodeModelDownloadResume(encoded, identity), 'opaque-native-resume-data');
  assert.equal(decodeModelDownloadResume(encoded, { ...identity, expectedBytes: identity.expectedBytes + 1 }), undefined);
  assert.equal(decodeModelDownloadResume(encoded, { ...identity, sha256: 'b'.repeat(64) }), undefined);
  assert.equal(decodeModelDownloadResume(`${encoded}\n`, identity), undefined);
});

test('invalid hashes including trailing newlines never enter persisted state', () => {
  assert.throws(
    () => encodeModelDownloadResume({ ...identity, sha256: `${'a'.repeat(64)}\n` }, 'resume'),
    /identity is invalid/,
  );
});

test('storage reservation credits only authenticated resumable partial bytes', () => {
  assert.equal(remainingModelDownloadBytes(1000, 400, true), 600);
  assert.equal(remainingModelDownloadBytes(1000, 400, false), 1000);
  assert.equal(remainingModelDownloadBytes(1000, 1000, true), 1000);
});

test('providers delegate transfer policy to the verified model download service', async () => {
  const [service, transcription, translation] = await Promise.all([
    readFile(new URL('../src/services/verified-model-download.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/transcription.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/caption-translation.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(service, /DownloadTask\.fromSavable/);
  assert.match(service, /verifySha256/);
  assert.match(service, /encodeModelDownloadResume/);
  assert.doesNotMatch(transcription, /File\.downloadFileAsync/);
  assert.doesNotMatch(translation, /File\.downloadFileAsync/);
  assert.match(transcription, /downloadVerifiedModel/);
  assert.match(translation, /resumableModelDownloadReservation/);
});
