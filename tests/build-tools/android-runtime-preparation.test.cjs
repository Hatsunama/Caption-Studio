'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '../..');
// Read-only source inputs. Every mutation is inside a unique directory here.
const installer = require(path.join(repo, 'scripts/react-native-fontfit/install-final-sources.cjs'));
const settings = require(path.join(repo, 'scripts/configure-react-native-source.js'));
const kotlin = require(path.join(repo, 'scripts/align-react-native-source-kotlin.cjs'));
const hermes = require(path.join(repo, 'scripts/react-native-fontfit/repair-hermes-source-layout.cjs'));
const payload = require(path.join(repo, 'scripts/react-native-fontfit/source-chunks.json'));
const sha = b => createHash('sha256').update(b).digest('hex');
const original = payload.map(f => {
  const b = fs.readFileSync(path.join(repo, 'node_modules/react-native', f.relative));
  assert.equal(sha(b), f.beforeSha256, 'Clean locked inputs required before installing sources');
  return b;
});
// Written before the candidate: initial RED must be a missing entrypoint.
const candidate = path.join(repo, 'scripts/prepare-android-runtime.cjs');
const code = fs.readFileSync(candidate, 'utf8');
function load(overrides = {}, main = false, argv = []) {
  const calls = [];
  const modules = {
    './patch-react-native-gradle.js': { patchReactNativeGradle: root => calls.push(['base', root]) },
    './react-native-fontfit/install-final-sources.cjs': installer,
    './configure-react-native-source.js': settings,
    './align-react-native-source-kotlin.cjs': kotlin,
    './react-native-fontfit/repair-hermes-source-layout.cjs': hermes,
    ...overrides,
  };
  const mod = { exports: {}, filename: candidate };
  const req = id => id.startsWith('node:') ? require(id) : modules[id] || assert.fail('Unexpected dependency ' + id);
  req.main = main ? mod : {};
  const proc = { argv: ['node', candidate, ...argv], exitCode: 0 };
  const errors = [];
  vm.runInNewContext(code, { require: req, module: mod, process: proc,
    console: { log() {}, error: x => errors.push(x) } }, { filename: candidate });
  return { run: mod.exports.prepareAndroidRuntime, calls, proc, errors };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(__dirname, '.fixture-'));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(__dirname));
    assert.match(path.basename(resolved), /^\.fixture-/);
    fs.rmSync(resolved, { recursive: true });
  });
  const write = (rel, b) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, b); };
  write('package.json', JSON.stringify({ dependencies: { 'react-native': '0.86.3' } }));
  write('node_modules/react-native/package.json', JSON.stringify({ name: 'react-native', version: '0.86.3' }));
  write('android/settings.gradle', "pluginManagement { includeBuild('../node_modules/@react-native/gradle-plugin') }\n");
  write('node_modules/react-native/settings.gradle.kts', 'include(":packages:react-native:ReactAndroid")\ninclude(":packages:react-native:ReactAndroid:hermes-engine")\n');
  write('node_modules/react-native/gradle/libs.versions.toml', fs.readFileSync(path.join(repo, 'tests/fixtures/rn-source-libs.versions.toml')));
  const h = fs.readFileSync(path.join(repo, 'node_modules/react-native/ReactAndroid/hermes-engine/build.gradle.kts'), 'utf8');
  write('node_modules/react-native/ReactAndroid/hermes-engine/build.gradle.kts', h.replace('if (this.path.startsWith("facebook-hermes-") || this.path.startsWith("meta-hermes-")) {', 'if (this.path.startsWith("facebook-hermes-")) {'));
  payload.forEach((f, i) => write('node_modules/react-native/' + f.relative, original[i]));
  for (const f of ['ios/sentinel', 'web/sentinel', 'android/gradle.properties', 'package-lock.json']) write(f, 'unchanged\n');
  return { root, write };
}
function snapshot(root) {
  const result = {};
  function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) walk(file);
    else result[path.relative(root, file).replaceAll('\\', '/')] = sha(fs.readFileSync(file));
  } }
  walk(root); return result;
}
test('import is inert; explicit root and generated Android settings required', t => {
  const f = fixture(t), owner = load();
  assert.equal(owner.calls.length, 0);
  assert.throws(() => owner.run(), /root/i);
  fs.unlinkSync(path.join(f.root, 'android/settings.gradle'));
  const before = snapshot(f.root);
  assert.throws(() => owner.run(f.root), /ENOENT|prebuild/i);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(owner.calls.length, 0);
});
test('actual four guarded helpers complete; only nine runtime targets change; retry is byte-idempotent', t => {
  assert.equal(payload.length, 6);
  const f = fixture(t), owner = load(), before = snapshot(f.root);
  owner.run(f.root);
  payload.forEach(p => assert.equal(sha(fs.readFileSync(path.join(f.root, 'node_modules/react-native', p.relative))), p.afterSha256));
  assert.match(fs.readFileSync(path.join(f.root, 'android/settings.gradle'), 'utf8'), /BEGIN CAPTION STUDIO RN 0.86.3 SOURCE BUILD/);
  assert.match(fs.readFileSync(path.join(f.root, 'node_modules/react-native/gradle/libs.versions.toml'), 'utf8'), /kotlin = "2.3.21"/);
  assert.equal(sha(fs.readFileSync(path.join(f.root, 'node_modules/react-native/ReactAndroid/hermes-engine/build.gradle.kts'))), '79fc202074ed52f395429b980d507bff7d896d6edab54b02904af3d17cf92371');
  const after = snapshot(f.root);
  const expected = [...payload.map(p => 'node_modules/react-native/' + p.relative), 'android/settings.gradle', 'node_modules/react-native/gradle/libs.versions.toml', 'node_modules/react-native/ReactAndroid/hermes-engine/build.gradle.kts'];
  assert.deepEqual(Object.keys(after).filter(k => after[k] !== before[k]).sort(), expected.sort());
  owner.run(f.root); assert.deepEqual(snapshot(f.root), after);
  assert.equal(owner.calls.length, 2);
});
test('recognized mixed six-file state and a later-helper failure resume honestly', t => {
  const f = fixture(t);
  installer.installFinalSources(f.root);
  f.write('node_modules/react-native/' + payload[2].relative, original[2]);
  const catalog = 'node_modules/react-native/gradle/libs.versions.toml';
  const good = fs.readFileSync(path.join(f.root, catalog));
  f.write(catalog, 'unknown');
  assert.throws(() => load().run(f.root), /catalog SHA-256/);
  assert.equal(sha(fs.readFileSync(path.join(f.root, 'node_modules/react-native', payload[2].relative))), payload[2].afterSha256);
  assert.match(fs.readFileSync(path.join(f.root, 'android/settings.gradle'), 'utf8'), /BEGIN CAPTION/);
  f.write(catalog, good); load().run(f.root);
  const done = snapshot(f.root); load().run(f.root); assert.deepEqual(snapshot(f.root), done);
});
test('unknown source and a foreign lock propagate; later helpers never run', t => {
  const f = fixture(t), before = snapshot(f.root);
  const lock = 'android/settings.gradle.rn-source.lock'; f.write(lock, 'foreign-owner');
  assert.throws(() => load().run(f.root), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(f.root, lock), 'utf8'), 'foreign-owner');
  fs.unlinkSync(path.join(f.root, lock));
  f.write('node_modules/react-native/' + payload[0].relative, 'unknown');
  assert.throws(() => load().run(f.root), /source\/hash/);
  assert.equal(snapshot(f.root)['node_modules/react-native/gradle/libs.versions.toml'], before['node_modules/react-native/gradle/libs.versions.toml']);
});
test('preserves order, stops at each failure, uses no source-build opt-in except Kotlin', t => {
  const f = fixture(t);
  const specs = [ ['base', './patch-react-native-gradle.js', 'patchReactNativeGradle'], ['sources', './react-native-fontfit/install-final-sources.cjs', 'installFinalSources'], ['settings', './configure-react-native-source.js', 'configureReactNativeSource'], ['kotlin', './align-react-native-source-kotlin.cjs', 'alignReactNativeSourceKotlin'], ['hermes', './react-native-fontfit/repair-hermes-source-layout.cjs', 'repairHermesSourceLayout'] ];
  for (const failure of [-1, 0, 1, 2, 3, 4]) {
    const calls = [], overrides = {};
    specs.forEach(([label, id, name], i) => { overrides[id] = { [name]: (root, options) => {
      assert.equal(root, path.resolve(f.root));
      if (label === 'kotlin') assert.equal(options.sourceBuild, true); else assert.equal(options, undefined);
      calls.push(label); if (i === failure) throw Error('failure-' + label);
    } }; });
    const owner = load(overrides);
    if (failure === -1) owner.run(f.root); else assert.throws(() => owner.run(f.root), /failure-/);
    assert.deepEqual(calls, specs.slice(0, failure === -1 ? 5 : failure + 1).map(s => s[0]));
  }
});
test('CLI rejects absent opt-in, absent root, and unknown trailing args under 128MB', () => {
  for (const args of [[], ['--after-prebuild'], ['x'], ['--after-prebuild', '.', 'extra']]) {
    const result = spawnSync(process.execPath, ['--max-old-space-size=128', candidate, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /Usage:/);
  }
});
test('CLI valid invocation completes and helper errors set nonzero exit status', t => {
  const f = fixture(t);
  const success = load({}, true, ['--after-prebuild', f.root]);
  assert.equal(success.proc.exitCode, 0); assert.equal(success.calls.length, 1);
  const failure = load({ './patch-react-native-gradle.js': { patchReactNativeGradle() { throw Error('base rejected'); } } }, true, ['--after-prebuild', f.root]);
  assert.equal(failure.proc.exitCode, 1); assert.deepEqual(failure.errors, ['base rejected']);
});
test('base export adaptation preserves CLI postinstall order/root and first-error propagation; import is inert', () => {
  const filename = path.join(repo, 'scripts/patch-react-native-gradle.js');
  const source = fs.readFileSync(filename, 'utf8');
  const names = ['patchWhisperWordBoundaries', 'repairPressableAccessibility', 'repairNativeScrollInput', 'repairReanimatedNativeProps', 'patchAndroidDependencies', 'configureAndroidRelease'];
  for (const main of [false, true]) for (const fail of [false, true]) {
    const calls = [], mod = { filename, exports: {} };
    const req = id => id === 'node:path' ? path : new Proxy({}, { get: (_, name) => root => {
      calls.push([name, root]); if (fail && name === names[0]) throw Error('rejected');
    } });
    req.main = main ? mod : {};
    const run = () => vm.runInNewContext(source, { require: req, module: mod });
    if (main && fail) assert.throws(run, /rejected/); else run();
    assert.deepEqual(calls.map(c => c[0]), main ? (fail ? names.slice(0, 1) : names) : []);
    assert.ok(calls.every(c => c[1] === path.join(path.dirname(filename), '..')));
    if (!main) {
      const invoke = () => mod.exports.patchReactNativeGradle('explicit-fixture');
      if (fail) assert.throws(invoke, /rejected/); else invoke();
      assert.equal(calls[0][1], 'explicit-fixture');
    }
  }
});
