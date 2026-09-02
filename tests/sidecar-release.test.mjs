import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);

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
    const scriptPath = fileURLToPath(new URL('scripts/configure-sidecar-release.mjs', root));
    const result = spawnSync(process.execPath, [scriptPath, '1.4.3', '15', configPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const configured = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(configured.expo.name, 'Caption Studio Fixed');
    assert.equal(configured.expo.android.package, 'com.hatsunama.captionstudio.fixed');
    assert.equal(configured.expo.android.versionCode, 15);
    assert.equal(configured.expo.version, '1.4.3');
    assert.equal(configured.expo.scheme, 'captionstudiofixed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fixed release workflow uses stable secrets and publishes a verified immutable APK', async () => {
  const workflow = await readFile(new URL('.github/workflows/publish-sidecar.yml', root), 'utf8');
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /CAPTION_STUDIO_FIXED_KEYSTORE_BASE64/);
  assert.match(workflow, /com\.hatsunama\.captionstudio\.fixed/);
  assert.match(workflow, /apksigner verify --verbose --print-certs/);
  assert.match(workflow, /zipalign" -c -P 16 4/);
  assert.match(workflow, /gh release create/);
  assert.doesNotMatch(workflow, /keytool -genkeypair/);
});

test('fixed installer is fail-closed and cannot delete the production app', async () => {
  const installer = await readFile(new URL('scripts/install-caption-studio-fixed.ps1', root), 'utf8');
  assert.match(installer, /Multiple authorized Android devices are connected/);
  assert.match(installer, /Get-FileHash -LiteralPath \$Apk -Algorithm SHA256/);
  assert.match(installer, /'install', '-r', '--no-streaming'/);
  assert.match(installer, /com\.hatsunama\.captionstudio\.fixed/);
  assert.doesNotMatch(installer, /['"](?:uninstall|clear)['"]/);
  assert.doesNotMatch(installer, /com\.hatsunama\.captionstudio(?:['"]|\s)/);
});
