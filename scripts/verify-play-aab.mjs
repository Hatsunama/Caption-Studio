import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function command(program, args) {
  return execFileSync(program, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
}

function remoteTagCommit(tag, sourceRoot) {
  const output = command('git', ['-C', sourceRoot, 'ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  const refs = output.trim().split(/\r?\n/).map((line) => line.split(/\s+/));
  const peeled = refs.find(([, ref]) => ref === `refs/tags/${tag}^{}`);
  const direct = refs.find(([, ref]) => ref === `refs/tags/${tag}`);
  const commit = (peeled ?? direct)?.[0];
  assert.match(commit ?? '', /^[0-9a-f]{40}$/, 'approved release tag is absent');
  return commit;
}

function assertLatestPublishedRelease(tag) {
  const pages = JSON.parse(command('gh', ['api', '--paginate', '--slurp',
    `repos/${contract.repository}/releases?per_page=100`]));
  const releases = pages.flat();
  const candidates = releases.filter((release) => !release.draft &&
    release.assets?.some((asset) => asset.name === contract.android.release.assetName));
  assert.ok(candidates.some((release) => release.tag_name === tag), 'approved release must be published with an APK');
  for (const release of candidates) {
    assert.match(release.tag_name, /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    const current = release.tag_name.slice(1).split('.').map(BigInt);
    const selected = tag.slice(1).split('.').map(BigInt);
    for (let index = 0; index < 3; index += 1) {
      if (current[index] === selected[index]) continue;
      assert.ok(current[index] < selected[index], 'a newer published APK release exists');
      break;
    }
  }
}

async function prepare(tag, rawVersionCode, sourceRoot) {
  assert.match(tag ?? '', /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.equal(process.env.GITHUB_REPOSITORY, contract.repository);
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  const sourceCommit = command('git', ['-C', sourceRoot, 'rev-parse', 'HEAD']).trim();
  assert.equal(remoteTagCommit(tag, sourceRoot), sourceCommit, 'release tag moved after checkout');
  assertLatestPublishedRelease(tag);
  const release = JSON.parse(command('gh', ['release', 'view', tag, '--json', 'tagName,isDraft,assets']));
  assert.equal(release.tagName, tag);
  assert.equal(release.isDraft, false, 'release must be published');
  const manifestAssets = release.assets.filter((asset) => asset.name === 'caption-studio-release.json');
  const apkAssets = release.assets.filter((asset) => asset.name === contract.android.release.assetName);
  assert.equal(manifestAssets.length, 1, 'release must contain one approval manifest');
  assert.equal(apkAssets.length, 1, 'release must contain one APK');
  assert.ok(manifestAssets[0].size > 0 && manifestAssets[0].size <= 16384);
  assert.match(manifestAssets[0].digest ?? '', /^sha256:[0-9a-f]{64}$/);
  const directory = await mkdtemp(path.join(tmpdir(), 'caption-play-approval-'));
  let metadata;
  try {
    command('gh', ['release', 'download', tag, '--pattern', 'caption-studio-release.json', '--dir', directory]);
    const file = path.join(directory, 'caption-studio-release.json');
    assert.equal(await sha256(file), manifestAssets[0].digest.slice(7), 'approval manifest digest differs from GitHub asset');
    metadata = JSON.parse(await readFile(file, 'utf8'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  validateApproval(metadata, tag, sourceCommit, rawVersionCode);
  assert.equal(apkAssets[0].digest, `sha256:${metadata.apk.sha256}`, 'approved APK digest differs from manifest');
  const configPath = path.join(sourceRoot, 'app.json');
  const sourceApp = JSON.parse(await readFile(configPath, 'utf8'));
  const configured = configureApprovedApp(sourceApp, metadata);
  checkInputs(metadata.version, rawVersionCode, configured);
  await writeFile(configPath, `${JSON.stringify(configured, null, 2)}\n`);
  const dist = path.join(root, 'dist');
  await mkdir(dist, { recursive: true });
  await writeFile(path.join(dist, 'play-aab-approval.json'), `${JSON.stringify({
    ...metadata,
    manifestSha256: manifestAssets[0].digest.slice(7),
  }, null, 2)}\n`, { flag: 'wx' });
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function verify(sourceRoot, approvalPath, bundletool) {
  const metadata = JSON.parse(await readFile(approvalPath, 'utf8'));
  const sourceCommit = command('git', ['-C', sourceRoot, 'rev-parse', 'HEAD']).trim();
  const { version, versionCode } = validateApproval(metadata, metadata.tag, sourceCommit);
  assert.equal(remoteTagCommit(metadata.tag, sourceRoot), sourceCommit, 'release tag moved after build');
  const sourceApp = JSON.parse(await readFile(path.join(sourceRoot, 'app.json'), 'utf8'));
  checkInputs(version, String(versionCode), sourceApp);
  assert.equal(process.env.GITHUB_REPOSITORY, contract.repository);
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  assert.match(process.env.GITHUB_SHA ?? '', /^[0-9a-f]{40}$/);
  assert.match(process.env.GITHUB_RUN_ID ?? '', /^[1-9]\d*$/);
  assert.match(process.env.GITHUB_RUN_ATTEMPT ?? '', /^[1-9]\d*$/);
  const bundle = path.join(sourceRoot, 'android/app/build/outputs/bundle/release/app-release.aab');
  assert.ok((await stat(bundle)).size > 0, 'AAB is empty');
  assert.ok((await stat(bundletool)).size > 0, 'bundletool is missing');
  command('java', ['-jar', bundletool, 'validate', `--bundle=${bundle}`]);
  const mappingPath = path.join(sourceRoot, 'android/app/build/outputs/mapping/release/mapping.txt');
  const generatedMapping = await readFile(mappingPath);
  const entries = command('unzip', ['-Z', '-1', bundle]).split(/\r?\n/).filter(Boolean);
  const embeddedMapping = entries.includes(mappingEntry)
    ? execFileSync('unzip', ['-p', bundle, mappingEntry], { maxBuffer: 128 * 1024 * 1024 })
    : Buffer.alloc(0);
  const mappingSha256 = assertPlayBundleMapping(entries, generatedMapping, embeddedMapping);

  const attribute = (name) => command('java', [
    '-jar', bundletool, 'dump', 'manifest', `--bundle=${bundle}`, `--xpath=/manifest/@${name}`,
  ]).trim();
  assert.equal(attribute('package'), expectedPackage, 'AAB package differs from production package');
  assert.equal(attribute('android:versionCode'), String(versionCode), 'AAB versionCode differs from approved release');
  assert.equal(attribute('android:versionName'), version, 'AAB versionName differs from input');

  const signature = command('jarsigner', ['-verify', '-verbose', bundle]);
  assert.match(signature, /jar verified\./);
  assert.doesNotMatch(signature, /unsigned entries|jar is unsigned/i);
  const signingCertificateSha256 = parseCertificate(command('keytool', ['-printcert', '-jarfile', bundle]));

  const dist = path.join(root, 'dist');
  await mkdir(dist, { recursive: true });
  const output = path.join(dist, 'caption-studio-play.aab');
  await copyFile(bundle, output);
  const mappingOutput = path.join(dist, 'caption-studio-play-mapping.txt');
  await copyFile(mappingPath, mappingOutput);
  assert.equal(await sha256(mappingOutput), mappingSha256, 'Retained R8 mapping differs from the verified bundle');
  const sourceDigest = await sha256(bundle);
  const outputDigest = await sha256(output);
  assert.equal(outputDigest, sourceDigest, 'Copied AAB differs from verified build');
  const provenance = {
    schemaVersion: 1,
    repository: contract.repository,
    sourceCommit,
    gateCommit: process.env.GITHUB_SHA,
    approvedReleaseTag: metadata.tag,
    approvedReleaseManifestSha256: metadata.manifestSha256,
    ref: process.env.GITHUB_REF,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    package: expectedPackage,
    version,
    versionCode,
    signingCertificateSha256,
    mapping: { name: path.basename(mappingOutput), sha256: mappingSha256 },
    aab: { name: path.basename(output), sha256: outputDigest },
  };
  await writeFile(path.join(dist, 'play-aab-provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, { flag: 'wx' });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--inputs' && args.length === 3) checkInputs(args[1], args[2]);
  else if (args[0] === '--prepare' && args.length === 4) await prepare(args[1], args[2], path.resolve(args[3]));
  else if (args[0] === '--verify' && args.length === 4) await verify(path.resolve(args[1]), path.resolve(args[2]), path.resolve(args[3]));
  else throw new Error('Usage: verify-play-aab.mjs --prepare TAG VERSION_CODE SOURCE | --verify SOURCE APPROVAL BUNDLETOOL');
}
