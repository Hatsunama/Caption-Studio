import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  pin, assertApproval, assertUnsigned, assertDifferentPlayCertificate,
  assertMapping, assertProvenance,
} from '../scripts/verify-unsigned-play-aab.mjs';
import { createHash } from 'node:crypto';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const metadata = {
  schemaVersion: 1, repository: pin.repository, tag: pin.tag,
  sourceCommit: pin.sourceCommit, package: pin.package, version: pin.version,
  versionCode: pin.versionCode, signingCertificateSha256: pin.apkCertificateSha256,
  apk: { name: 'caption-studio-android.apk', sha256: pin.apkSha256 },
};
const bytes = Buffer.from(JSON.stringify(metadata));
const release = {
  draft: false, tag_name: pin.tag,
  assets: [
    { name: 'caption-studio-release.json', size: bytes.length, digest: 'sha256:' + sha(bytes) },
    { name: metadata.apk.name, size: 1, digest: 'sha256:' + pin.apkSha256 },
  ],
};
test('approval binds published manifest to exact tested APK, source, version and code', () => {
  const check = (m = metadata, r = release, b = bytes, c = pin.sourceCommit, t = pin.sourceTree) =>
    assertApproval(m, r, b, c, t);
  assert.equal(check(), sha(bytes));
  for (const key of ['repository', 'tag', 'sourceCommit', 'package', 'version', 'versionCode', 'signingCertificateSha256']) {
    assert.throws(() => check({ ...metadata, [key]: 'wrong' }));
  }
  assert.throws(() => check({ ...metadata, apk: { ...metadata.apk, sha256: 'a'.repeat(64) } }));
  assert.throws(() => check(metadata, { ...release, draft: true }));
  assert.throws(() => check(metadata, { ...release, assets: [] }));
  assert.throws(() => check(metadata, { ...release, assets: [...release.assets, release.assets[0]] }));
  assert.throws(() => check(metadata, release, Buffer.from('tampered')));
  assert.throws(() => check(metadata, release, bytes, 'a'.repeat(40)));
  assert.throws(() => check(metadata, release, bytes, pin.sourceCommit, 'a'.repeat(40)));
});
test('unsigned gate rejects signed, partially signed and ambiguous bundles', () => {
  const entries = ['base/manifest/AndroidManifest.xml', 'base/dex/classes.dex'];
  assert.doesNotThrow(() => assertUnsigned(entries, 'jar is unsigned.'));
  for (const name of ['META-INF/PLAY.SF', 'META-INF/APK.RSA', 'META-INF/X.DSA', 'META-INF/X.EC', 'meta-inf/sig-test']) {
    assert.throws(() => assertUnsigned([...entries, name], 'jar is unsigned.'));
  }
  assert.throws(() => assertUnsigned([...entries, entries[0]], 'jar is unsigned.'));
  assert.throws(() => assertUnsigned(entries, 'jar verified.'));
  assert.throws(() => assertUnsigned(entries, 'jar verified.\njar is unsigned.'));
  assert.throws(() => assertUnsigned(entries, 'jar is unsigned.', 'Name: base/dex/classes.dex\nSHA-256-Digest: abc'));
  assert.throws(() => assertUnsigned([], 'jar is unsigned.'));
});
test('local Play signing precondition explicitly refuses APK key', () => {
  assert.throws(() => assertDifferentPlayCertificate(pin.apkCertificateSha256), /Refusing APK signing key/);
  assert.throws(() => assertDifferentPlayCertificate(pin.apkCertificateSha256.match(/../g).join(':').toUpperCase()), /Refusing APK/);
  assert.equal(assertDifferentPlayCertificate('A'.repeat(64)), 'a'.repeat(64));
  assert.throws(() => assertDifferentPlayCertificate('unknown'));
});
test('mapping must match bundle bytes and cannot be empty', () => {
  const mapping = Buffer.from('R8 generated mapping');
  assert.equal(assertMapping(mapping, Buffer.from(mapping)), sha(mapping));
  assert.throws(() => assertMapping(mapping, Buffer.from('different')));
  assert.throws(() => assertMapping(Buffer.alloc(0), Buffer.alloc(0)));
});
test('unsigned provenance cannot claim signed or store-ready delivery', () => {
  const value = {
    schemaVersion: 1, repository: pin.repository, sourceCommit: pin.sourceCommit,
    sourceTree: pin.sourceTree, testedCommit: pin.testedCommit, integrationBaseCommit: pin.integrationBaseCommit, tag: pin.tag,
    package: pin.package, version: pin.version, versionCode: pin.versionCode,
    gateCommit: 'a'.repeat(40), runId: '1', runAttempt: '1',
    approvedApkSha256: pin.apkSha256, manifestSha256: 'b'.repeat(64),
    signing: { status: 'unsigned', privateKeyLocation: 'local-C-only', storeReady: false,
      certificateSha256: null, forbiddenCertificateSha256: pin.apkCertificateSha256 },
    checks: { bundletool: true, abi: true, elf16k: true, bundlePageAlignment: 'PAGE_ALIGNMENT_16K' },
    aab: { name: 'caption-studio-play-unsigned.aab', sha256: 'c'.repeat(64) },
    mapping: { name: 'caption-studio-play-mapping.txt', sha256: 'd'.repeat(64) },
  };
  assert.doesNotThrow(() => assertProvenance(value));
  for (const [name, changed] of [['status', 'signed'], ['privateKeyLocation', 'GitHub'],
    ['storeReady', true], ['certificateSha256', pin.apkCertificateSha256]]) {
    assert.throws(() => assertProvenance({ ...value, signing: { ...value.signing, [name]: changed } }));
  }
  assert.throws(() => assertProvenance({ ...value, sourceTree: 'e'.repeat(40) }));
  assert.throws(() => assertProvenance({ ...value, manifestSha256: '' }));
  assert.throws(() => assertProvenance({ ...value, aab: { ...value.aab, sha256: 'bad' } }));
  assert.throws(() => assertProvenance({ ...value, checks: { ...value.checks, elf16k: false } }));
});
test('cloud workflow has no signing secrets and applies unsigned init to every Gradle invocation', async () => {
  const workflow = await readFile(new URL('../.github/workflows/unsigned-play-aab.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /secrets\.|KEYSTORE_BASE64|gh release create|assembleRelease/);
  for (const line of workflow.split('\n').filter((line) => line.includes('./gradlew '))) {
    assert.match(line, /--init-script \.\.\/\.\.\/scripts\/unsigned-play-release\.gradle/);
  }
  for (const command of ['npm run verify:product-contract', 'npm audit', 'npm run test:logic',
    'npx tsc --noEmit', 'npm run lint', 'npx expo install --check', 'expo-doctor@1.20.4',
    'npm run verify:android-config', ':app:lintRelease', ':app:testReleaseUnitTest',
    ':caption-diagnostics:testReleaseUnitTest', ':caption-media:testReleaseUnitTest',
    ':caption-translation:testReleaseUnitTest', ':app:bundleRelease']) assert.ok(workflow.includes(command), command);
  assert.ok(workflow.indexOf('npm run test:logic') < workflow.indexOf(' --prepare release-source'));
});
