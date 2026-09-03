import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const installer = readFileSync(
  new URL('../scripts/install-caption-studio-fixed.ps1', import.meta.url),
  'utf8',
);

test('PowerShell installer resolves and explicitly starts only the fixed launcher activity', () => {
  assert.match(installer, /cmd package resolve-activity --brief/);
  assert.match(installer, /\$LaunchComponent -notmatch/);
  assert.match(installer, /'am', 'start', '-W', '-n', \$LaunchComponent/);
  assert.doesNotMatch(installer, /shell', 'monkey'/);
});
