import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(new URL('../package.json', import.meta.url));
const expo = createRequire(require.resolve('expo/package.json'));
const consumers = [
  ['root', require],
  ['Expo CLI', createRequire(expo.resolve('@expo/cli/package.json'))],
  ...['@expo/metro-config', 'micromatch', 'jest-util', 'tinyglobby', 'fdir'].map(name =>
    [name, createRequire(require.resolve(name))]),
];
const probe = "const pm=require(process.argv[1]);pm.makeRe('+(*a)').test('a'.repeat(48)+'!');process.stdout.write('completed');";
for (const [owner, consumer] of consumers) {
  test(owner + ' resolves a reviewed matcher and terminates on the actual installed code', () => {
    const entry = consumer.resolve('picomatch');
    const metadata = consumer('picomatch/package.json');
    const result = spawnSync(process.execPath, ['--max-old-space-size=32', '-e', probe, entry],
      { timeout: 1500, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, owner + ' matcher must not exhaust its subprocess deadline');
    assert.equal(result.stdout, 'completed');
    assert.match(metadata.name, /^@caption-studio\/picomatch-backport-v[24]$/);
    assert.match(metadata.version, /^(?:2\.3\.2|4\.0\.7)-caption-studio\.1$/);
    assert.equal(consumer('picomatch').isMatch('src/a.ts', 'src/*.{ts,tsx}'), true);
    assert.equal(consumer('picomatch').isMatch('assets/a.png', 'src/*.{ts,tsx}'), false);
  });
}
test('actual Metro and Jest consumers retain brace globs and ignored-file semantics', () => {
  for (const owner of ['metro-file-map', '@expo/metro-file-map']) {
    const consumer = createRequire(require.resolve(owner));
    const micromatch = consumer('micromatch');
    assert.deepEqual(micromatch(['src/a.ts', 'src/a.test.ts', 'src/b.tsx', 'assets/a.png'],
      ['src/**/*.{ts,tsx}', '!**/*.test.ts']), ['src/a.ts', 'src/b.tsx']);
  }
  const match = require('jest-util').globsToMatcher(['**/*.ts', '!**/*.test.ts']);
  assert.equal(match('src/a.ts'), true);
  assert.equal(match('src/a.test.ts'), false);
  assert.equal(match('assets/a.png'), false);
});
test('actual tinyglobby/fdir path finds ordinary assets and respects exclusion', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'caption-picomatch-consumers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/a.ts'), 'synthetic source');
  await writeFile(path.join(root, 'src/a.test.ts'), 'synthetic test');
  const result = require('tinyglobby').globSync(['src/**/*.ts', '!**/*.test.ts'], { cwd: root });
  assert.deepEqual(result, ['src/a.ts']);
});