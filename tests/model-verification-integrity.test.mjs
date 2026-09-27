import assert from 'node:assert/strict';
import test from 'node:test';

import {
  encodeModelVerificationMarker,
  modelVerificationMarkerIdentityMatches,
  modelVerificationMarkerMatches,
} from '../src/lib/model-verification.ts';

test('a matching sidecar cannot verify model bytes without a current digest', () => {
  const expectedSha256 = 'a'.repeat(64);
  const identity = {
    fileName: 'speech-model.bin',
    sizeBytes: 1024,
    modifiedAtMs: 123456,
    createdAtMs: 120000,
  };
  const marker = encodeModelVerificationMarker(identity, expectedSha256);
  assert.ok(marker);
  assert.equal(modelVerificationMarkerMatches(marker, identity, expectedSha256), false);
  assert.equal(modelVerificationMarkerMatches(marker, identity, expectedSha256, 'b'.repeat(64)), false);
  assert.equal(modelVerificationMarkerMatches(marker, identity, expectedSha256, expectedSha256), true);
  assert.equal(modelVerificationMarkerIdentityMatches(marker, identity, expectedSha256), true);
});
