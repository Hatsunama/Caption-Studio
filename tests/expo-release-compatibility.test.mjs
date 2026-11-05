import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const expoCli = path.join(root, 'node_modules', 'expo', 'bin', 'cli');

test('installed Expo SDK packages satisfy the release compatibility check', () => {
  const env = { ...process.env, CI: '1' };
  delete env.EXPO_OFFLINE;
  const result = spawnSync(process.execPath, [expoCli, 'install', '--check'], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 90_000,
  });
  assert.equal(result.status, 0, [result.stdout, result.stderr, result.error?.message]
    .filter(Boolean).join('\n'));
});
