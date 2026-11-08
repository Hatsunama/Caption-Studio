import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { configureReactNativeSource } = require('../../scripts/configure-react-native-source.js');

const source = `include(":packages:react-native:ReactAndroid")
include(":packages:react-native:ReactAndroid:hermes-engine")
val propertiesToInherit = listOf("hermesV1Enabled", "react.hermesV1Enabled")
`;
const generated = `pluginManagement {
  includeBuild(reactNativeGradlePlugin)
  includeBuild(expoPluginsPath)
}
plugins { id("com.facebook.react.settings") }
expoAutolinking.useExpoModules()
include ':app'
includeBuild(expoAutolinking.reactNativeGradlePlugin)
`;
function fixture(t, settings = generated) {
  const root = fs.mkdtempSync(path.join(__dirname, 'fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rn = path.join(root, 'node_modules/react-native');
  fs.mkdirSync(rn, { recursive: true });
  fs.mkdirSync(path.join(root, 'android'));
  const write = (name, value) => fs.writeFileSync(path.join(root, name), value);
  write('package.json', JSON.stringify({ dependencies: { 'react-native': '0.86.3', expo: '57.0.32' } }));
  write('node_modules/react-native/package.json', '{"version":"0.86.3"}');
  write('node_modules/react-native/settings.gradle.kts', source);
  write('android/settings.gradle', settings);
  write('android/gradle.properties', 'hermesEnabled=true\r\nreactNativeArchitectures=arm64-v8a\r\norg.gradle.java.home=C:/hardened-jdk\r\n');
  return { root, write, settings: path.join(root, 'android/settings.gradle') };
}
function snapshot(root) {
  const result = {};
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else result[path.relative(root, full)] = fs.readFileSync(full).toString('hex');
    }
  }
  walk(root);
  return result;
}

