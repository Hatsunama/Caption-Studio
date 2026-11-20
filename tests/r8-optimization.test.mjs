import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeR8Fixture, oldR8Metadata } from './fixtures/local-signing-r8.mjs';
import { assertR8Optimization, inspectR8Artifacts } from '../scripts/verify-r8-optimization.mjs';

const checksum = 'a'.repeat(64);
const good = () => ({ options: { isOptimizationsEnabled: true, isShrinkingEnabled: true,
  isObfuscationEnabled: true }, stats: { noOptimizationPercentage: 12.5 }, dexFiles: [{ checksum }] });
const aab = { 'base/dex/classes.dex': checksum }, apk = { 'classes.dex': checksum };

test('exact final v1.4.145 metadata fails on optimization option and independently on its 100% statistic', () => {
  assert.throws(() => assertR8Optimization(oldR8Metadata, aab, apk), /isOptimizationsEnabled/);
  const m = structuredClone(oldR8Metadata); m.options.isOptimizationsEnabled = true;
  assert.throws(() => assertR8Optimization(m, aab, apk), /noOptimizationPercentage/);
});

test('optimization permits retained JNI/reflection code and zero percent unoptimized', () => {
  assertR8Optimization(good(), aab, apk);
  const m = good(); m.stats.noOptimizationPercentage = 0;
  assertR8Optimization(m, aab, apk);
  // Inventory order is not a promise made by R8; names and bytes are.
  m.dexFiles.push({ checksum: 'b'.repeat(64) }); m.dexFiles.reverse();
  assertR8Optimization(m, { ...aab, 'base/dex/classes2.dex': 'b'.repeat(64) },
    { 'classes2.dex': 'b'.repeat(64), ...apk });
});

test('missing, malformed, disabled and invalid optimization statistics fail closed', () => {
  for (const metadata of [undefined, null, '{', [], {}])
    assert.throws(() => assertR8Optimization(metadata, aab, apk));
  for (const value of [undefined, null, '0', NaN, Infinity, -Infinity, -1, 100, 101]) {
    const m = good(); m.stats.noOptimizationPercentage = value;
    assert.throws(() => assertR8Optimization(m, aab, apk));
  }
  for (const key of ['isOptimizationsEnabled', 'isShrinkingEnabled', 'isObfuscationEnabled']) {
    for (const value of [undefined, false, 'true', 1]) {
      const m = good(); m.options[key] = value;
      assert.throws(() => assertR8Optimization(m, aab, apk));
    }
  }
});

test('exact DEX inventory rejects missing, additional, malformed and changed bytecode', () => {
  for (const inventory of [undefined, [], [{}], [{ checksum: 'bad' }], [{ checksum: 'b'.repeat(64) }],
    [{ checksum }, { checksum }]]) {
    const m = good(); m.dexFiles = inventory;
    assert.throws(() => assertR8Optimization(m, aab, apk));
  }
  for (const hashes of [{}, { 'classes.dex': 'b'.repeat(64) },
    { ...apk, 'classes2.dex': checksum }, { 'assets/classes.dex': checksum }])
    assert.throws(() => assertR8Optimization(good(), aab, hashes));
  assert.throws(() => assertR8Optimization(good(), { ...aab, 'feature/dex/classes.dex': checksum }, apk));
});

test('actual compressed archives accept optimized output and reject old 1.4.145 option/stat signature', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'r8-artifact-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = { apk: path.join(root, 'app.apk'), aab: path.join(root, 'app.aab') };
  writeR8Fixture(files);
  inspectR8Artifacts(files);
  for (const mutation of ['old-release', 'missing', 'malformed', 'disabled', 'all-unoptimized',
    'wrong-checksum', 'empty-inventory', 'apk-dex', 'nonfinite', 'negative', 'out-of-range', 'string-stat', 'missing-stat']) {
    writeR8Fixture(files, mutation);
    assert.throws(() => inspectR8Artifacts(files), undefined, mutation);
  }
});

test('CLI emits actual optimization statistics and matching DEX evidence; failures emit no success JSON', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'r8-cli-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = { apk: path.join(root, 'app.apk'), aab: path.join(root, 'app.aab') };
  const cli = fileURLToPath(new URL('../scripts/verify-r8-optimization.mjs', import.meta.url));
  const args = ['--max-old-space-size=64', cli, '--apk', files.apk, '--aab', files.aab];
  const execute = argv => execFileSync(process.execPath, argv, { encoding: 'utf8', stdio: 'pipe', windowsHide: true });
  writeR8Fixture(files);
  const summary = JSON.parse(execute(args));
  assert.equal(summary.options.isOptimizationsEnabled, true);
  assert.equal(summary.stats.noOptimizationPercentage, 12.5);
  assert.equal(summary.dexSha256Match, true);
  assert.equal(summary.dexFiles.length, 1);
  assert.match(summary.dexFiles[0].sha256, /^[0-9a-f]{64}$/);
  for (const mutation of ['old-release', 'missing', 'malformed', 'wrong-checksum', 'apk-dex']) {
    writeR8Fixture(files, mutation);
    assert.throws(() => execute(args), error => error.status === 1 && error.stdout === '' &&
      /R8 artifact verification failed/.test(error.stderr));
  }
  for (const argv of [[], ['--apk', files.apk], ['--apk', files.apk, '--apk', files.apk],
    ['--apk', files.apk, '--other', files.aab]])
    assert.throws(() => execute(['--max-old-space-size=64', cli, ...argv]));
});
