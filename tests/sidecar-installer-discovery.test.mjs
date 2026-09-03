import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const installer = readFileSync(
  new URL('../scripts/install-caption-studio-fixed.ps1', import.meta.url),
  'utf8',
);

test('PowerShell installer enumerates GitHub release arrays before filtering', () => {
  assert.match(
    installer,
    /\$ReleasePayload = Invoke-RestMethod[\s\S]*\$Releases = @\(\$ReleasePayload \| ForEach-Object \{ \$_ \}\)/,
  );
  assert.doesNotMatch(installer, /\$Releases = @\(Invoke-RestMethod/);
});
