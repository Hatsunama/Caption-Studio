import assert from 'node:assert/strict';
import test from 'node:test';

const gate = await import(process.env.CAPTION_UNSIGNED_TEST_MODULE || '../scripts/verify-unsigned-play-aab.mjs');
const approval = {
  repository: 'Hatsunama/Caption-Studio',
  sourceCommit: '3ae54ddb3cf3253037a1c53aaf86177d09c7770a',
  sourceTree: '5d35cc33d91c1fce6b69abdc9b989ef226e5c616',
  package: 'com.xmilo_at_your_side.caption_studio',
  version: '1.4.133', versionCode: 145,
  approvalBasis: 'device-verified-apk-source',
  referenceApkRunId: '38778096566',
  referenceApkSha256: '9d33d15f317b0d44eedadb71f9fc45c726b61c1d6d6ec248f63659753489731d',
};
const provenance = {
  schemaVersion: 1, ...approval,
  gateCommit: 'a'.repeat(40), runId: '123', runAttempt: '1',
  signing: {
    status: 'unsigned', certificateSha256: null, storeReady: false,
    expectedLocalCertificateSha256: '50d77dfe5b3239d2fa86856613cb193898662a6a9dad2103812ea099ba102ddb',
    forbiddenCertificateSha256: 'd02d23b28cbc615e3686d181aedefbbe5de993a0b6ba3f8e4ea2b6160211b35f',
  },
  checks: { bundletool: true, abi: true, elf16k: true, bundlePageAlignment: 'PAGE_ALIGNMENT_16K', targetSdk: 36 },
  aab: { name: 'caption-studio-play-unsigned.aab', sha256: 'b'.repeat(64) },
  mapping: { name: 'caption-studio-play-mapping.txt', sha256: 'c'.repeat(64) },
};
test('device-verified 133/145 source approval is accepted', () => {
  assert.doesNotThrow(() => gate.assertSourceApproval(approval, approval.sourceCommit, approval.sourceTree));
});

test('device-verified 133/145 provenance is accepted as unsigned with distinct Play and APK certificates', () => {
  assert.doesNotThrow(() => gate.assertProvenance(provenance));
});

test('old 129/141 source and reference APK provenance are rejected', () => {
  const legacy = {
    ...provenance,
    sourceCommit: 'eea3fe3afdc1382be2ae1e8de2b7b53c2003f23b',
    sourceTree: '16d28ccf0b881f745617ed25a07383370de5af92',
    version: '1.4.129', versionCode: 141,
    approvalBasis: 'explicit-source-build-only',
    referenceApkRunId: '38149747095',
  };
  delete legacy.referenceApkSha256;
  assert.throws(() => gate.assertProvenance(legacy), /Source approval mismatch/);
});

test('old reference APK run is rejected independently of other source pins', () => {
  assert.throws(() => gate.assertProvenance({
    ...provenance, ...gate.pin, referenceApkRunId: '38149747095',
  }), /Source approval mismatch: referenceApkRunId/);
});

test('mismatched reference APK digest is rejected independently of other source pins', () => {
  assert.throws(() => gate.assertProvenance({
    ...provenance, ...gate.pin, referenceApkSha256: '0'.repeat(64),
  }), /Source approval mismatch: referenceApkSha256/);
});

test('missing reference APK digest is rejected independently of other source pins', () => {
  const missingDigest = { ...provenance, ...gate.pin };
  delete missingDigest.referenceApkSha256;
  assert.throws(() => gate.assertProvenance(missingDigest), /Source approval mismatch: referenceApkSha256/);
});

test('previous product source and cancelled reference run are rejected', () => {
  assert.throws(() => gate.assertProvenance({
    ...provenance,
    sourceCommit: '9f6f9d7b1a377a6df7e32d58b353183ba210a37e',
    sourceTree: 'ad9f915536f7415d61a3b41671783ee4de88092d',
    referenceApkRunId: '38138036253',
  }), /Source approval mismatch/);
});

test('signing credentials are rejected even when empty or exposed through Gradle', () => {
  for (const name of ['CAPTION_STUDIO_RELEASE_STORE_FILE',
    'ORG_GRADLE_PROJECT_CAPTION_STUDIO_PLAY_KEY_PASSWORD',
    'CAPTION_STUDIO_FIXED_KEYSTORE_BASE64', 'KEYSTORE_BASE64']) {
    assert.throws(() => gate.assertNoSigningInputs({ [name]: '' }), /refuses signing/);
  }
  assert.doesNotThrow(() => gate.assertNoSigningInputs({ NODE_ENV: 'production' }));
});

test('signed or duplicate bundle entries cannot be approved as unsigned', () => {
  const manifest = 'base/manifest/AndroidManifest.xml';
  assert.throws(() => gate.assertUnsigned([manifest, manifest], 'jar is unsigned'), /Duplicate/);
  assert.throws(() => gate.assertUnsigned([manifest, 'META-INF/UPLOAD.RSA'], 'jar is unsigned'), /signature material/);
  assert.throws(() => gate.assertUnsigned([manifest], 'jar verified.'), /must report unsigned/);
  assert.doesNotThrow(() => gate.assertUnsigned([manifest], 'jar is unsigned'));
});

test('APK certificate and premature store-ready claims are rejected for Play provenance', () => {
  assert.throws(() => gate.assertProvenance({ ...provenance, signing: {
    ...provenance.signing,
    expectedLocalCertificateSha256: provenance.signing.forbiddenCertificateSha256,
  } }));
  assert.throws(() => gate.assertProvenance({ ...provenance, signing: {
    ...provenance.signing, storeReady: true,
  } }));
});

test('mapping verifier rejects missing or mismatched release mappings', () => {
  assert.throws(() => gate.assertMapping(Buffer.alloc(0), Buffer.alloc(0)), /empty/);
  assert.throws(() => gate.assertMapping(Buffer.from('correct mapping'), Buffer.from('other mapping')), /differs/);
  assert.match(gate.assertMapping(Buffer.from('mapping'), Buffer.from('mapping')), /^[0-9a-f]{64}$/);
});
