import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { assertRetiredWorkflow } from '../scripts/test-private-artifact-gate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('synthetic recovery acceptance (no production secrets)', (t) => {
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'PYTHON_BIN', 'OPENSSL_BIN', 'KEYTOOL_BIN']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.PYTHONDONTWRITEBYTECODE = '1';
  const result = spawnSync(env.PYTHON_BIN || 'python3',
    ['-B', 'scripts/signing-recovery/acceptance.py'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}${result.error || ''}`);
  for (const line of result.stderr.split(/\r?\n/).filter(line => /^(Ran \d+ tests|OK \()/.test(line))) {
    t.diagnostic(line);
  }
});

test('recovery workflow has no credential or artifact path after retirement', () => {
  const source = readFileSync(new URL('../.github/workflows/recover-local-signing.yml', import.meta.url), 'utf8');
  assertRetiredWorkflow(source, 'recover-local-signing');
});
