import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SIDECAR_NAME = 'Caption Studio Fixed';
const SIDECAR_SLUG = 'caption-studio-fixed';
const SIDECAR_SCHEME = 'captionstudiofixed';
const SIDECAR_PACKAGE = 'com.hatsunama.captionstudio.fixed';

export function configureSidecarApp(config, version, versionCode) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('Sidecar version must use MAJOR.MINOR.PATCH format.');
  }
  if (!Number.isSafeInteger(versionCode) || versionCode < 1) {
    throw new Error('Sidecar versionCode must be a positive integer.');
  }
  if (config?.expo?.android?.package !== 'com.hatsunama.captionstudio') {
    throw new Error('Refusing to derive a sidecar from an unexpected Android package.');
  }

  return {
    ...config,
    expo: {
      ...config.expo,
      name: SIDECAR_NAME,
      slug: SIDECAR_SLUG,
      scheme: SIDECAR_SCHEME,
      version,
      android: {
        ...config.expo.android,
        package: SIDECAR_PACKAGE,
        versionCode,
      },
      extra: {
        ...config.expo.extra,
        releaseChannel: 'fixed-sidecar',
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
