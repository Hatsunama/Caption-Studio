import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const expectedPackage = 'com.xmilo_at_your_side.caption_studio';
const contract = JSON.parse(readFileSync(new URL('config/product-contract.json', root), 'utf8'));
const app = JSON.parse(readFileSync(new URL('app.json', root), 'utf8'));
const releaseWorkflow = readFileSync(new URL('.github/workflows/publish-sidecar.yml', root), 'utf8');
const androidVerifier = readFileSync(new URL('scripts/verify-android-release-config.js', root), 'utf8');
const generator = readFileSync(new URL('scripts/generate-product-contract.mjs', root), 'utf8');

test('source, release, Expo, and generated Android checks agree on the application ID', () => {
  assert.equal(contract.android.sourcePackage, expectedPackage);
  assert.equal(contract.android.release.package, expectedPackage);
  assert.equal(app.expo.android.package, expectedPackage);
  assert.ok(androidVerifier.includes(expectedPackage));
  assert.match(releaseWorkflow, /npx expo prebuild --platform android --clean --no-install/);
  assert.match(releaseWorkflow, /npm run verify:android-config/);
});

test('source version starts the installable package lineage', () => {
  assert.equal(app.expo.version, contract.android.release.minimumVersion);
  assert.ok(Number.isSafeInteger(app.expo.android.versionCode) && app.expo.android.versionCode > 0);
});

test('contract generation rejects legacy or arbitrary package IDs before generating files', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'caption-package-transition-'));
  try {
    mkdirSync(join(fixture, 'scripts'));
    mkdirSync(join(fixture, 'config'));
    writeFileSync(join(fixture, 'scripts', 'generate-product-contract.mjs'), generator);
    for (const wrongPackage of ['com.hatsunama.captionstudio', 'com.hatsunama.captionstudio.fixed', 'com.example.other']) {
      for (const field of ['source', 'release', 'both']) {
        const invalid = structuredClone(contract);
        if (field !== 'release') invalid.android.sourcePackage = wrongPackage;
        if (field !== 'source') invalid.android.release.package = wrongPackage;
        writeFileSync(join(fixture, 'config', 'product-contract.json'), JSON.stringify(invalid));
        const result = spawnSync(process.execPath, [join(fixture, 'scripts', 'generate-product-contract.mjs'), '--check'], {
          encoding: 'utf8',
          timeout: 10000,
        });
        assert.ifError(result.error);
        assert.notEqual(result.status, 0);
        assert.ok(result.stderr.includes(`Caption Studio Android application id must be ${expectedPackage}.`), result.stderr);
      }
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
