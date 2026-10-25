import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { copyFile, link, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureSidecarApp } from './configure-sidecar-release.mjs';
import { assertNoSigningInputs, assertUnsigned, assertMapping } from './verify-unsigned-play-aab.mjs';
import { assertAndroidAbiCoverage } from './verify-android-abi.mjs';

export const mappingEntry = 'BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map';
export const bundletoolSha256 = 'a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29';
const repository = 'Hatsunama/Caption-Studio';
const workflowRef = `${repository}/.github/workflows/unsigned-store-build.yml@refs/heads/main`;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const command = (program, args, binary = false) => execFileSync(program, args, {
  encoding: binary ? undefined : 'utf8', maxBuffer: 128 * 1024 * 1024,
});
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function parseRelease(version, rawCode, original) {
  assert.equal(typeof rawCode, 'string');
  assert.match(rawCode, /^[1-9][0-9]*$/, 'versionCode must be canonical');
  const versionCode = Number(rawCode);
  // All version ranges, canonical version rules, package identity and stamping
  // belong to the shared release contract, not the old frozen AAB pin.
  const configured = configureSidecarApp(original, version, versionCode);
  return { version, versionCode, package: configured.expo.android.package, configured };
}

export function assertContext(env = process.env) {
  assertNoSigningInputs(env);
  for (const [name, value] of Object.entries({
    GITHUB_REPOSITORY: repository, GITHUB_REPOSITORY_OWNER: 'Hatsunama',
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_ACTOR: 'Hatsunama', GITHUB_TRIGGERING_ACTOR: 'Hatsunama', GITHUB_WORKFLOW_REF: workflowRef,
  })) assert.equal(env[name], value, `Unauthorized ${name}`);
  assert.match(env.GITHUB_SHA ?? '', /^[0-9a-f]{40}$/);
  for (const name of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) assert.match(env[name] ?? '', /^[1-9][0-9]*$/);
}

export async function inspectSource(source, release, stamped, env = process.env) {
  assertContext(env);
  const git = (...args) => command('git', ['-C', source, ...args]).trim();
  const sourceCommit = git('rev-parse', 'HEAD');
  const sourceTree = git('rev-parse', 'HEAD^{tree}');
  assert.equal(sourceCommit, env.GITHUB_SHA, 'Source HEAD must equal dispatched GITHUB_SHA');
  assert.match(sourceTree, /^[0-9a-f]{40}$/);
  const original = JSON.parse(git('show', 'HEAD:app.json'));
  const expected = parseRelease(release.version, String(release.versionCode), original);
  assert.deepEqual(release, expected, 'Release must derive from authoritative source configuration');
  const changed = git('diff', '--name-only', 'HEAD', '--').split(/\r?\n/).filter(Boolean);
  assert.ok(changed.every((name) => stamped && name === 'app.json'), 'Tracked source changed outside version stamp');
  assert.deepEqual(JSON.parse(await readFile(path.join(source, 'app.json'), 'utf8')),
    stamped ? expected.configured : original, 'Authoritative app configuration/stamp mismatch');
  return { sourceCommit, sourceTree };
}

function assertArchive(entries, jarOutput, manifest, format) {
  assert.ok(Array.isArray(entries));
  for (const name of entries) {
    assert.doesNotMatch(name, /(?:^\/|\\|(?:^|\/)\.\.(?:\/|$)|[\x00-\x1f])/, 'Unsafe archive path');
  }
  if (format === 'apk') {
    assert.ok(entries.includes('AndroidManifest.xml'), 'Missing APK manifest');
    assert.ok(!entries.includes('base/manifest/AndroidManifest.xml'), 'Unexpected APK bundle manifest');
  }
  // The shared signature and digest rules are archive-independent; adapt only
  // its AAB-specific manifest name for the APK container.
  assertUnsigned(format === 'apk' ? entries.map((name) => name === 'AndroidManifest.xml'
    ? 'base/manifest/AndroidManifest.xml' : name) : entries, jarOutput, manifest);
  assertAndroidAbiCoverage(entries, format);
}

export function assertPayload(evidence, release) {
  for (const format of ['apk', 'aab']) {
    assert.deepEqual(evidence[`${format}Identity`], { package: release.package, version: release.version,
      versionCode: String(release.versionCode), minSdk: '24', targetSdk: '36' }, `${format} identity mismatch`);
    assertArchive(evidence[`${format}Entries`], evidence[`${format}Jar`], evidence[`${format}Manifest`],
      format === 'apk' ? 'apk' : 'base');
  }
  assert.equal(evidence.apkSigningBlock, false, 'APK contains a signing block');
  assert.equal(evidence.bundleConfig?.optimizations?.uncompressNativeLibraries?.alignment,
    'PAGE_ALIGNMENT_16K', 'Bundle page alignment mismatch');
  for (const name of ['bundletool', 'zipalign16k', 'apkElf16k', 'aabElf16k'])
    assert.equal(evidence[name], true, `Missing successful ${name} check`);
  assert.ok(evidence.aabEntries.includes(mappingEntry), 'Missing embedded R8 mapping');
  for (const key of ['apk', 'aab', 'mapping'])
    assert.match(evidence.payloadHashes?.[key] ?? '', /^[0-9a-f]{64}$/, `Missing verified ${key} hash`);
  const mappingSha = assertMapping(evidence.generatedMapping, evidence.embeddedMapping);
  assert.equal(evidence.payloadHashes.mapping, mappingSha, 'Mapping changed during verification');
  return mappingSha;
}

