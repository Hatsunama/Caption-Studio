import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { checkInputs, parseCertificate, validateApproval, configureApprovedApp } from '../scripts/verify-play-aab.mjs';

const workflowUrl = new URL('../.github/workflows/verify-play-aab.yml', import.meta.url);
const app = JSON.parse(await readFile(new URL('../app.json', import.meta.url), 'utf8'));
const version = app.expo.version;
const versionCode = String(app.expo.android.versionCode);

test('approved release identity can override stale source app.json before building', () => {
  const tag = 'v1.4.105';
  const sourceCommit = 'a'.repeat(40);
  const metadata = {
    schemaVersion: 1,
    repository: 'Hatsunama/Caption-Studio',
    tag,
    sourceCommit,
    package: 'com.xmilo_at_your_side.caption_studio',
    version: '1.4.105',
    versionCode: 117,
    signingCertificateSha256: 'd02d23b28cbc615e3686d181aedefbbe5de993a0b6ba3f8e4ea2b6160211b35f',
    apk: { name: 'caption-studio-android.apk', sha256: 'b'.repeat(64) },
  };
  assert.deepEqual(validateApproval(metadata, tag, sourceCommit, '117'), { version: '1.4.105', versionCode: 117 });
  const configured = configureApprovedApp(app, metadata);
  assert.equal(configured.expo.version, '1.4.105');
  assert.equal(configured.expo.android.versionCode, 117);
  assert.throws(() => validateApproval(metadata, tag, 'c'.repeat(40)), /commit/);
  assert.throws(() => validateApproval({ ...metadata, versionCode: 116 }, tag, sourceCommit, '117'), /versionCode/);
});

test('a manual production-signed Play AAB gate retains only a verified bundle', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /ref: \$\{\{ inputs\.tag \}\}/);
  assert.match(workflow, /--prepare "\$TAG" "\$VERSION_CODE" release-source/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /CAPTION_STUDIO_FIXED_KEYSTORE_BASE64/);
  assert.match(workflow, /CAPTION_STUDIO_FIXED_STORE_PASSWORD/);
  assert.match(workflow, /CAPTION_STUDIO_FIXED_KEY_ALIAS/);
  assert.match(workflow, /CAPTION_STUDIO_FIXED_KEY_PASSWORD/);
  assert.match(workflow, /:app:bundleRelease/);
  assert.match(workflow, /verify-play-aab\.mjs/);
  assert.match(workflow, /actions\/upload-artifact@/);
  assert.match(workflow, /release-source\/android/);
  assert.match(workflow, /dist\/caption-studio-play\.aab/);
  assert.match(workflow, /dist\/play-aab-provenance\.json/);
  assert.doesNotMatch(workflow, /gh release create|gradlew :app:assembleRelease|play-store|playstore|publish-sidecar/i);
});

test('Play gate rejects version inputs that do not match the checkout', () => {
  assert.doesNotThrow(() => checkInputs(version, versionCode));
  assert.throws(() => checkInputs('999.0.0', versionCode), /version must equal configured app.json/);
  assert.throws(() => checkInputs(version, String(Number(versionCode) + 1)), /versionCode must equal configured app.json/);
  assert.throws(() => checkInputs(version, `0${versionCode}`));
});

test('Play gate requires the pinned production signer certificate', () => {
  const valid = 'SHA256: D0:2D:23:B2:8C:BC:61:5E:36:86:D1:81:AE:DE:FB:BE:5D:E9:93:A0:B6:BA:3F:8E:4E:A2:B6:16:02:11:B3:5F';
  assert.equal(parseCertificate(valid), 'd02d23b28cbc615e3686d181aedefbbe5de993a0b6ba3f8e4ea2b6160211b35f');
  assert.throws(() => parseCertificate(valid.replace('D0:2D', '00:00')), /production pin/);
  assert.throws(() => parseCertificate(`${valid}\n${valid}`), /exactly one signer/);
});

test('public repository workflow artifacts are not described as private', async () => {
  const guide = await readFile(new URL('../docs/play-aab-release-gate.md', import.meta.url), 'utf8');
  assert.doesNotMatch(guide, /private GitHub Actions artifact/i);
  assert.match(guide, /read access/i);
});

test('Play source version override occurs after source-contract tests and before Android prebuild', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const sourceChecks = workflow.indexOf('npm run test:logic');
  const approvedOverride = workflow.indexOf('verify-play-aab.mjs --prepare');
  const prebuild = workflow.indexOf('npx expo prebuild');
  assert.ok(sourceChecks >= 0 && sourceChecks < approvedOverride && approvedOverride < prebuild);
});
