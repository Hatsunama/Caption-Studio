import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.match(installer, /Remove-Item -LiteralPath \$Apk -Force -ErrorAction Stop/);
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
