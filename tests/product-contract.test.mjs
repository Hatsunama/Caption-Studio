import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

test('generated TypeScript and Android model contracts exactly match the product manifest', () => {
  const result = spawnSync(process.execPath, ['scripts/generate-product-contract.mjs', '--check'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('release identity and translation artifact each have one authoritative manifest owner', () => {
  const contract = JSON.parse(readFileSync(fileURLToPath(new URL('../config/product-contract.json', import.meta.url)), 'utf8'));
  assert.equal(contract.android.sourcePackage, 'com.xmilo_at_your_side.caption_studio');
  assert.equal(contract.android.release.package, 'com.xmilo_at_your_side.caption_studio');
  assert.match(contract.android.release.signingCertificateSha256, /^[a-f0-9]{64}$/);
  assert.equal(contract.translation.downloadBytes, 1597931520);
  assert.match(contract.translation.sha256, /^[a-f0-9]{64}$/);
});

test('package, lockfile, Expo config, installer floor, and README publish one version', () => {
  const packageManifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  const packageLock = JSON.parse(readFileSync(fileURLToPath(new URL('../package-lock.json', import.meta.url)), 'utf8'));
  const app = JSON.parse(readFileSync(fileURLToPath(new URL('../app.json', import.meta.url)), 'utf8'));
  const contract = JSON.parse(readFileSync(fileURLToPath(new URL('../config/product-contract.json', import.meta.url)), 'utf8'));
  const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
  assert.equal(packageLock.version, packageManifest.version);
  assert.equal(packageLock.packages[''].version, packageManifest.version);
  assert.equal(app.expo.version, packageManifest.version);
  assert.equal(contract.android.release.minimumVersion, packageManifest.version);
  assert.match(readme, new RegExp(`v${packageManifest.version.replaceAll('.', '\\.')}\\b`));
});
