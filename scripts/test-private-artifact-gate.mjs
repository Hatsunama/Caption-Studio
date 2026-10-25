import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const retiredNames = ['publish-sidecar', 'verify-play-aab', 'recover-local-signing'];
export const message = 'RETIRED: use .github/workflows/unsigned-store-build.yml then scripts/local-signing/sign-release.ps1. See docs/cloud-signing-retirement.md.';
export const refusal = `echo '${message}' >&2\nexit 1`;

// Deliberately exact YAML grammar: reject unknown keys, aliases, expressions,
// steps and commands. No general YAML dependency or historical checkout needed.
export function assertRetiredWorkflow(source, name) {
  assert.ok(retiredNames.includes(name));
  const expected = `name: Retired ${name}
# Compatibility tombstone. See docs/cloud-signing-retirement.md.
on:
  workflow_dispatch:
permissions: {}
jobs:
  retired:
    if: always()
    runs-on: ubuntu-24.04
    timeout-minutes: 1
    steps:
      - name: Refuse retired cloud signing and recovery
        if: always()
        shell: bash
        run: |
${refusal.split('\n').map(line => '          ' + line).join('\n')}
`;
  assert.equal(source.replaceAll('\r\n', '\n'), expected, `${name}: only the unconditional failure tombstone is allowed`);
  return source.replaceAll('\r\n', '\n').split('        run: |\n')[1]
    .trimEnd().split('\n').map(line => line.slice(10)).join('\n');
}

export function runRetirementGate(root, requestedState) {
  const states = requestedState ? [requestedState] : ['success', 'failure', 'cancelled', 'recovery'];
  for (const state of states) assert.ok(['success', 'failure', 'cancelled', 'recovery'].includes(state));
  let cases = 0;
  for (const name of retiredNames) {
    const body = assertRetiredWorkflow(readFileSync(path.join(root, '.github/workflows', name + '.yml'), 'utf8'), name);
    // always() is independent of events, refs, inputs and previous status.
    // Execute the actual refusal even for events no longer admitted by the trigger.
    for (const state of states) for (const event of ['workflow_dispatch', 'push', 'pull_request', 'pull_request_target', 'workflow_call', 'schedule', 'workflow_run']) {
      const env = { GITHUB_EVENT_NAME: event, GATE_STATE: state };
      for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
      const result = spawnSync(process.env.BASH_BIN || 'bash', ['--noprofile', '--norc', '-c', body], {
        env, encoding: 'utf8', timeout: 10000, windowsHide: true,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 1, `${name}/${event}/${state}`);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr.trim(), message);
      cases++;
    }
  }
  console.log(`PASS retired cloud workflows; behavioral cases=${cases}; no credentials, publication or historical checkout`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRetirementGate(process.env.GATE_WORKSPACE || fileURLToPath(new URL('../', import.meta.url)), process.env.GATE_STATE);
}
