import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRetiredWorkflow } from '../scripts/test-private-artifact-gate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('gate rejects credential, publication, condition, trigger and YAML escape regressions', () => {
  const source = readFileSync(new URL('../.github/workflows/publish-sidecar.yml', import.meta.url), 'utf8');
  assertRetiredWorkflow(source, 'publish-sidecar');
  for (const changed of [
    source.replace('permissions: {}', 'permissions:\n  contents: write'),
    source.replace('    if: always()', '    if: success()'),
    source.replace('        if: always()', '        if: success()'),
    source.replace('exit 1', 'exit 0'),
    source.replace('exit 1', 'exit 1\n      - uses: actions/upload-artifact@bad'),
    source.replace('  workflow_dispatch:', '  push:'),
    source + 'env:\n  KEY: ${{ secrets.KEY }}\n',
    source.replace('permissions: {}', 'permissions: &grant {}'),
    source.replace('        shell: bash', '        continue-on-error: true\n        shell: bash'),
  ]) assert.throws(() => assertRetiredWorkflow(changed, 'publish-sidecar'));
});
for (const name of ['publish-sidecar', 'verify-play-aab', 'recover-local-signing']) {
  test(`${name} is a credential-free manual failure tombstone`, () => {
    const source = readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
    assert.match(source, /permissions: \{\}/);
    assert.match(source, /if: always\(\)/);
    assert.match(source, /exit 1/);
    assert.match(source, /unsigned-store-build\.yml/);
    assert.match(source, /local-signing\/sign-release\.ps1/);
    assert.doesNotMatch(source, /secrets\.|github\.token|uses:|checkout|upload-artifact|workflow_call:|contents: write/);
  });
}

test('legacy CLI fails before configuration reads, downloads, writes or tool execution for every mode', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'retired-play-cli-'));
  try {
    const script = path.join(fixture, 'verify-play-aab.mjs');
    writeFileSync(script, readFileSync(new URL('../scripts/verify-play-aab.mjs', import.meta.url)));
    for (const args of [[], ['--inputs', '1.4.136', '148'], ['--prepare', 'v1.4.136', '148', fixture],
      ['--verify', fixture, 'approval.json', 'bundletool.jar'], ['--unknown']]) {
      const result = spawnSync(process.execPath, ['--max-old-space-size=64', script, ...args], {
        cwd: fixture, env: { PATH: '', SystemRoot: process.env.SystemRoot || '' }, encoding: 'utf8', timeout: 10000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /RETIRED.*unsigned-store-build\.yml.*sign-release\.ps1/);
      assert.deepEqual(readdirSync(fixture), ['verify-play-aab.mjs']);
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('retirement harness is self-contained and does not fetch historical source or dependencies', () => {
  const source = readFileSync(new URL('../scripts/test-private-artifact-gate.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"](?:yaml|@actions\/expressions)['"]|execFileSync\('git'|bbf61511/);
  const caller = readFileSync(new URL('../.github/workflows/private-artifact-gate-test.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(caller, /npm install|fetch-depth: 0/);
  const result = spawnSync(process.execPath, ['--max-old-space-size=64', 'scripts/test-private-artifact-gate.mjs'], {
    cwd: root, encoding: 'utf8', timeout: 120000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
