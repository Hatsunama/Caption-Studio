// Retired cloud CLI. Exports below describe historical D02 releases only.
// Future Play AAB authority is the distinct 50D role in local-signing-contract.json.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.error('RETIRED: use .github/workflows/unsigned-store-build.yml then scripts/local-signing/sign-release.ps1. Historical D02 helpers do not authorize new Play signing.');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(await readFile(path.join(root, 'config/product-contract.json'), 'utf8'));
const app = JSON.parse(await readFile(path.join(root, 'app.json'), 'utf8'));
const expectedPackage = 'com.xmilo_at_your_side.caption_studio';
const mappingEntry = 'BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map';

export function assertPlayBundleMapping(entries, generated, embedded) {
  assert.ok(entries.includes(mappingEntry), 'Play AAB is missing its R8 mapping');
  assert.ok(generated.length > 0, 'Generated R8 mapping is missing or empty');
  assert.deepEqual(embedded, generated, 'Play AAB R8 mapping differs from the generated mapping');
  return createHash('sha256').update(generated).digest('hex');
}

export function checkInputs(version, rawVersionCode, config = app) {
  assert.equal(contract.android.sourcePackage, expectedPackage);
  assert.equal(contract.android.release.package, expectedPackage);
  assert.equal(config.expo.android.package, expectedPackage);
  assert.match(version ?? '', /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.match(rawVersionCode ?? '', /^[1-9]\d*$/);
  assert.equal(version, config.expo.version, 'version must equal configured app.json');
  assert.equal(Number(rawVersionCode), config.expo.android.versionCode, 'versionCode must equal configured app.json');
}

export function validateApproval(metadata, tag, sourceCommit, rawVersionCode = String(metadata?.versionCode)) {
  assert.match(tag ?? '', /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.match(sourceCommit ?? '', /^[0-9a-f]{40}$/);
  assert.equal(metadata?.schemaVersion, 1);
  assert.equal(metadata.repository, contract.repository);
  assert.equal(metadata.tag, tag);
  assert.equal(metadata.sourceCommit, sourceCommit, 'approved release commit differs from tag checkout');
  assert.equal(metadata.package, expectedPackage);
  assert.equal(metadata.version, tag.slice(1));
  assert.ok(Number.isSafeInteger(metadata.versionCode) && metadata.versionCode > 0 && metadata.versionCode <= 2100000000);
  assert.match(rawVersionCode ?? '', /^[1-9]\d*$/);
  assert.equal(metadata.versionCode, Number(rawVersionCode), 'approved release versionCode differs from dispatch input');
  assert.equal(metadata.signingCertificateSha256, contract.android.release.signingCertificateSha256);
  assert.equal(metadata.apk?.name, contract.android.release.assetName);
  assert.match(metadata.apk?.sha256 ?? '', /^[0-9a-f]{64}$/);
  return { version: metadata.version, versionCode: metadata.versionCode };
}

export function configureApprovedApp(config, metadata) {
  assert.equal(config?.expo?.android?.package, expectedPackage);
  return {
    ...config,
    expo: {
      ...config.expo,
      version: metadata.version,
      android: { ...config.expo.android, versionCode: metadata.versionCode },
    },
  };
}

export function parseCertificate(output) {
  const fingerprints = [...output.matchAll(/^\s*SHA256:\s*([\dA-Fa-f:]{64,95})\s*$/gm)];
  assert.equal(fingerprints.length, 1, 'AAB must have exactly one signer certificate');
  const actual = fingerprints[0][1].replaceAll(':', '').toLowerCase();
  assert.match(actual, /^[0-9a-f]{64}$/);
  assert.equal(actual, contract.android.release.signingCertificateSha256, 'AAB signer certificate differs from production pin');
  assert.doesNotMatch(output, /Android Debug|androiddebugkey|Caption Studio CI/i);
  return actual;
}
