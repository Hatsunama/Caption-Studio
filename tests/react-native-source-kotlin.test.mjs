import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { alignReactNativeSourceKotlin } = require('../scripts/align-react-native-source-kotlin.cjs');
const original = fs.readFileSync(path.join(__dirname, 'fixtures/rn-source-libs.versions.toml'), 'utf8');
const hashes = require('./fixtures/rn-source-catalog-hashes.json');
const target = 'node_modules/react-native/gradle/libs.versions.toml';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const from = 'kotlin = "2.1.20"';
const to = 'kotlin = "2.3.21"';

function fixture(t, catalog = original) {
  // Every write, including child process fixtures, stays under this candidate.
  const root = fs.mkdtempSync(path.join(__dirname, 'fixture-run-'));
  const write = (name, text) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write('package.json', JSON.stringify({ dependencies: { 'react-native': '0.86.3', expo: '57.0.32' } }));
  write('node_modules/react-native/package.json', JSON.stringify({ name: 'react-native', version: '0.86.3' }));
  write(target, catalog);
  write('android/gradle.properties', 'reactNativeArchitectures=arm64-v8a\nandroid.ndkVersion=27.1.12297006\n');
  write('node_modules/@react-native/gradle-plugin/gradle/libs.versions.toml', 'kotlin = "2.3.0"\nagp = "8.12.0"\n');
  write('app/main.tsx', 'export const unchanged = true;\n');
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(__dirname));
    assert.ok(path.basename(resolved).startsWith('fixture-run-'));
    fs.rmSync(resolved, { recursive: true });
  });
  return { root, write, file: path.join(root, target), run: options => alignReactNativeSourceKotlin(root, options ?? { sourceBuild: true }) };
}
function snapshot(root) {
  const result = {};
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else result[path.relative(root, file)] = sha(fs.readFileSync(file));
    }
  }
  walk(root);
  return result;
}

for (const eol of ['lf', 'crlf']) {
  test(eol + ': changes exactly one catalog entry and no other files; second run performs no write', t => {
    const source = eol === 'lf' ? original : original.replace(/\n/g, '\r\n');
    const f = fixture(t, source);
    const before = snapshot(f.root);
    assert.equal(sha(source), hashes[eol].before);
    assert.equal(f.run(), true);
    const output = fs.readFileSync(f.file);
    assert.equal(output.toString(), source.replace(from, to));
    assert.equal(sha(output), hashes[eol].after);
    const after = snapshot(f.root);
    assert.deepEqual(Object.keys(after).filter(name => before[name] !== after[name]), [path.normalize(target)]);
    // Restore the original token to prove all remaining bytes, pins and formatting match.
    assert.equal(output.toString().replace(to, from), source);
    const fixed = new Date('2001-01-01T00:00:00Z');
    fs.utimesSync(f.file, fixed, fixed);
    const stat = fs.statSync(f.file, { bigint: true });
    assert.equal(f.run(), false);
    assert.equal(fs.statSync(f.file, { bigint: true }).mtimeNs, stat.mtimeNs);
    assert.deepEqual(snapshot(f.root), after);
  });
}

for (const [name, mutate] of [
  ['different RN dependency', f => f.write('package.json', '{"dependencies":{"react-native":"0.86.4"}}')],
  ['RN dependency range', f => f.write('package.json', '{"dependencies":{"react-native":"^0.86.3"}}')],
  ['different installed RN', f => f.write('node_modules/react-native/package.json', '{"name":"react-native","version":"0.86.4"}')],
  ['wrong installed package identity', f => f.write('node_modules/react-native/package.json', '{"name":"other","version":"0.86.3"}')],
  ['malformed manifest', f => f.write('package.json', '{')],
  ['missing manifest', f => fs.unlinkSync(path.join(f.root, 'package.json'))],
  ['missing catalog', f => fs.unlinkSync(f.file)],
  ['unknown compiler', f => f.write(target, original.replace(from, 'kotlin = "2.2.0"'))],
  ['changed AGP', f => f.write(target, original.replace('agp = "8.12.0"', 'agp = "8.13.0"'))],
  ['changed NDK', f => f.write(target, original.replace('27.1.12297006', '28.0.0'))],
  ['duplicate Kotlin entry', f => f.write(target, original + '\n' + from + '\n')],
  ['missing Kotlin entry', f => f.write(target, original.replace(from, ''))],
  ['added comment', f => f.write(target, original + '# unreviewed\n')],
  ['BOM', f => f.write(target, '\ufeff' + original)],
  ['mixed line endings', f => f.write(target, original.replace('[versions]\n', '[versions]\r\n'))],
  ['unknown already aligned input', f => f.write(target, original.replace(from, to) + '# unreviewed\n')],
]) {
  test('rejects ' + name + ' without changing any fixture files', t => {
    const f = fixture(t);
    mutate(f);
    const before = snapshot(f.root);
    assert.throws(() => f.run());
    assert.deepEqual(snapshot(f.root), before);
  });
}

test('version guards still run on already aligned catalog', t => {
  const f = fixture(t, original.replace(from, to));
  f.write('package.json', '{"dependencies":{"react-native":"0.86.4"}}');
  const before = snapshot(f.root);
  assert.throws(() => f.run(), /0\.86\.3/);
  assert.deepEqual(snapshot(f.root), before);
});

test('requires explicit source build opt-in, including when already aligned', t => {
  for (const source of [original, original.replace(from, to)]) {
    const f = fixture(t, source);
    const before = snapshot(f.root);
    for (const options of [{}, { sourceBuild: false }, { sourceBuild: 'true' }]) {
      assert.throws(() => f.run(options), /source.build/i);
    }
    assert.throws(() => alignReactNativeSourceKotlin(f.root), /source.build/i);
    assert.deepEqual(snapshot(f.root), before);
  }
});

test('CLI rejects missing flag, extra args and unknown flags; valid invocation is idempotent', t => {
  const f = fixture(t);
  const helper = path.resolve(__dirname, '../scripts/align-react-native-source-kotlin.cjs');
  const before = snapshot(f.root);
  for (const args of [[], [f.root], ['--wrong', f.root], ['--source-build', f.root, 'extra']]) {
    const result = spawnSync(process.execPath, [helper, ...args], { encoding: 'utf8', cwd: __dirname });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Usage:/);
    assert.deepEqual(snapshot(f.root), before);
  }
  for (const message of [/aligned/, /already aligned/]) {
    const result = spawnSync(process.execPath, [helper, '--source-build', f.root], { encoding: 'utf8', cwd: __dirname });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, message);
  }
});
