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
test('three corrected package commands repeat and recover regenerated settings with six final sources/nine targets', t => {
 const pkg=JSON.parse(fs.readFileSync(path.join(repo,'package.json')));
 const baseline={
  "scripts": {
    "android": "expo prebuild --platform android && node ./scripts/patch-react-native-gradle.js && expo run:android",
    "release:android": "set \"NODE_ENV=production\" && expo prebuild --platform android && node ./scripts/patch-react-native-gradle.js && cd android && gradlew.bat assembleRelease --no-daemon",
    "release:play": "set \"NODE_ENV=production\" && expo prebuild --platform android && node ./scripts/patch-react-native-gradle.js && cd android && gradlew.bat bundleRelease --no-daemon"
  }
};
 for(const key of ['android','release:android','release:play']) {
  assert.equal(pkg.scripts[key],baseline.scripts[key].replace('node ./scripts/patch-react-native-gradle.js','node ./scripts/prepare-android-runtime.cjs --after-prebuild .'));
  const f=fixture(t),owner=load(),before=snapshot(f.root); owner.run(f.root);
  const after=snapshot(f.root); assert.equal(Object.keys(after).filter(p=>after[p]!==before[p]).length,9);
  owner.run(f.root);assert.deepEqual(snapshot(f.root),after);
  f.write('android/settings.gradle', "pluginManagement { includeBuild('../node_modules/@react-native/gradle-plugin') }\n");
  owner.run(f.root);assert.deepEqual(snapshot(f.root),after);
  for(const p of payload)assert.equal(after['node_modules/react-native/'+p.relative],p.afterSha256);
  assert.equal(owner.calls.length,3);
 }
});

test('ordinary logic glob excludes every build tool and retained ordinary postinstall test runs on prepared sources',t=>{
 const f=fixture(t);load().run(f.root);
 fs.cpSync(path.join(repo,'scripts'),path.join(f.root,'scripts'),{recursive:true});
 fs.mkdirSync(path.join(f.root,'tests/build-tools'),{recursive:true});
 for(const entry of fs.readdirSync(path.join(repo,'tests'),{withFileTypes:true}))if(entry.isFile())fs.copyFileSync(path.join(repo,'tests',entry.name),path.join(f.root,'tests',entry.name));
 for(const entry of fs.readdirSync(path.join(repo,'tests/build-tools'),{withFileTypes:true}))if(entry.isFile())fs.copyFileSync(path.join(repo,'tests/build-tools',entry.name),path.join(f.root,'tests/build-tools',entry.name));
 const selected=[...fs.globSync('tests/*.test.mjs',{cwd:f.root})];
 assert.ok(selected.some(p=>p.endsWith('reanimated-postinstall.test.mjs')));
 assert.ok(selected.some(p=>p.endsWith('editor-action-accessibility.test.mjs')));
 assert.ok(selected.every(p=>!p.includes('build-tools')&&!/react-native-(final-source|source-settings|source-kotlin|hermes-source-layout)/.test(p)));
 const env={...process.env,NODE_OPTIONS:'--max-old-space-size=128'};delete env.NODE_TEST_CONTEXT;
 const r=spawnSync(process.execPath,['--max-old-space-size=128','--test','tests/reanimated-postinstall.test.mjs'],{cwd:f.root,encoding:'utf8',env});
 assert.equal(r.status,0,r.stdout+r.stderr);
});
