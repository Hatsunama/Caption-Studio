import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const pin = Object.freeze({
  repository: 'Hatsunama/Caption-Studio',
  tag: 'v1.4.124',
  sourceCommit: 'f2bade5f5bb03891cd197b58c80d8d091d0692d2',
  testedCommit: 'bdf7e94e6dada6433658029a2c684292ede9dd2d',
  sourceTree: '4445301fdb944720e333f61ed051c81790264357',
  package: 'com.xmilo_at_your_side.caption_studio',
  version: '1.4.124',
  versionCode: 136,
  apkSha256: '703629c169c739f0495215069aaa8bdce7793654d5c83358db7292663d84bd9a',
  apkCertificateSha256: 'd02d23b28cbc615e3686d181aedefbbe5de993a0b6ba3f8e4ea2b6160211b35f',
});
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mappingEntry = 'BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map';
const run = (program, args) => execFileSync(program, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const api = (endpoint) => JSON.parse(run('gh', ['api', 'repos/' + pin.repository + '/' + endpoint]));
const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');
async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function assertApproval(metadata, release, manifestBytes, sourceCommit, sourceTree) {
  assert.equal(release.draft, false, 'Release must be published');
  assert.equal(release.tag_name, pin.tag);
  assert.equal(sourceCommit, pin.sourceCommit, 'Unexpected release source commit');
  assert.equal(sourceTree, pin.sourceTree, 'Unexpected release source tree');
  assert.equal(metadata.schemaVersion, 1);
  for (const name of ['repository', 'tag', 'sourceCommit', 'package', 'version', 'versionCode']) {
    assert.equal(metadata[name], pin[name], 'Approval mismatch: ' + name);
  }
  assert.equal(metadata.signingCertificateSha256, pin.apkCertificateSha256, 'APK approval certificate mismatch');
  assert.equal(metadata.apk?.name, 'caption-studio-android.apk');
  assert.equal(metadata.apk?.sha256, pin.apkSha256, 'Approval must identify exact tested APK');
  for (const [name, sha] of [
    ['caption-studio-release.json', digest(manifestBytes)],
    ['caption-studio-android.apk', pin.apkSha256],
  ]) {
    const assets = release.assets.filter((asset) => asset.name === name);
    assert.equal(assets.length, 1, 'Exactly one published asset required: ' + name);
    assert.equal(assets[0].digest, 'sha256:' + sha, 'Published asset digest mismatch: ' + name);
    assert.ok(assets[0].size > 0);
    if (name.endsWith('.json')) assert.ok(assets[0].size <= 16384);
  }
  return digest(manifestBytes);
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

export function assertDifferentPlayCertificate(value) {
  const certificate = value.replaceAll(':', '').toLowerCase();
  assert.match(certificate, /^[0-9a-f]{64}$/);
  assert.notEqual(certificate, pin.apkCertificateSha256, 'Refusing APK signing key for Play');
  return certificate;
}

export function assertMapping(generated, embedded) {
  assert.ok(generated.length > 0, 'R8 mapping is empty');
  assert.deepEqual(embedded, generated, 'Embedded R8 mapping differs from build output');
  return digest(generated);
}

export function assertProvenance(value) {
  assert.equal(value.schemaVersion, 1);
  for (const name of ['repository', 'sourceCommit', 'sourceTree', 'testedCommit', 'tag', 'package', 'version', 'versionCode']) {
    assert.equal(value[name], pin[name], 'Provenance mismatch: ' + name);
  }
  assert.equal(value.signing.status, 'unsigned');
  assert.equal(value.signing.privateKeyLocation, 'local-C-only');
  assert.equal(value.signing.storeReady, false);
  assert.equal(value.signing.certificateSha256, null);
  assert.equal(value.signing.forbiddenCertificateSha256, pin.apkCertificateSha256);
  assert.equal(value.approvedApkSha256, pin.apkSha256);
  assert.match(value.manifestSha256, /^[0-9a-f]{64}$/);
  assert.match(value.gateCommit, /^[0-9a-f]{40}$/);
  assert.match(value.runId, /^[1-9]\d*$/);
  assert.match(value.runAttempt, /^[1-9]\d*$/);
  for (const name of ['aab', 'mapping']) assert.match(value[name].sha256, /^[0-9a-f]{64}$/);
  assert.equal(value.aab.name, 'caption-studio-play-unsigned.aab');
  assert.equal(value.mapping.name, 'caption-studio-play-mapping.txt');
  assert.equal(value.checks.bundletool, true);
  assert.equal(value.checks.abi, true);
  assert.equal(value.checks.elf16k, true);
  assert.equal(value.checks.bundlePageAlignment, 'PAGE_ALIGNMENT_16K');
}

function sourceIdentity(source) {
  const commit = run('git', ['-C', source, 'rev-parse', 'HEAD']).trim();
  const tree = run('git', ['-C', source, 'rev-parse', 'HEAD^{tree}']).trim();
  const refs = run('git', ['-C', source, 'ls-remote', 'origin', 'refs/tags/' + pin.tag, 'refs/tags/' + pin.tag + '^{}'])
    .trim().split(/\r?\n/).map((line) => line.split(/\s+/));
  assert.equal((refs.find(([, ref]) => ref.endsWith('^{}')) ?? refs.find(([, ref]) => ref === 'refs/tags/' + pin.tag))?.[0], commit, 'Release tag moved or absent');
  assert.equal(api('git/commits/' + pin.testedCommit).tree.sha, pin.sourceTree, 'Tested source tree differs');
  return { commit, tree };
}

async function publishedApproval(source) {
  assert.equal(process.env.GITHUB_REPOSITORY, pin.repository);
  const { commit, tree } = sourceIdentity(source);
  const release = api('releases/tags/' + pin.tag);
  const pages = JSON.parse(run('gh', ['api', '--paginate', '--slurp', 'repos/' + pin.repository + '/releases?per_page=100']));
  for (const candidate of pages.flat().filter((r) => !r.draft && r.assets.some((a) => a.name === 'caption-studio-android.apk'))) {
    assert.match(candidate.tag_name, /^v\d+\.\d+\.\d+$/);
    const parts = candidate.tag_name.slice(1).split('.').map(BigInt);
    const selected = pin.version.split('.').map(BigInt);
    const index = parts.findIndex((part, i) => part !== selected[i]);
    assert.ok(index === -1 || parts[index] < selected[index], 'A newer published APK exists');
  }
  const assets = release.assets.filter((a) => a.name === 'caption-studio-release.json');
  assert.equal(assets.length, 1, 'Published approval manifest is missing');
  assert.ok(assets[0].size > 0 && assets[0].size <= 16384);
  const bytes = execFileSync('gh', ['api', '-H', 'Accept: application/octet-stream',
    'repos/' + pin.repository + '/releases/assets/' + assets[0].id], { maxBuffer: 16384 });
  const metadata = JSON.parse(bytes.toString('utf8'));
  const manifestSha256 = assertApproval(metadata, release, bytes, commit, tree);
  return { ...metadata, sourceTree: tree, manifestSha256, releaseId: release.id, manifestAssetId: assets[0].id };
}

async function prepare(source) {
  const approval = await publishedApproval(source);
  const filename = path.join(source, 'app.json');
  const app = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(app.expo.android.package, pin.package);
  app.expo.version = approval.version;
  app.expo.android.versionCode = approval.versionCode;
  await writeFile(filename, JSON.stringify(app, null, 2) + '\n');
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await writeFile(path.join(root, 'dist/play-unsigned-approval.json'), JSON.stringify(approval, null, 2) + '\n', { flag: 'wx' });
}

async function verify(source, bundletool, objdump) {
  const approval = JSON.parse(await readFile(path.join(root, 'dist/play-unsigned-approval.json'), 'utf8'));
  assert.deepEqual(await publishedApproval(source), approval, 'Published approval changed during build');
  assert.equal(await hashFile(bundletool), 'a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29', 'bundletool pin mismatch');
  const bundle = path.join(source, 'android/app/build/outputs/bundle/release/app-release.aab');
  run('java', ['-jar', bundletool, 'validate', '--bundle=' + bundle]);
  const attribute = (name) => run('java', ['-jar', bundletool, 'dump', 'manifest', '--bundle=' + bundle, '--xpath=/manifest/@' + name]).trim();
  assert.equal(attribute('package'), pin.package);
  assert.equal(attribute('android:versionName'), pin.version);
  assert.equal(attribute('android:versionCode'), String(pin.versionCode));
  const targetSdk = run('java', ['-jar', bundletool, 'dump', 'manifest', '--bundle=' + bundle, '--xpath=/manifest/uses-sdk/@android:targetSdkVersion']).trim();
  assert.equal(targetSdk, '36');
  const config = run('java', ['-jar', bundletool, 'dump', 'config', '--bundle=' + bundle]);
  assert.match(config, /PAGE_ALIGNMENT_16K/, 'Bundle configuration must request 16KB APK page alignment');
  const entries = run('unzip', ['-Z', '-1', bundle]).split(/\r?\n/).filter(Boolean);
  const manifest = entries.includes('META-INF/MANIFEST.MF') ? run('unzip', ['-p', bundle, 'META-INF/MANIFEST.MF']) : '';
  assertUnsigned(entries, run('jarsigner', ['-verify', '-verbose', bundle]), manifest);
  run('node', [path.join(source, 'scripts/verify-android-abi.mjs'), '--aab', bundle]);
  // Reuse the existing ELF checker on the base-module native ZIP. AAB ZIP
  // offsets are not installed APK offsets; final APK zipalign is a local check.
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
    schemaVersion: 1,
    repository: pin.repository, tag: pin.tag, sourceCommit: pin.sourceCommit,
    sourceTree: pin.sourceTree, testedCommit: pin.testedCommit,
    gateCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    package: pin.package, version: pin.version, versionCode: pin.versionCode,
    approvedApkSha256: pin.apkSha256, manifestSha256: approval.manifestSha256,
    releaseId: approval.releaseId, manifestAssetId: approval.manifestAssetId,
    signing: {
      status: 'unsigned', certificateSha256: null, storeReady: false,
      privateKeyLocation: 'local-C-only', forbiddenCertificateSha256: pin.apkCertificateSha256,
      responsibility: 'Parent signs and verifies locally with a NEW Play key on C; never upload that key to GitHub.',
      remainingChecks: ['local Play certificate differs from APK pin', 'signed JAR integrity and signer certificate', 'generated APK ZIP 16KB alignment', 'Play Console validation'],
    },
    checks: { bundletool: true, abi: true, elf16k: true, bundlePageAlignment: 'PAGE_ALIGNMENT_16K' },
    aab: { name: aabName, sha256: aabSha256 },
    mapping: { name: mappingName, sha256: mappingSha256 },
  };
  assertProvenance(provenance);
  await writeFile(path.join(root, 'dist/play-unsigned-provenance.json'), JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx' });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--prepare' && args.length === 2) await prepare(path.resolve(args[1]));
  else if (args[0] === '--verify' && args.length === 4) await verify(path.resolve(args[1]), path.resolve(args[2]), path.resolve(args[3]));
  else throw new Error('Usage: verify-unsigned-play-aab.mjs --prepare SOURCE | --verify SOURCE BUNDLETOOL OBJDUMP');
}
