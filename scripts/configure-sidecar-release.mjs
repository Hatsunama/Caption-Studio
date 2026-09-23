import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const productContract = JSON.parse(await readFile(path.join(repositoryRoot, 'config', 'product-contract.json'), 'utf8'));
const releaseContract = productContract.android.release;
const expectedAndroidPackage = 'com.xmilo_at_your_side.caption_studio';
if (productContract.android.sourcePackage !== expectedAndroidPackage ||
    releaseContract.package !== expectedAndroidPackage) {
  throw new Error(`Caption Studio Android application id must be ${expectedAndroidPackage}.`);
}
const run = promisify(execFile);
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
export const releaseMetadataAsset = 'caption-studio-release.json';
const historicalPackages = new Set(['com.hatsunama.captionstudio', 'com.hatsunama.captionstudio.fixed']);
const sha256Pattern = /^[0-9a-f]{64}$/;

async function hashApk(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export function parseSigningCertificate(certificates, expectedSha256) {
  const count = [...certificates.matchAll(/^Number of signers: ([0-9]+)\r?$/gm)];
  const digests = [...certificates.matchAll(/^(?:Signer #[0-9]+|V[0-9]+(?:\.[0-9]+)? Signer:) certificate SHA-256 digest: ([0-9a-fA-F]{64})\r?$/gm)]
    .map((match) => match[1].toLowerCase());
  if (count.length !== 1 || Number(count[0][1]) !== 1 || digests.length === 0 ||
      digests.some((digest) => digest !== expectedSha256)) {
    throw new Error('APK must have exactly one signer with the pinned release certificate.');
  }
  return expectedSha256;
}

async function inspectApk(filename) {
  const buildTools = process.env.SIDECAR_BUILD_TOOLS;
  if (!buildTools) throw new Error('SIDECAR_BUILD_TOOLS must name an Android SDK build-tools directory.');
  const { stdout: badging } = await run(path.join(buildTools, 'aapt'), ['dump', 'badging', filename]);
  const identity = /^package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']+)'/m.exec(badging);
  if (!identity) throw new Error('Cannot read published APK identity.');
  const { stdout: certificates } = await run(path.join(buildTools, 'apksigner'),
    ['verify', '--verbose', '--print-certs', filename]);
  const signingCertificateSha256 = parseSigningCertificate(certificates, releaseContract.signingCertificateSha256);
  return {
    package: identity[1], version: identity[3], versionCode: Number(identity[2]),
    signingCertificateSha256,
    apk: { name: releaseContract.assetName, sha256: await hashApk(filename) },
  };
}

export function validateReleaseMetadata(metadata, tag, apkAsset) {
  if (metadata?.schemaVersion !== 1 || metadata.repository !== productContract.repository ||
      metadata.tag !== tag || metadata.version !== tag.slice(1) ||
      !/^v/.test(tag) || !/^[0-9a-f]{40}$/.test(metadata.sourceCommit ?? '') ||
      metadata.package !== releaseContract.package ||
      metadata.signingCertificateSha256 !== releaseContract.signingCertificateSha256 ||
      metadata.apk?.name !== releaseContract.assetName ||
      !sha256Pattern.test(metadata.apk?.sha256 ?? '')) {
    throw new Error(`Invalid release metadata or identity for ${tag}.`);
  }
  validateVersion(metadata.version, metadata.versionCode, false);
  if (apkAsset?.digest != null && apkAsset.digest !== `sha256:${metadata.apk.sha256}`) {
    throw new Error(`APK digest does not match release metadata for ${tag}.`);
  }
  return { tag, versionCode: metadata.versionCode };
}

async function readMetadataAsset(asset) {
  if (!Number.isSafeInteger(asset.id) || asset.size > 16384) throw new Error('Invalid metadata asset.');
  const { stdout } = await run('gh', ['api', '-H', 'Accept: application/octet-stream',
    `repos/${productContract.repository}/releases/assets/${asset.id}`], { maxBuffer: 16384 });
  return JSON.parse(stdout);
}

async function readLegacyApk(release, apkAsset) {
  const directory = await mkdtemp(path.join(tmpdir(), 'caption-release-history-'));
  try {
    await run('gh', ['release', 'download', release.tag_name, '--repo', productContract.repository,
      '--pattern', releaseContract.assetName, '--dir', directory]);
    const identity = await inspectApk(path.join(directory, releaseContract.assetName));
    if (apkAsset.digest != null && apkAsset.digest !== `sha256:${identity.apk.sha256}`) {
      throw new Error(`Historical APK digest mismatch for ${release.tag_name}.`);
    }
    return identity;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function resolvePublishedRelease(release, {
  readMetadata = readMetadataAsset, readLegacy = readLegacyApk,
} = {}) {
  const apks = release.assets.filter((asset) => asset.name === releaseContract.assetName);
  const manifests = release.assets.filter((asset) => asset.name === releaseMetadataAsset);
  if (apks.length !== 1 || manifests.length > 1) throw new Error(`Ambiguous assets for ${release.tag_name}.`);
  if (manifests.length === 1) {
    // A present but broken manifest is never silently replaced with legacy evidence.
    return validateReleaseMetadata(await readMetadata(manifests[0]), release.tag_name, apks[0]);
  }
  // Immutable historical releases cannot be backfilled. Inspect their actual APK,
  // never tagged app.json, which predates checkout-only version overrides.
  const identity = await readLegacy(release, apks[0]);
  if (historicalPackages.has(identity.package)) return null;
  if (identity.package !== releaseContract.package ||
      identity.signingCertificateSha256 !== releaseContract.signingCertificateSha256 ||
      identity.version !== release.tag_name.slice(1)) {
    throw new Error(`Historical APK identity/version mismatch for ${release.tag_name}.`);
  }
  validateVersion(identity.version, identity.versionCode, false);
  return { tag: release.tag_name, versionCode: identity.versionCode };
}

async function listPublishedReleases() {
  // Include prereleases and every page; failures must not become empty history.
  const { stdout } = await run('gh', ['api', '--paginate', '--slurp',
    `repos/${productContract.repository}/releases?per_page=100`], { maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout).flat();
}

function compareVersions(left, right) {
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function validateVersion(version, versionCode, enforceMinimum = true) {
  if (typeof version !== 'string' || !versionPattern.test(version)) {
    throw new Error('Sidecar version must use canonical MAJOR.MINOR.PATCH format.');
  }
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2100000000) {
    throw new Error('Sidecar versionCode must be an integer from 1 to 2100000000.');
  }
  if (enforceMinimum && compareVersions(version, releaseContract.minimumVersion) < 0) {
    throw new Error(`Sidecar version must be at least ${releaseContract.minimumVersion}.`);
  }
}

export async function checkPublishedRelease(version, versionCode, {
  listReleases = listPublishedReleases, resolveRelease = resolvePublishedRelease,
} = {}) {
  validateVersion(version, versionCode);
  const releases = await listReleases();
  if (releases.some((release) => release.tag_name === `v${version}`)) {
    throw new Error(`Release v${version} already exists; refusing replacement.`);
  }
  const published = releases.filter((release) => !release.draft &&
    release.assets.some((asset) => asset.name === releaseContract.assetName));
  for (const release of published) {
    const priorVersion = String(release.tag_name).replace(/^v/, '');
    if (!String(release.tag_name).startsWith('v') || !versionPattern.test(priorVersion)) {
      throw new Error(`Cannot establish release ordering for ${release.tag_name}.`);
    }
    if (compareVersions(version, priorVersion) <= 0) {
      throw new Error(`Version ${version} must exceed published release ${release.tag_name}.`);
    }
    if (!Number.isFinite(Date.parse(release.published_at))) {
      throw new Error(`Release ${release.tag_name} has no valid publication date.`);
    }
  }
  const compatiblePublished = published.filter((release) =>
    compareVersions(release.tag_name.slice(1), releaseContract.minimumVersion) >= 0);
  const publishedCodes = [];
  // The minimum version starts this package lineage; older APKs belong to a different app.
  for (const release of compatiblePublished) {
    const entry = await resolveRelease(release);
    if (entry !== null) publishedCodes.push(entry);
  }
  const maximumPublished = publishedCodes.reduce(
    (maximum, current) => current.versionCode > maximum.versionCode ? current : maximum,
    { tag: '', versionCode: 0 },
  );
  if (versionCode <= maximumPublished.versionCode) {
    throw new Error(`versionCode ${versionCode} must exceed ${maximumPublished.tag} (${maximumPublished.versionCode}).`);
  }
}

export function configureSidecarApp(config, version, versionCode) {
  validateVersion(version, versionCode);
  if (config?.expo?.android?.package !== productContract.android.sourcePackage) {
    throw new Error('Refusing to derive a sidecar from an unexpected Android package.');
  }

  return {
    ...config,
    expo: {
      ...config.expo,
      name: releaseContract.name,
      slug: releaseContract.slug,
      scheme: releaseContract.scheme,
      version,
      android: {
        ...config.expo.android,
        package: releaseContract.package,
        versionCode,
      },
      extra: {
        ...config.expo.extra,
        releaseChannel: releaseContract.channel,
      },
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--write-metadata') {
    const [, version, rawCode, apkPath, outputPath] = args;
    if (args.length !== 5 || !/^[1-9][0-9]*$/.test(rawCode ?? '')) {
      throw new Error('Usage: --write-metadata VERSION VERSION_CODE APK OUTPUT');
    }
    validateVersion(version, Number(rawCode));
    const identity = await inspectApk(path.resolve(apkPath));
    if (identity.version !== version || identity.versionCode !== Number(rawCode)) {
      throw new Error('Built APK version does not match release inputs.');
    }
    const metadata = {
      schemaVersion: 1, repository: productContract.repository, tag: `v${version}`,
      sourceCommit: process.env.GITHUB_SHA, ...identity,
    };
    validateReleaseMetadata(metadata, metadata.tag);
    await writeFile(path.resolve(outputPath), `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
    return;
  }
  const checkOnly = args[0] === '--check-published';
  if (checkOnly) args.shift();
  const [version, rawVersionCode, configPath = 'app.json'] = args;
  if (!/^[1-9][0-9]*$/.test(rawVersionCode ?? '')) {
    throw new Error('Sidecar versionCode must be a canonical positive integer.');
  }
  const versionCode = Number(rawVersionCode);
  await checkPublishedRelease(version, versionCode);
  if (checkOnly) return;
  const absolutePath = path.resolve(configPath);
  const config = JSON.parse(await readFile(absolutePath, 'utf8'));
  const configured = configureSidecarApp(config, version ?? '', versionCode);
  await writeFile(absolutePath, `${JSON.stringify(configured, null, 2)}\n`, 'utf8');
  process.stdout.write(`${configured.expo.android.package} ${configured.expo.version} (${configured.expo.android.versionCode})\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
