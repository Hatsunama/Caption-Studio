import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const productContract = JSON.parse(await readFile(path.join(repositoryRoot, 'config', 'product-contract.json'), 'utf8'));
const releaseContract = productContract.android.release;

export function configureSidecarApp(config, version, versionCode) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('Sidecar version must use MAJOR.MINOR.PATCH format.');
  }
  if (!Number.isSafeInteger(versionCode) || versionCode < 1) {
    throw new Error('Sidecar versionCode must be a positive integer.');
  }
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
  const [version, rawVersionCode, configPath = 'app.json'] = process.argv.slice(2);
  const versionCode = Number(rawVersionCode);
  const absolutePath = path.resolve(configPath);
  const config = JSON.parse(await readFile(absolutePath, 'utf8'));
  const configured = configureSidecarApp(config, version ?? '', versionCode);
  await writeFile(absolutePath, `${JSON.stringify(configured, null, 2)}\n`, 'utf8');
  process.stdout.write(`${configured.expo.android.package} ${configured.expo.version} (${configured.expo.android.versionCode})\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