export async function publishVerified(input, { copy = copyFile } = {}) {
  const { release, source, context, evidence, files } = input;
  assertContext(context);
  assert.equal(source.sourceCommit, context.GITHUB_SHA);
  assert.match(source.sourceTree ?? '', /^[0-9a-f]{40}$/);
  const mappingSha = assertPayload(evidence, release);
  const payloads = {};
  const names = { apk: 'caption-studio-UNSIGNED-not-installable.apk',
    aab: 'caption-studio-UNSIGNED-not-installable.aab', mapping: 'mapping.txt' };
  for (const [key, name] of Object.entries(names)) {
    const info = await stat(files[key]);
    assert.ok(info.isFile() && info.size > 0, `Missing ${key} payload`);
    payloads[key] = { name, bytes: info.size, sha256: await hashFile(files[key]) };
    assert.equal(payloads[key].sha256, evidence.payloadHashes[key], `${key} changed after verification`);
  }
  assert.equal(payloads.mapping.sha256, mappingSha, 'Output mapping differs from verified embedded mapping');
  const output = path.resolve(input.output);
  // Exclusive directory reservation: even an existing empty output is refused.
  // Each file is published atomically with an exclusive hard link. Provenance
  // is the final commit marker; failures remove only this invocation's directory.
  await mkdir(output);
  const pending = path.join(output, '.pending');
  try {
    await mkdir(pending);
    for (const [key, payload] of Object.entries(payloads)) {
      const target = path.join(pending, payload.name);
      await copy(files[key], target, constants.COPYFILE_EXCL);
      assert.equal(await hashFile(target), payload.sha256, 'Copied payload hash mismatch');
      assert.equal((await stat(target)).size, payload.bytes, 'Copied payload size mismatch');
      assert.equal(await hashFile(files[key]), payload.sha256, 'Source payload changed during copy');
      await link(target, path.join(output, payload.name));
    }
    const provenance = { schemaVersion: 1, repository, ...source,
      version: release.version, versionCode: release.versionCode, package: release.package,
      runId: context.GITHUB_RUN_ID, runAttempt: context.GITHUB_RUN_ATTEMPT,
      workflowRef, sourceRef: context.GITHUB_REF,
      signing: { status: 'unsigned', certificateSha256: null, storeReady: false, installable: false },
      checks: { bundletoolVersion: '1.18.3', bundletoolSha256, minSdk: 24, targetSdk: 36,
        abi: true, translation64BitOnly: true, apkZipalign16k: true, apkElf16k: true, aabElf16k: true,
        bundlePageAlignment: 'PAGE_ALIGNMENT_16K', unsignedArchives: true, exactEmbeddedMapping: true },
      payloads };
    const staged = path.join(pending, 'provenance.json');
    await writeFile(staged, JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx' });
    for (const payload of Object.values(payloads))
      assert.equal(await hashFile(path.join(output, payload.name)), payload.sha256, 'Published payload hash mismatch');
    await link(staged, path.join(output, 'provenance.json'));
    // Nothing fallible after the successful commit marker affects success.
    await rm(pending, { recursive: true, force: true }).catch(() => {});
    return provenance;
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

// Parse the ZIP central directory, reject symlinks, and inspect the precise APK
// signing-block location (v2/v3 signatures are not META-INF JAR entries).
const zipInspection = `import sys,zipfile
f=sys.argv[1]
with zipfile.ZipFile(f) as z:
 for i in z.infolist():
  if (i.external_attr >> 16) & 0o170000 == 0o120000: raise ValueError('ZIP symlink')
 cd=z.start_dir
with open(f,'rb') as s:
 if cd>=16:
  s.seek(cd-16)
  signed=s.read(16)==b'APK Sig Block 42'
 else: signed=False
print('signed' if signed else 'unsigned')
`;

export function inspectZip(file, run = command) {
  const block = run('python3', ['-c', zipInspection, file]).trim();
  assert.ok(block === 'signed' || block === 'unsigned', 'Missing ZIP inspection result');
  return block === 'signed';
}

export async function collectEvidence(options, run = command) {
  const { bundletool } = options;
  assert.equal(await hashFile(bundletool), bundletoolSha256, 'bundletool checksum mismatch');
  return inspectPayloads(options, run);
}

// Tool adapter is separately executable with synthetic fixtures. The CLI always
// enters through collectEvidence, which first verifies the actual JAR checksum.
export async function inspectPayloads({ source, files, bundletool, objdump, buildTools, temporary }, run = command) {
  const e = {};
  e.payloadHashes = {};
  for (const key of ['apk', 'aab', 'mapping']) e.payloadHashes[key] = await hashFile(files[key]);
  for (const format of ['apk', 'aab']) {
    const file = files[format];
    const signed = inspectZip(file, run);
    if (format === 'apk') e.apkSigningBlock = signed;
    else assert.equal(signed, false, 'Unexpected AAB signing block');
    const listing = run('unzip', ['-Z', '-1', file]);
    e[`${format}Entries`] = listing.split(/\r?\n/).filter(Boolean);
    e[`${format}Manifest`] = e[`${format}Entries`].includes('META-INF/MANIFEST.MF')
      ? run('unzip', ['-p', file, 'META-INF/MANIFEST.MF']) : '';
    e[`${format}Jar`] = run('jarsigner', ['-verify', '-verbose', file]);
    // Refuse unsafe paths before the existing ELF checker extracts archives.
    assertArchive(e[`${format}Entries`], e[`${format}Jar`], e[`${format}Manifest`], format === 'apk' ? 'apk' : 'base');
  }
  const badging = run(path.join(buildTools, 'aapt'), ['dump', 'badging', files.apk]);
  const apk = /^package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']+)'/m.exec(badging);
  assert.ok(apk, 'Missing APK package identity');
  e.apkIdentity = { package: apk[1], versionCode: apk[2], version: apk[3],
    minSdk: /^sdkVersion:'([0-9]+)'/m.exec(badging)?.[1],
    targetSdk: /^targetSdkVersion:'([0-9]+)'/m.exec(badging)?.[1] };
  run(path.join(buildTools, 'zipalign'), ['-c', '-P', '16', '-v', '4', files.apk]);
  e.zipalign16k = true;
  run('java', ['-jar', bundletool, 'validate', '--bundle=' + files.aab]);
  e.bundletool = true;
  const attribute = (xpath) => run('java', ['-jar', bundletool, 'dump', 'manifest', '--bundle=' + files.aab, '--xpath=' + xpath]).trim();
  e.aabIdentity = Object.fromEntries(Object.entries({ package: '/manifest/@package', version: '/manifest/@android:versionName',
    versionCode: '/manifest/@android:versionCode', minSdk: '/manifest/uses-sdk/@android:minSdkVersion',
    targetSdk: '/manifest/uses-sdk/@android:targetSdkVersion' }).map(([key, xpath]) => [key, attribute(xpath)]));
  e.bundleConfig = JSON.parse(run('java', ['-jar', bundletool, 'dump', 'config', '--bundle=' + files.aab]));
  run('bash', [path.join(source, 'scripts/check-elf-16k-alignment.sh'), files.apk, objdump]);
  e.apkElf16k = true;
  const nativeZip = path.join(temporary, 'aab-native.zip');
  run('python3', ['-c', `import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as src, zipfile.ZipFile(sys.argv[2], 'x') as dst:
 for n in src.namelist():
  if n.startswith('base/lib/') and n.endswith('.so'): dst.writestr(n[5:], src.read(n))
`, files.aab, nativeZip]);
  run('bash', [path.join(source, 'scripts/check-elf-16k-alignment.sh'), nativeZip, objdump]);
  e.aabElf16k = true;
  e.generatedMapping = await readFile(files.mapping);
  e.embeddedMapping = run('unzip', ['-p', files.aab, mappingEntry], true);
  for (const key of ['apk', 'aab', 'mapping'])
    assert.equal(await hashFile(files[key]), e.payloadHashes[key], `${key} changed during verification`);
  return e;
}

async function main() {
  const [mode, version, rawCode, ...rest] = process.argv.slice(2);
  assert.ok(['--approve', '--prepare', '--verify'].includes(mode), 'Usage: --approve|--prepare VERSION CODE | --verify VERSION CODE BUNDLETOOL OBJDUMP BUILD_TOOLS TEMPORARY');
  assert.equal(rest.length, mode === '--verify' ? 4 : 0);
  assertContext();
  const original = JSON.parse(command('git', ['-C', root, 'show', 'HEAD:app.json']));
  const release = parseRelease(version, rawCode, original);
  const source = await inspectSource(root, release, mode === '--verify');
  if (mode === '--approve') return;
  if (mode === '--prepare') {
    await writeFile(path.join(root, 'app.json'), JSON.stringify(release.configured, null, 2) + '\n');
    await inspectSource(root, release, true);
    return;
  }
  const [bundletool, objdump, buildTools, temporary] = rest.map((file) => path.resolve(file));
  const files = { apk: path.join(root, 'android/app/build/outputs/apk/release/app-release-unsigned.apk'),
    aab: path.join(root, 'android/app/build/outputs/bundle/release/app-release.aab'),
    mapping: path.join(root, 'android/app/build/outputs/mapping/release/mapping.txt') };
  const evidence = await collectEvidence({ source: root, files, bundletool, objdump, buildTools, temporary });
  assert.deepEqual(await inspectSource(root, release, true), source);
  await publishVerified({ output: path.join(root, 'dist/unsigned-store'), files, evidence, release, source, context: process.env });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
