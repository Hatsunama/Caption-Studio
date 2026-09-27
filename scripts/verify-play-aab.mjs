import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(await readFile(path.join(root, 'config/product-contract.json'), 'utf8'));
const app = JSON.parse(await readFile(path.join(root, 'app.json'), 'utf8'));
const expectedPackage = 'com.xmilo_at_your_side.caption_studio';

export function checkInputs(version, rawVersionCode) {
  assert.equal(contract.android.sourcePackage, expectedPackage);
  assert.equal(contract.android.release.package, expectedPackage);
  assert.equal(app.expo.android.package, expectedPackage);
  assert.match(version ?? '', /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.match(rawVersionCode ?? '', /^[1-9]\d*$/);
  assert.equal(version, app.expo.version, 'version must equal app.json');
  assert.equal(Number(rawVersionCode), app.expo.android.versionCode, 'versionCode must equal app.json');
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

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function verify(bundle, bundletool, version, rawVersionCode) {
  checkInputs(version, rawVersionCode);
  assert.equal(process.env.GITHUB_REPOSITORY, contract.repository);
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  assert.match(process.env.GITHUB_SHA ?? '', /^[0-9a-f]{40}$/);
  assert.match(process.env.GITHUB_RUN_ID ?? '', /^[1-9]\d*$/);
  assert.match(process.env.GITHUB_RUN_ATTEMPT ?? '', /^[1-9]\d*$/);
  assert.ok((await stat(bundle)).size > 0, 'AAB is empty');
  assert.ok((await stat(bundletool)).size > 0, 'bundletool is missing');
  command('java', ['-jar', bundletool, 'validate', `--bundle=${bundle}`]);

  const attribute = (name) => command('java', [
    '-jar', bundletool, 'dump', 'manifest', `--bundle=${bundle}`, `--xpath=/manifest/@${name}`,
  ]).trim();
  assert.equal(attribute('package'), expectedPackage, 'AAB package differs from production package');
  assert.equal(attribute('android:versionCode'), rawVersionCode, 'AAB versionCode differs from input');
  assert.equal(attribute('android:versionName'), version, 'AAB versionName differs from input');

  const signature = command('jarsigner', ['-verify', '-verbose', bundle]);
  assert.match(signature, /jar verified\./);
  assert.doesNotMatch(signature, /unsigned entries|jar is unsigned/i);
  const signingCertificateSha256 = parseCertificate(command('keytool', ['-printcert', '-jarfile', bundle]));

  const dist = path.join(root, 'dist');
  await mkdir(dist, { recursive: true });
  const output = path.join(dist, 'caption-studio-play.aab');
  await copyFile(bundle, output);
  const sourceDigest = await sha256(bundle);
  const outputDigest = await sha256(output);
  assert.equal(outputDigest, sourceDigest, 'Copied AAB differs from verified build');
  const provenance = {
    schemaVersion: 1,
    repository: contract.repository,
    sourceCommit: process.env.GITHUB_SHA,
    ref: process.env.GITHUB_REF,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    package: expectedPackage,
    version,
    versionCode: Number(rawVersionCode),
    signingCertificateSha256,
    aab: { name: path.basename(output), sha256: outputDigest },
  };
  await writeFile(path.join(dist, 'play-aab-provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, { flag: 'wx' });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--inputs' && args.length === 3) checkInputs(args[1], args[2]);
  else if (args.length === 4) await verify(path.resolve(args[0]), path.resolve(args[1]), args[2], args[3]);
  else throw new Error('Usage: verify-play-aab.mjs --inputs VERSION VERSION_CODE | AAB BUNDLETOOL VERSION VERSION_CODE');
}
