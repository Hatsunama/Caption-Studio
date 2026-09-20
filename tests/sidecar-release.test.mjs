import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { configureSidecarApp } from '../scripts/configure-sidecar-release.mjs';

const root = new URL('../', import.meta.url);
const productContract = JSON.parse(readFileSync(fileURLToPath(new URL('config/product-contract.json', root)), 'utf8'));

test('side-by-side release derives an isolated Android identity', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'caption-studio-sidecar-'));
  try {
    const configPath = path.join(directory, 'app.json');
    await writeFile(configPath, JSON.stringify({
      expo: {
        name: 'Caption Studio',
        slug: 'caption-studio',
        scheme: 'captionstudio',
        version: '1.4.2',
        android: { package: 'com.hatsunama.captionstudio', versionCode: 14 },
      },
    }));
    const source = JSON.parse(readFileSync(configPath, 'utf8'));
    const configured = configureSidecarApp(source, '1.4.76', 86);
    assert.equal(configured.expo.name, 'Caption Studio');
    assert.equal(configured.expo.android.package, productContract.android.release.package);
    assert.equal(configured.expo.android.versionCode, 86);
    assert.equal(configured.expo.version, '1.4.76');
    assert.equal(configured.expo.scheme, productContract.android.release.scheme);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('release workflow uses stable secrets and publishes a verified immutable APK', async () => {
  const workflow = await readFile(new URL('.github/workflows/publish-sidecar.yml', root), 'utf8');
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /CAPTION_STUDIO_FIXED_KEYSTORE_BASE64/);
  assert.match(workflow, /CAPTION_STUDIO_RELEASE_PACKAGE/);
  assert.match(workflow, /CAPTION_STUDIO_RELEASE_CERT_SHA256/);
  assert.match(workflow, /apksigner verify --verbose --print-certs/);
  assert.match(workflow, /zipalign" -c -P 16 4/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /tag="v\$\{VERSION\}"/);
  assert.match(workflow, /CAPTION_STUDIO_RELEASE_ASSET/);
  assert.match(workflow, /:app:lintRelease/);
  assert.match(workflow, /--init-script \.\.\/scripts\/first-party-android-lint\.gradle/);
  assert.doesNotMatch(workflow, /Caption Studio Fixed/);
  assert.doesNotMatch(workflow, /v\$\{VERSION\}-fixed/);
  assert.doesNotMatch(workflow, /caption-studio-fixed-android/);
  assert.doesNotMatch(workflow, /keytool -genkeypair/);
});

test('published release version-code verification uses release metadata, not APK downloads', async () => {
  const releaseScript = await readFile(new URL('scripts/configure-sidecar-release.mjs', root), 'utf8');
  assert.match(releaseScript, /contents\/app\.json\?ref=/);
  assert.doesNotMatch(releaseScript, /gh', \['release', 'download'/);
  assert.match(releaseScript, /if \(android\?\.package !== productContract\.android\.sourcePackage\) return null/);
});

test('verification workflow runs Android lint before retaining release artifacts', async () => {
  const workflow = await readFile(new URL('.github/workflows/ci.yml', root), 'utf8');
  assert.match(workflow, /:app:lintRelease/);
  assert.match(workflow, /--init-script \.\.\/scripts\/first-party-android-lint\.gradle/);
  assert.match(workflow, /:app:assembleRelease/);
  assert.match(workflow, /:app:bundleRelease/);
});

test('installer is fail-closed and cannot delete the production app', async () => {
  const installer = await readFile(new URL('scripts/install-caption-studio.ps1', root), 'utf8');
  assert.match(installer, /config\/product-contract\.json/);
  assert.match(installer, /signingCertificateSha256/);
  assert.match(installer, /Get-ApkCertificateSha256/);
  assert.match(installer, /apksigner/);
  assert.match(installer, /Multiple Android devices are connected/);
  assert.match(installer, /device\|unauthorized\|offline/);
  assert.match(installer, /Get-FileHash -LiteralPath \$Apk -Algorithm SHA256/);
  assert.match(installer, /'install', '-r', '--no-streaming'/);
  assert.match(installer, /\$Package = \[string\]\$Contract\.android\.release\.package/);
  assert.doesNotMatch(installer, /['"](?:uninstall|clear)['"]/);
  assert.doesNotMatch(installer, /com\.hatsunama\.captionstudio(?:['"]|\s)/);
});
