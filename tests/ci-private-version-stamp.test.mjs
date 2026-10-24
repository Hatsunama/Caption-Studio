import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const step = workflow.replace(/\r\n/g, '\n').split('      - name: Stamp optional private test identity\n')[1]
  ?.split('\n      - name:')[0];
assert.ok(step, 'Private stamp step must exist');
const run = /^        run: (.+)$/m.exec(step);
assert.ok(run, 'Private stamp step must have a run body');
const stampBody = run[1] === '|'
  ? step.slice(run.index + run[0].length + 1).split('\n')
    .map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n')
  : run[1];
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';

function executeStamp(t, { missing, nonExecutable, version = '1.4.102', code = '160' } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'caption-ci-private-stamp-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, 'bin'));
  writeFileSync(path.join(directory, 'stamp.sh'), stampBody);
  writeFileSync(path.join(directory, 'bin', 'node'), `#!/bin/bash
set -euo pipefail
printf 'invoked\\n' >> "$FIXTURE_ROOT/node-invoked"
[[ -n "\${SIDECAR_BUILD_TOOLS:-}" ]] || { echo 'SIDECAR_BUILD_TOOLS missing' >&2; exit 42; }
actual="$(cd "$SIDECAR_BUILD_TOOLS" && pwd -P)"
[[ "$actual" == "$EXPECTED_BUILD_TOOLS" ]]
[[ "$SIDECAR_BUILD_TOOLS" == "$EXPECTED_BUILD_TOOLS" ]]
[[ -x "$SIDECAR_BUILD_TOOLS/aapt" && -x "$SIDECAR_BUILD_TOOLS/apksigner" ]]
[[ "$#" == 3 ]]
[[ "$1" == './scripts/configure-sidecar-release.mjs' && -f "$1" ]]
[[ "$2" == "$EXPECTED_VERSION" && "$3" == "$EXPECTED_CODE" ]]
[[ "$GH_TOKEN" == 'fixture-token' ]]
printf 'configured\\n' > "$FIXTURE_ROOT/configured"
`);
  const setup = `set -euo pipefail
cd "$1"
export FIXTURE_ROOT="$PWD"
export PATH="$PWD/bin:/usr/bin:/bin"
export ANDROID_HOME="$PWD/Android SDK"
export SIDECAR_BUILD_TOOLS="$PWD/stale-tools"
mkdir -p scripts "$ANDROID_HOME/build-tools/9.0.0" "$ANDROID_HOME/build-tools/35.0.0" "$ANDROID_HOME/build-tools/36.0.0"
touch scripts/configure-sidecar-release.mjs "$ANDROID_HOME/build-tools/99.0.0"
for version in 9.0.0 35.0.0 36.0.0; do
  for tool in aapt apksigner; do
    printf '#!/bin/bash\\nexit 0\\n' > "$ANDROID_HOME/build-tools/$version/$tool"
    chmod +x "$ANDROID_HOME/build-tools/$version/$tool"
  done
done
chmod +x bin/node
export EXPECTED_BUILD_TOOLS="$(cd "$ANDROID_HOME/build-tools/36.0.0" && pwd -P)"
case "$2" in
  aapt|apksigner) rm "$EXPECTED_BUILD_TOOLS/$2" ;;
  empty) rm -r "$ANDROID_HOME/build-tools"; mkdir "$ANDROID_HOME/build-tools" ;;
  sdk) rm -r "$ANDROID_HOME/build-tools" ;;
esac
if [[ -n "$3" ]]; then chmod -x "$EXPECTED_BUILD_TOOLS/$3"; fi
bash --noprofile --norc -e -o pipefail stamp.sh
`;
  const result = spawnSync(bash, ['--noprofile', '--norc', '-c', setup, 'stamp-fixture',
    directory.replaceAll('\\', '/'), missing ?? '', nonExecutable ?? ''], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
      PRIVATE_VERSION: version, PRIVATE_VERSION_CODE: code,
      EXPECTED_VERSION: version, EXPECTED_CODE: code, GH_TOKEN: 'fixture-token',
    },
  });
  assert.ifError(result.error);
  return { result, invoked: existsSync(path.join(directory, 'node-invoked')),
    configured: existsSync(path.join(directory, 'configured')) };
}

test('private stamp passes the newest SDK directory and supplied version arguments to configuration', (t) => {
  const { result, invoked, configured } = executeStamp(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(invoked, true);
  assert.equal(configured, true);
});

test('private stamp forwards empty version arguments for the existing validator to reject', (t) => {
  const { result, configured } = executeStamp(t, { version: '', code: '' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(configured, true);
});

for (const missing of ['aapt', 'apksigner', 'empty', 'sdk']) {
  test(`private stamp fails before configuration when SDK tools are missing: ${missing}`, (t) => {
    const { result, invoked, configured } = executeStamp(t, { missing });
    assert.notEqual(result.status, 0);
    assert.equal(invoked, false, 'Configuration must not run with missing SDK tools');
    assert.equal(configured, false);
  });
}

for (const nonExecutable of ['aapt', 'apksigner']) {
  test(`private stamp rejects non-executable ${nonExecutable} before configuration`, {
    skip: process.platform === 'win32' ? 'Git Bash does not enforce POSIX executable permission bits' : false,
  }, (t) => {
    const { result, invoked } = executeStamp(t, { nonExecutable });
    assert.notEqual(result.status, 0);
    assert.equal(invoked, false);
  });
}
