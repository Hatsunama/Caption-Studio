import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const installer = readFileSync(
  new URL('../scripts/install-caption-studio.ps1', import.meta.url),
  'utf8',
);

test('PowerShell installer resolves and explicitly starts only the update launcher activity', () => {
  assert.match(installer, /Invoke-Adb @\('-s', \$Serial, 'shell', 'cmd', 'package', 'resolve-activity', '--brief'/);
  assert.match(installer, /\$LaunchComponent -notmatch/);
  assert.match(installer, /'am', 'start', '-W', '-n', \$LaunchComponent/);
  assert.doesNotMatch(installer, /shell', 'monkey'/);
});

test('installer handles native stderr and restricts cleanup to its own temporary files', () => {
  assert.match(installer, /\$ErrorActionPreference = 'Continue'/);
  assert.match(installer, /\$PSNativeCommandUseErrorActionPreference = \$false/);
  assert.match(installer, /\$ExitCode = \$LASTEXITCODE/);
  assert.match(installer, /\$ExitCode -ne 0/);
  assert.match(installer, /\$ErrorActionPreference = \$PreviousPreference/);
  assert.match(installer, /\[Guid\]::NewGuid\(\)/);
  assert.match(installer, /if \(\$OwnsTempDir\)/);
  assert.match(installer, /foreach \(\$File in @\(\$Apk, "\$Apk\.partial"\)\)/);
  assert.match(installer, /Remove-Item -LiteralPath \$File -Force -ErrorAction Stop/);
  assert.match(installer, /\[IO.Directory\]::Delete\(\$TempDir, \$false\)/);
  assert.match(installer, /Write-Warning "Temporary cleanup failed/);
  assert.doesNotMatch(installer, /-Recurse/);
});

test('installer retries interrupted APK downloads through an atomic partial file', () => {
  assert.match(installer, /function Invoke-AssetDownload/);
  assert.match(installer, /\$Attempts = 4/);
  assert.match(installer, /\$Partial = "\$Destination\.partial"/);
  assert.match(installer, /Invoke-WebRequest -UseBasicParsing -Uri \$Uri -OutFile \$Partial -ErrorAction Stop/);
  assert.match(installer, /\[IO\.File\]::Move\(\$Partial, \$Destination\)/);
  assert.match(installer, /APK download failed after \$Attempts attempts/);
  assert.match(installer, /Invoke-AssetDownload -Uri \$Asset\.browser_download_url -Destination \$Apk/);
});

test('installer cleans an interrupted partial download from its owned temp directory', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'CaptionStudioInstaller-test-'));
  const apk = join(tempDir, 'caption-studio.apk');
  writeFileSync(`${apk}.partial`, 'interrupted download');
  const finalizer = installer.slice(installer.lastIndexOf('\nfinally {'));
  assert.ok(finalizer.startsWith('\nfinally {'));
  const script = `$TempDir = $env:CAPTION_STUDIO_TEST_TEMP\n$Apk = Join-Path $TempDir 'caption-studio.apk'\n$OwnsTempDir = $true\ntry {} ${finalizer}`;

  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      env: { ...process.env, CAPTION_STUDIO_TEST_TEMP: tempDir },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Temporary APK and installer download directory removed/);
    assert.doesNotMatch(result.stderr, /Temporary cleanup failed/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