for (const eol of ['\n', '\r\n']) {
  for (const finalNewline of [true, false]) {
    test(`preserves all outside bytes, four substitutions, idempotent ${JSON.stringify(eol)} final=${finalNewline}`, t => {
      const original = '\ufeff' + generated.trimEnd().replaceAll('\n', eol) + (finalNewline ? eol : '');
      const f = fixture(t, original);
      const before = snapshot(f.root);
      assert.equal(configureReactNativeSource(f.root), true);
      const output = fs.readFileSync(f.settings);
      assert.deepEqual(output.subarray(0, Buffer.byteLength(original)), Buffer.from(original));
      const added = output.subarray(Buffer.byteLength(original)).toString();
      assert.equal((added.match(/substitute\(module\(/g) || []).length, 4);
      for (const name of ['react-android', 'react-native', 'hermes-android', 'hermes-engine']) {
        const project = name.startsWith('hermes') ? ':packages:react-native:ReactAndroid:hermes-engine' : ':packages:react-native:ReactAndroid';
        assert.ok(added.includes(`substitute(module("com.facebook.react:${name}")).using(project("${project}"))`));
      }
      assert.ok(added.includes("includeBuild('../node_modules/react-native')"));
      if (eol === '\r\n') assert.ok(!added.replaceAll('\r\n', '').includes('\n'));
      assert.equal(configureReactNativeSource(f.root), false);
      assert.deepEqual(fs.readFileSync(f.settings), output);
      const after = snapshot(f.root);
      delete before[path.join('android', 'settings.gradle')];
      delete after[path.join('android', 'settings.gradle')];
      assert.deepEqual(after, before);
    });
  }
}
for (const conflict of [
  "includeBuild('../node_modules/react-native') {}",
  'includeBuild(file("../node_modules/react-native"))',
  'includeBuild(rnPath)',
  "includeBuild '../node_modules/react-native'",
  'includeBuild("../vendor/custom-build")',
]) test(`fails closed on existing include: ${conflict}`, t => {
  const f = fixture(t, generated + conflict);
  const before = snapshot(f.root);
  assert.throws(() => configureReactNativeSource(f.root), /includeBuild/);
  assert.deepEqual(snapshot(f.root), before);
});

test('allows known literal Gradle plugin include without changing it', t => {
  const f = fixture(t, "includeBuild('../node_modules/@react-native/gradle-plugin')\n");
  assert.equal(configureReactNativeSource(f.root), true);
});
for (const file of ['package.json', 'node_modules/react-native/package.json']) {
  for (const already of [false, true]) test(`version gate ${file} already=${already}`, t => {
    const f = fixture(t);
    if (already) configureReactNativeSource(f.root);
    f.write(file, file === 'package.json' ? '{"dependencies":{"react-native":"^0.86.3"}}' : '{"version":"0.86.4"}');
    const before = snapshot(f.root);
    assert.throws(() => configureReactNativeSource(f.root), /0\.86\.3/);
    assert.deepEqual(snapshot(f.root), before);
  });
}
test('missing source project rejected even after configuration', t => {
  const f = fixture(t);
  configureReactNativeSource(f.root);
  f.write('node_modules/react-native/settings.gradle.kts', source.replace('include(":packages:react-native:ReactAndroid:hermes-engine")', ''));
  assert.throws(() => configureReactNativeSource(f.root), /source settings/);
});
test('tampered and duplicate marker blocks rejected', t => {
  const f = fixture(t);
  configureReactNativeSource(f.root);
  const good = fs.readFileSync(f.settings, 'utf8');
  f.write('android/settings.gradle', good.replace('com.facebook.react:react-android', 'bad:coordinate'));
  assert.throws(() => configureReactNativeSource(f.root), /marker/);
  f.write('android/settings.gradle', good + good);
  assert.throws(() => configureReactNativeSource(f.root), /marker/);
});
test('lock prevents overlapping helper and is not removed by loser', t => {
  const f = fixture(t);
  const lock = f.settings + '.rn-source.lock';
  fs.writeFileSync(lock, 'other writer');
  assert.throws(() => configureReactNativeSource(f.root), /lock|EEXIST/);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'other writer');
});
test('concurrent settings edit is preserved and staged file cleaned', t => {
  const f = fixture(t);
  const sync = fs.fsyncSync;
  fs.fsyncSync = fd => { sync(fd); f.write('android/settings.gradle', generated + '// concurrent editor\n'); };
  try { assert.throws(() => configureReactNativeSource(f.root), /changed/); }
  finally { fs.fsyncSync = sync; }
  assert.equal(fs.readFileSync(f.settings, 'utf8'), generated + '// concurrent editor\n');
  assert.deepEqual(fs.readdirSync(path.dirname(f.settings)).sort(), ['gradle.properties', 'settings.gradle']);
});
test('concurrent version edit aborts commit', t => {
  const f = fixture(t);
  const sync = fs.fsyncSync;
  fs.fsyncSync = fd => { sync(fd); f.write('node_modules/react-native/package.json', '{"version":"0.86.4"}'); };
  try { assert.throws(() => configureReactNativeSource(f.root), /changed/); }
  finally { fs.fsyncSync = sync; }
  assert.equal(fs.readFileSync(f.settings, 'utf8'), generated);
});
test('hardlinked settings rejected', t => {
  const f = fixture(t);
  fs.linkSync(f.settings, path.join(f.root, 'alias.gradle'));
  assert.throws(() => configureReactNativeSource(f.root), /link/);
});
for (const directory of ['android', 'node_modules/react-native']) test(`junction rejected: ${directory}`, t => {
  const f = fixture(t);
  const target = path.join(f.root, directory);
  fs.renameSync(target, target + '-real');
  fs.symlinkSync(target + '-real', target, 'junction');
  assert.throws(() => configureReactNativeSource(f.root), /link/);
});
test('invalid UTF-8 and missing generated settings rejected', t => {
  const f = fixture(t, Buffer.from([0xff]));
  assert.throws(() => configureReactNativeSource(f.root), /UTF|encoded/);
  fs.unlinkSync(f.settings);
  assert.throws(() => configureReactNativeSource(f.root), /ENOENT|prebuild/);
});
test('managed block must remain appended at end of settings', t => {
  const f = fixture(t);
  configureReactNativeSource(f.root);
  fs.appendFileSync(f.settings, '// later settings mutation\n');
  assert.throws(() => configureReactNativeSource(f.root), /marker/);
});
test('rename failure preserves original settings and cleans lock/staging', t => {
  const f = fixture(t);
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('fixture rename failure'); };
  try { assert.throws(() => configureReactNativeSource(f.root), /fixture rename failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(f.settings, 'utf8'), generated);
  assert.deepEqual(fs.readdirSync(path.dirname(f.settings)).sort(), ['gradle.properties', 'settings.gradle']);
});
test('conflicting include is checked even with a valid managed block', t => {
  const f = fixture(t);
  configureReactNativeSource(f.root);
  f.write('android/settings.gradle', "includeBuild(otherRN)\n" + fs.readFileSync(f.settings, 'utf8'));
  assert.throws(() => configureReactNativeSource(f.root), /includeBuild/);
});
test('root junction rejected', t => {
  const f = fixture(t);
  const alias = path.join(f.root, 'root-alias');
  fs.symlinkSync(f.root, alias, 'junction');
  assert.throws(() => configureReactNativeSource(alias), /link/);
  fs.unlinkSync(alias);
});
