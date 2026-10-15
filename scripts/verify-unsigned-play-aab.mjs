import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureSidecarApp } from './configure-sidecar-release.mjs';
import { assertAndroidAbiCoverage } from './verify-android-abi.mjs';

export const pin = Object.freeze({
  repository: 'Hatsunama/Caption-Studio',
  sourceCommit: '67c0917d8b0922aac22b3f6a7a0c633677915b36',
  sourceTree: '90160ababb9d8df10bc07edab19886c27858f034',
  package: 'com.xmilo_at_your_side.caption_studio',
  version: '1.4.132', versionCode: 144,
  approvalBasis: 'device-verified-apk-source',
  referenceApkRunId: '38754384418',
  referenceApkSha256: 'e12f2caa6b95cae973ccaef06b435a432617add693baef7fb009c0f915586ffd',
});
const playCertificate = '50d77dfe5b3239d2fa86856613cb193898662a6a9dad2103812ea099ba102ddb';
const apkCertificate = 'd02d23b28cbc615e3686d181aedefbbe5de993a0b6ba3f8e4ea2b6160211b35f';
const bundletoolSha256 = 'a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mappingEntry = 'BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map';
const run = (program, args) => execFileSync(program, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function assertNoSigningInputs(environment = process.env) {
  for (const name of Object.keys(environment)) {
    assert.doesNotMatch(name, /^(?:ORG_GRADLE_PROJECT_)?CAPTION_STUDIO_(?:RELEASE|FIXED|PLAY)_(?:STORE_FILE|STORE_PASSWORD|KEY_ALIAS|KEY_PASSWORD|KEYSTORE_BASE64)$|^(?:KEYSTORE_BASE64|STORE_PASSWORD|KEY_ALIAS|KEY_PASSWORD)$/i,
      'Unsigned packaging refuses signing credential input');
  }
}

export function assertSourceApproval(value, commit, tree) {
  for (const name of Object.keys(pin)) assert.equal(value[name], pin[name], 'Source approval mismatch: ' + name);
  assert.equal(commit, pin.sourceCommit, 'Unexpected source commit');
  assert.equal(tree, pin.sourceTree, 'Unexpected source tree');
}

export function configureApprovedApp(config) {
  assert.equal(config?.expo?.android?.package, pin.package, 'Unexpected source package');
  // Use the same configuration transformation as the reference APK workflow.
  return configureSidecarApp(config, pin.version, pin.versionCode);
}

export function assertUnsigned(entries, jarsignerOutput, jarManifest = '') {
  assert.equal(new Set(entries).size, entries.length, 'Duplicate AAB entries');
  assert.ok(entries.includes('base/manifest/AndroidManifest.xml'), 'Missing base manifest');
  for (const entry of entries) {
    assert.doesNotMatch(entry, /^META-INF\/(?:[^/]+\.(?:SF|RSA|DSA|EC)|SIG-[^/]+)$/i, 'AAB contains signature material');
  }
  assert.doesNotMatch(jarManifest, /(?:^|\r?\n)[^\r\n:]*-Digest(?:-Manifest(?:-Main-Attributes)?)?:/i, 'AAB contains JAR signing digests');
  assert.match(jarsignerOutput, /jar is unsigned/i, 'jarsigner must report unsigned bundle');
  assert.doesNotMatch(jarsignerOutput, /jar verified\./i, 'AAB is already signed');
}

export function verifyUnsignedArchive(bundle) {
  const entries = run('unzip', ['-Z', '-1', bundle]).split(/\r?\n/).filter(Boolean);
  const manifest = entries.includes('META-INF/MANIFEST.MF') ? run('unzip', ['-p', bundle, 'META-INF/MANIFEST.MF']) : '';
  assertUnsigned(entries, run('jarsigner', ['-verify', '-verbose', bundle]), manifest);
  return entries;
}

export function assertMapping(generated, embedded) {
  assert.ok(generated.length > 0, 'R8 mapping is empty');
  assert.deepEqual(embedded, generated, 'Embedded R8 mapping differs from build output');
  return digest(generated);
}

export function assertBundleIdentity(identity, config) {
  assert.equal(identity.package, pin.package, 'AAB package mismatch');
  assert.equal(identity.version, pin.version, 'AAB version mismatch');
  assert.equal(identity.versionCode, String(pin.versionCode), 'AAB versionCode mismatch');
  assert.equal(identity.targetSdk, '36', 'AAB target SDK mismatch');
  const value = JSON.parse(config);
  assert.equal(value.optimizations?.uncompressNativeLibraries?.alignment, 'PAGE_ALIGNMENT_16K', 'Bundle must request 16KB APK page alignment');
}

export function assertProvenance(value) {
  assertSourceApproval(value, value.sourceCommit, value.sourceTree);
  assert.equal(value.schemaVersion, 1);
  assert.match(value.gateCommit ?? '', /^[0-9a-f]{40}$/);
  assert.match(value.runId ?? '', /^[1-9]\d*$/);
  assert.match(value.runAttempt ?? '', /^[1-9]\d*$/);
  assert.deepEqual(value.signing, {
    status: 'unsigned', certificateSha256: null, storeReady: false,
    expectedLocalCertificateSha256: playCertificate, forbiddenCertificateSha256: apkCertificate,
  });
  assert.deepEqual(value.checks, { bundletool: true, abi: true, elf16k: true, bundlePageAlignment: 'PAGE_ALIGNMENT_16K', targetSdk: 36 });
  for (const name of ['aab', 'mapping']) assert.match(value[name]?.sha256 ?? '', /^[0-9a-f]{64}$/);
  assert.equal(value.aab.name, 'caption-studio-play-unsigned.aab');
  assert.equal(value.mapping.name, 'caption-studio-play-mapping.txt');
}

function sourceIdentity(source, configured) {
  assertNoSigningInputs();
  assert.equal(process.env.GITHUB_REPOSITORY, pin.repository);
  assert.match(process.env.GITHUB_SHA ?? '', /^[0-9a-f]{40}$/);
  const commit = run('git', ['-C', source, 'rev-parse', 'HEAD']).trim();
  const tree = run('git', ['-C', source, 'rev-parse', 'HEAD^{tree}']).trim();
  assertSourceApproval(pin, commit, tree);
  const original = JSON.parse(run('git', ['-C', source, 'show', 'HEAD:app.json']));
  const changes = run('git', ['-C', source, 'diff', '--name-only', 'HEAD']).trim().split(/\r?\n/).filter(Boolean);
  assert.ok(changes.every((name) => configured && name === 'app.json'), 'Tracked source changed outside approved configuration stamp');
  return { original, commit, tree };
}

async function prepare(source) {
  const { original } = sourceIdentity(source, false);
  await writeFile(path.join(source, 'app.json'), JSON.stringify(configureApprovedApp(original), null, 2) + '\n');
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await writeFile(path.join(root, 'dist/play-unsigned-approval.json'), JSON.stringify(pin, null, 2) + '\n', { flag: 'wx' });
}

async function verify(source, bundletool, objdump) {
  const { original, commit, tree } = sourceIdentity(source, true);
  const approval = JSON.parse(await readFile(path.join(root, 'dist/play-unsigned-approval.json'), 'utf8'));
  assertSourceApproval(approval, commit, tree);
  assert.deepEqual(JSON.parse(await readFile(path.join(source, 'app.json'), 'utf8')), configureApprovedApp(original), 'Configuration stamp changed during build');
  assert.equal(await hashFile(bundletool), bundletoolSha256, 'bundletool pin mismatch');
  const bundle = path.join(source, 'android/app/build/outputs/bundle/release/app-release.aab');
  run('java', ['-jar', bundletool, 'validate', '--bundle=' + bundle]);
  const attribute = (xpath) => run('java', ['-jar', bundletool, 'dump', 'manifest', '--bundle=' + bundle, '--xpath=' + xpath]).trim();
  assertBundleIdentity({
    package: attribute('/manifest/@package'), version: attribute('/manifest/@android:versionName'),
    versionCode: attribute('/manifest/@android:versionCode'), targetSdk: attribute('/manifest/uses-sdk/@android:targetSdkVersion'),
  }, run('java', ['-jar', bundletool, 'dump', 'config', '--bundle=' + bundle]));
  const entries = verifyUnsignedArchive(bundle);
  assertAndroidAbiCoverage(entries, 'base');
  // ELF alignment is checked on native bytes; installed APK ZIP offsets require
  // a later local signed-APK zipalign check and are not claimed here.
  const nativeZip = path.join(root, 'dist/play-native-check.zip');
  const python = "import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as src, zipfile.ZipFile(sys.argv[2], 'w') as dst:\n for n in src.namelist():\n  if n.startswith('base/lib/') and n.endswith('.so'): dst.writestr(n[5:], src.read(n))\n";
  run('python3', ['-c', python, bundle, nativeZip]);
  run('bash', [path.join(source, 'scripts/check-elf-16k-alignment.sh'), nativeZip, objdump]);
  const mappingFile = path.join(source, 'android/app/build/outputs/mapping/release/mapping.txt');
  assert.ok(entries.includes(mappingEntry), 'AAB is missing R8 mapping');
  const generated = await readFile(mappingFile);
  const embedded = execFileSync('unzip', ['-p', bundle, mappingEntry], { maxBuffer: 128 * 1024 * 1024 });
  const mappingSha256 = assertMapping(generated, embedded);
  const aabName = 'caption-studio-play-unsigned.aab';
  const mappingName = 'caption-studio-play-mapping.txt';
  await copyFile(bundle, path.join(root, 'dist', aabName));
  await copyFile(mappingFile, path.join(root, 'dist', mappingName));
  const aabSha256 = await hashFile(bundle);
  assert.equal(await hashFile(path.join(root, 'dist', aabName)), aabSha256);
  assert.equal(await hashFile(path.join(root, 'dist', mappingName)), mappingSha256);
  const provenance = {
    schemaVersion: 1, ...pin, gateCommit: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    signing: { status: 'unsigned', certificateSha256: null, storeReady: false,
      expectedLocalCertificateSha256: playCertificate, forbiddenCertificateSha256: apkCertificate },
    checks: { bundletool: true, abi: true, elf16k: true, bundlePageAlignment: 'PAGE_ALIGNMENT_16K', targetSdk: 36 },
    aab: { name: aabName, sha256: aabSha256 }, mapping: { name: mappingName, sha256: mappingSha256 },
  };
  assertProvenance(provenance);
  await writeFile(path.join(root, 'dist/play-unsigned-provenance.json'), JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx' });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--approve' && args.length === 2) sourceIdentity(path.resolve(args[1]), false);
  else if (args[0] === '--prepare' && args.length === 2) await prepare(path.resolve(args[1]));
  else if (args[0] === '--verify' && args.length === 4) await verify(path.resolve(args[1]), path.resolve(args[2]), path.resolve(args[3]));
  else throw new Error('Usage: --approve SOURCE | --prepare SOURCE | --verify SOURCE BUNDLETOOL OBJDUMP');
}
