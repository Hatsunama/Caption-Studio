import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const productContract = JSON.parse(await readFile(path.join(repositoryRoot, 'config', 'product-contract.json'), 'utf8'));
const releaseContract = productContract.android.release;
const run = promisify(execFile);
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

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

async function checkPublishedRelease(version, versionCode) {
  validateVersion(version, versionCode);
  const repository = productContract.repository;
  // Include prereleases and every page; /releases/latest excludes prereleases.
  // API failures must not be mistaken for an empty release history.
  const { stdout } = await run('gh', ['api', '--paginate', '--slurp',
    `repos/${repository}/releases?per_page=100`], { maxBuffer: 32 * 1024 * 1024 });
  const releases = JSON.parse(stdout).flat();
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
  if (published.length === 0) return;
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk) throw new Error('Android SDK is required to inspect published versionCode.');
  const buildToolsRoot = path.join(sdk, 'build-tools');
  const buildTools = (await readdir(buildToolsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && versionPattern.test(entry.name))
    .sort((a, b) => compareVersions(b.name, a.name));
  if (!buildTools.length) throw new Error('Stable Android build tools with aapt are required.');
  const aapt = path.join(buildToolsRoot, buildTools[0].name,
    process.platform === 'win32' ? 'aapt.exe' : 'aapt');
  let maximumPublishedCode = 0;
  let maximumCodeTag = '';
  for (const release of published) {
    const directory = await mkdtemp(path.join(tmpdir(), 'caption-release-policy-'));
    try {
      await run('gh', ['release', 'download', release.tag_name, '--repo', repository,
        '--pattern', releaseContract.assetName, '--dir', directory]);
      const { stdout: badging } = await run(aapt,
        ['dump', 'badging', path.join(directory, releaseContract.assetName)]);
      const identity = /^package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']+)'/m.exec(badging);
      if (!identity || identity[1] !== releaseContract.package ||
          identity[3] !== release.tag_name.slice(1)) {
        throw new Error(`Published APK identity does not match ${release.tag_name}.`);
      }
      const priorCode = Number(identity[2]);
      validateVersion(identity[3], priorCode, false);
      if (priorCode > maximumPublishedCode) {
        maximumPublishedCode = priorCode;
        maximumCodeTag = release.tag_name;
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (versionCode <= maximumPublishedCode) {
    throw new Error(`versionCode ${versionCode} must exceed ${maximumCodeTag} (${maximumPublishedCode}).`);
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
