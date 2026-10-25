import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

test('manual workflow gates credentials and restricts artifacts', () => {
  const text = readFileSync(new URL('../.github/workflows/recover-local-signing.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(text, /workflow_dispatch:/);
  assert.doesNotMatch(text, /^\s*(pull_request|pull_request_target|push|schedule|workflow_call):/m);
  for (const guard of ["github.repository == 'Hatsunama/Caption-Studio'", "github.event_name == 'workflow_dispatch'",
    "github.ref == 'refs/heads/main'", "github.actor == 'Hatsunama'", "github.triggering_actor == 'Hatsunama'",
    "inputs.confirmation == 'RECOVER_EXISTING_SOLANA_TO_C_ENCRYPTED'"]) {
    assert.ok(text.includes(guard), guard);
    assert.ok(text.indexOf(guard) < text.indexOf('uses: actions/checkout@'));
  }
  assert.match(text, /permissions:\s*\n  contents: read/);
  assert.equal((text.match(/persist-credentials: false/g) || []).length, 2);
  assert.equal((text.match(/ref: \$\{\{ github.sha \}\}/g) || []).length, 2);
  assert.match(text, /actions\/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1[\s\S]*?node-version: 22\.23\.4/);
  assert.equal((text.match(/actions\/setup-java@b843ebf9b913146b38da2eaa7aeddf76074ae1ad/g) || []).length, 2);
  assert.equal((text.match(/java-version: '17\.0\.21\+9'/g) || []).length, 2);
  assert.equal((text.match(/distribution: temurin/g) || []).length, 2);
  assert.match(text, /retention-days: 1/);
  assert.match(text, /if-no-files-found: error/);
  assert.doesNotMatch(text, /actions\/cache|npm (ci|install)|gradle|secrets\.[A-Z_]+\s*\}\}[^\n]*[;&]/);
  assert.equal((text.match(/secrets\.CAPTION_STUDIO_FIXED_/g) || []).length, 4);
  for (const line of text.split('\n').filter(line => line.includes('uses:'))) {
    assert.match(line, /@[0-9a-f]{40}(?:\s|$)/);
  }
  const paths = text.split('path: |')[1].split('retention-days:')[0].trim().split('\n').map(s => s.trim());
  assert.deepEqual(paths, ['${{ runner.temp }}/solana-recovery-output/recovery.p7m',
    '${{ runner.temp }}/solana-recovery-output/manifest.json']);
  const recoveryJob = text.split('\n  recover:')[1];
  assert.ok(recoveryJob.indexOf('github.actor') < recoveryJob.indexOf('uses: actions/checkout@'));
  assert.match(recoveryJob, /needs: synthetic-tests/);
  assert.match(recoveryJob, /if: always\(\)/);
  // Secret expressions must occur exclusively in the export step's env mapping.
  const secretLines = text.split('\n').filter(line => line.includes('secrets.'));
  for (const line of secretLines) {
    assert.match(line, /^          (CAPTION_STUDIO_FIXED_[A-Z0-9_]+): \$\{\{ secrets\.\1 \}\}$/);
  }
});

// Execute the exact first-step shell body on Git Bash locally and Bash on Linux.
for (const job of ['synthetic-tests', 'recover']) {
  test(`${job}: exact preflight rejects case variants and context mismatches`, () => {
    const workflow = readFileSync(new URL('../.github/workflows/recover-local-signing.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const section = workflow.split(`\n  ${job}:`)[1].split(/\n  [a-z][a-z-]*:/)[0];
    const first = section.split('    steps:\n')[1].split('      - ')[1];
    assert.match(first, /^name: Exact recovery preflight\n/);
    assert.match(first, /shell: bash/);
    assert.match(first, /RECOVERY_CONFIRMATION: \$\{\{ inputs.confirmation \}\}/);
    const body = first.split('        run: |\n')[1].split('\n')
      .filter(line => line.startsWith('          ')).map(line => line.slice(10)).join('\n');
    assert.ok(body);
    assert.doesNotMatch(body, /\$\{\{/);
    const base = {GITHUB_REPOSITORY: 'Hatsunama/Caption-Studio', GITHUB_REPOSITORY_OWNER: 'Hatsunama',
      GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_ACTOR: 'Hatsunama',
      GITHUB_TRIGGERING_ACTOR: 'Hatsunama',
      RECOVERY_CONFIRMATION: 'RECOVER_EXISTING_SOLANA_TO_C_ENCRYPTED'};
    const cases = [base];
    for (const [key, value] of Object.entries(base)) {
      cases.push({...base, [key]: value === value.toLowerCase() ? value.toUpperCase() : value.toLowerCase()});
      cases.push({...base, [key]: ''});
    }
    for (const [key, value] of [['GITHUB_EVENT_NAME', 'pull_request'], ['GITHUB_EVENT_NAME', 'pull_request_target'],
      ['GITHUB_REF', 'refs/pull/1/merge'], ['GITHUB_REF', 'refs/heads/other'], ['GITHUB_ACTOR', 'other'],
      ['RECOVERY_CONFIRMATION', '$(exit 0); RECOVER_EXISTING_SOLANA_TO_C_ENCRYPTED']]) cases.push({...base, [key]: value});
    for (const [i, context] of cases.entries()) {
      const env = {...context};
      for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
      const result = spawnSync(process.env.BASH_BIN || 'bash', ['--noprofile', '--norc', '-c', body],
        {env, encoding: 'utf8', timeout: 10000});
      assert.ifError(result.error);
      assert.equal(result.status === 0, i === 0, `context case ${i}`);
      assert.equal(result.stdout, '');
    }
  });
}
