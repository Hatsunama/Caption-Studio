import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const utility = path.join(root, 'scripts/harden-java-truststores.mjs');
const fixtures = path.join(root, 'tests/fixtures/java-truststore');
const keytool = process.env.JAVA_TRUSTSTORE_TEST_KEYTOOL || (process.platform === 'win32'
  ? 'C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.18.8-hotspot\\bin\\keytool.exe'
  : path.join(process.env.JAVA_HOME || '/usr/lib/jvm/default-java', 'bin/keytool'));
const blocked = ['86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b',
  'd7a7a0fb5d7e2731d771e9484ebcdef71d5f0c3e0a2948782bc83ee0ea699ef4'];
const hash = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function kt(args) {
  const r = spawnSync(keytool, ['-J-Xmx64m', '-J-Duser.language=en', '-J-Duser.country=US', ...args],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr || r.stdout || String(r.error));
  return r.stdout;
}
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'java-truststore-test-'));
  t.after(async () => {
    const { cleanupOwnedDirectory } = await api();
    cleanupOwnedDirectory(path.dirname(dir), path.basename(dir));
  });
  return dir;
}
function makeStore(dir, clean = false) {
  const store = path.join(dir, 'cacerts');
  const entries = clean ? [['allowed-anchor', 'isrgrootx1.pem']] : [
    ['vendor-renamed-ecc', 'emsigneccrootcag3.pem'], ['vendor-renamed-aaa', 'comodoaaaca.pem'],
    ['emsign-ecc-root-ca-g3-name-is-not-identity', 'isrgrootx1.pem']];
  for (const [alias, file] of entries) kt(['-importcert', '-noprompt', '-storetype', 'JKS',
    '-storepass', 'changeit', '-keystore', store, '-alias', alias, '-file', path.join(fixtures, file)]);
  return store;
}
async function api() { return import(pathToFileURL(utility).href); }
function cli(args, env = {}) {
  return spawnSync(process.execPath, [utility, ...args], { encoding: 'utf8', timeout: 60000,
    env: { ...process.env, GITHUB_ACTIONS: '', ...env } });
}

test('owned cleanup rejects redirected junctions and wrong names without deleting external sentinel', async t => {
  const dir = temp(t), external = temp(t);
  const { cleanupOwnedDirectory } = await api();
  const sentinel = path.join(external, 'sentinel'); fs.writeFileSync(sentinel, 'keep');
  const target = path.join(dir, 'owned');
  fs.symlinkSync(external, target, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => cleanupOwnedDirectory(dir, 'owned'), /symbolic|reparse|redirect/i);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
  assert.ok(fs.lstatSync(target).isSymbolicLink());
  assert.throws(() => cleanupOwnedDirectory(dir, '../outside'), /name|owned|parent/i);
  fs.unlinkSync(target);
  fs.mkdirSync(target);
  const nested = path.join(target, 'nested');
  fs.symlinkSync(external, nested, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => cleanupOwnedDirectory(dir, 'owned'), /symbolic|reparse|redirect/i);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
  fs.unlinkSync(nested);
  cleanupOwnedDirectory(dir, 'owned');
  assert.equal(fs.existsSync(target), false);
});

test('actual keytool refuses blocked-only and empty stores before publishing a copy', async t => {
  const dir = temp(t), source = makeStore(dir);
  const { hardenCopy } = await api();
  kt(['-delete', '-keystore', source, '-storepass', 'changeit', '-alias', 'emsign-ecc-root-ca-g3-name-is-not-identity']);
  const output = path.join(dir, 'out'), before = hash(source);
  assert.throws(() => hardenCopy({ keytool, source, output }), /retained|anchor|empty/i);
  assert.equal(hash(source), before); assert.equal(fs.existsSync(output), false);
  for (const alias of ['vendor-renamed-ecc', 'vendor-renamed-aaa'])
    kt(['-delete', '-keystore', source, '-storepass', 'changeit', '-alias', alias]);
  const emptyHash = hash(source);
  assert.throws(() => hardenCopy({ keytool, source, output }), /retained|anchor|empty/i);
  assert.equal(hash(source), emptyHash); assert.equal(fs.existsSync(output), false);
});

test('CI rejects unverified launcher and runtime overrides before accessing paths without leaking values', async () => {
  const { runCi } = await api();
  for (const name of ['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'GRADLE_OPTS', 'JAVA_OPTS',
    'GRADLE_HOME', 'GRADLE_JAVA_HOME', 'JAVACMD', 'ORG_GRADLE_PROJECT_org.gradle.java.home',
    'ORG_GRADLE_PROJECT_systemProp.javax.net.ssl.trustStore']) {
    assert.throws(() => runCi({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'Hatsunama/Caption-Studio',
      [name]: '-Djavax.net.ssl.trustStore=private-do-not-log' }), error =>
      /ambient|override|launcher/i.test(error.message) && !error.message.includes('private-do-not-log'), name);
  }
});

test('Gradle property security overrides are rejected including escaped keys and continuations', async () => {
  const { gradleProperties } = await api();
  for (const entry of ['systemProp.javax.net.ssl.trustStore=/external',
    'systemProp.java.security.properties=/external', 'systemProp.jdk.security.provider.preferred=evil',
    'systemProp.gradle.user.home=/external', 'systemProp.user.home=/external',
    'systemProp.org.gradle.java.home=/external', 'org.gradle.jvmargs=-Djavax.net.ssl.trustStore=/external',
    'systemProp.javax.net.ssl.trust\\u0053tore : /external',
    'systemProp.javax.net.ssl.trust\\\n  Store=/external',
    'org.gradle.jvmargs=-Xmx64m \\\n -Djava.security.properties=/external']) {
    assert.throws(() => gradleProperties(`private.token=do-not-log\r\n${entry}\n`), error =>
      /security|override|launcher/i.test(error.message) && !error.message.includes('do-not-log'), entry);
  }
  const safe = '\ufeffprivate.token=do-not-log\r\n# systemProp.javax.net.ssl.trustStore=comment\r\norg.gradle.jvmargs=-Xmx64m\r\n';
  assert.ok(gradleProperties(safe).startsWith(safe));
});

test('public fixtures reproduce both blocked anchors under unrelated aliases before hardening', t => {
  const store = makeStore(temp(t));
  const listing = kt(['-list', '-rfc', '-keystore', store, '-storepass', 'changeit']);
  const fingerprints = [...listing.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)]
    .map(([pem]) => new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase());
  assert.equal(fingerprints.length, 3);
  for (const fingerprint of blocked) assert.ok(fingerprints.includes(fingerprint));
});

test('actual keytool removes exact blocked DER hashes, preserves retained alias/DER, and is idempotent', async t => {
  const dir = temp(t), source = makeStore(dir), before = hash(source);
  const { hardenCopy, auditStore } = await api();
  const original = auditStore(keytool, source);
  const output = path.join(dir, 'hardened');
  const result = hardenCopy({ keytool, source, output });
  assert.equal(result.removed, 2);
  assert.equal(result.retained, 1);
  assert.equal(hash(source), before);
  const retained = auditStore(keytool, output);
  assert.deepEqual(retained, original.filter(e => !blocked.includes(e.sha256)));
  const again = path.join(dir, 'again');
  assert.equal(hardenCopy({ keytool, source: output, output: again }).removed, 0);
  assert.equal(hash(again), hash(output));
  assert.throws(() => hardenCopy({ keytool, source, output }), /exist/i);
  assert.throws(() => hardenCopy({ keytool, source, output: source }), /exist|same/i);
});

test('already clean store is byte-identical; malformed input and failed keytool never fall back', async t => {
  const dir = temp(t), source = makeStore(dir, true);
  const { hardenCopy } = await api();
  const output = path.join(dir, 'clean');
  assert.equal(hardenCopy({ keytool, source, output }).removed, 0);
  assert.equal(hash(source), hash(output));
  const corrupt = path.join(dir, 'corrupt'); fs.writeFileSync(corrupt, 'not a keystore');
  const badOutput = path.join(dir, 'bad-output');
  assert.throws(() => hardenCopy({ keytool, source: corrupt, output: badOutput }));
  assert.equal(fs.existsSync(badOutput), false);
  assert.throws(() => hardenCopy({ keytool: path.join(dir, 'missing-keytool'), source, output: badOutput }));
  assert.equal(fs.existsSync(badOutput), false);
  const wrongPassword = path.join(dir, 'password-store');
  kt(['-importcert', '-noprompt', '-storetype', 'JKS', '-storepass', 'different-password',
    '-keystore', wrongPassword, '-alias', 'public', '-file', path.join(fixtures, 'isrgrootx1.pem')]);
  assert.throws(() => hardenCopy({ keytool, source: wrongPassword, output: badOutput }));
  assert.equal(fs.existsSync(badOutput), false);
});

test('copy publication failure cleans owned temporary files and preserves source', async t => {
  const dir = temp(t), source = makeStore(dir, true), before = hash(source);
  const { hardenCopy } = await api();
  const output = path.join(dir, 'output');
  assert.throws(() => hardenCopy({ keytool, source, output, io: {
    ...fs, linkSync() { throw new Error('injected publication failure'); }
  } }), /publication failure/);
  assert.equal(hash(source), before);
  assert.deepEqual(fs.readdirSync(dir), ['cacerts']);
});

test('symlink/reparse and overwrite guards reject source, destination and ancestor escapes', async t => {
  const dir = temp(t), source = makeStore(dir, true);
  const { hardenCopy } = await api();
  const realDir = path.join(dir, 'real'); fs.mkdirSync(realDir);
  const linkedDir = path.join(dir, 'linked');
  fs.symlinkSync(realDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
  try {
  assert.throws(() => hardenCopy({ keytool, source, output: path.join(linkedDir, 'out') }), /symbolic|reparse/i);
  fs.copyFileSync(source, path.join(realDir, 'source'));
  assert.throws(() => hardenCopy({ keytool, source: path.join(linkedDir, 'source'), output: path.join(dir, 'out') }), /symbolic|reparse/i);
  // Directory junctions work on unprivileged Windows; file symlinks need developer mode.
  try { fs.symlinkSync(source, path.join(dir, 'file-link')); } catch (e) {
    if (e.code !== 'EPERM') throw e;
    t.diagnostic('file symlink creation unavailable; ancestor junction guards were exercised'); return;
  }
  assert.throws(() => hardenCopy({ keytool, source: path.join(dir, 'file-link'), output: path.join(dir, 'out') }), /symbolic|reparse/i);
  assert.throws(() => hardenCopy({ keytool, source, output: path.join(dir, 'file-link') }));
  } finally {
    for (const link of [path.join(dir, 'file-link'), linkedDir]) {
      try { fs.unlinkSync(link); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
});

test('CLI refuses non-CI in-place use, unknown flags, and missing runtime; errors are JSON', t => {
  const dir = temp(t);
  for (const args of [['--ci'], ['--in-place'], ['--prepare', '--java-home', dir, '--output', path.join(dir, 'out')],
    ['--prepare', '--java-home', dir, '--output', path.join(dir, 'out'), '--unknown']]) {
    const r = cli(args); assert.notEqual(r.status, 0); assert.equal(r.stdout, '');
    assert.equal(JSON.parse(r.stderr).ok, false);
  }
});

test('CI rejects wrong repository, missing JDK21, and homes outside tool cache before writes', async t => {
  const dir = temp(t), { runCi } = await api();
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'Hatsunama/Caption-Studio',
    RUNNER_TEMP: dir, RUNNER_TOOL_CACHE: dir, HOME: dir, JAVA_HOME_17_X64: dir };
  assert.throws(() => runCi({ ...env, GITHUB_REPOSITORY: 'other/repo' }));
  assert.throws(() => runCi(env));
  assert.throws(() => runCi({ ...env, JAVA_HOME_21_X64: path.dirname(dir) }));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('two-store transaction backs up first, rolls back replacement failure, and preserves Gradle secrets', async t => {
  const dir = temp(t), oneDir = path.join(dir, 'one'), twoDir = path.join(dir, 'two');
  fs.mkdirSync(oneDir); fs.mkdirSync(twoDir);
  const source = makeStore(oneDir), second = makeStore(twoDir, true);
  const before = [hash(source), hash(second)];
  const { commitStores, hardenCopy, gradleProperties } = await api();
  const staged = [source, second].map((p, i) => {
    const output = path.join(dir, `staged-${i}`); hardenCopy({ keytool, source: p, output });
    return { source: p, staged: output, originalHash: hash(p), keytool };
  });
  const backupDir = path.join(dir, 'backups'); fs.mkdirSync(backupDir);
  assert.throws(() => commitStores(staged, backupDir, { ...fs,
    copyFileSync() { throw new Error('injected backup failure'); }
  }), /backup failure/);
  assert.deepEqual([hash(source), hash(second)], before);
  let copies = 0;
  assert.throws(() => commitStores(staged, backupDir, { ...fs,
    copyFileSync(...args) { if (++copies === 4) throw new Error('injected replacement failure'); return fs.copyFileSync(...args); }
  }), /replacement failure/);
  assert.deepEqual([hash(source), hash(second)], before);
  commitStores(staged, backupDir);
  assert.equal((await api()).auditStore(keytool, source).length, 1);
  const old = 'private.token=do-not-log\norg.gradle.java.installations.auto-detect=true\n';
  const updated = gradleProperties(old);
  assert.ok(updated.startsWith(old));
  assert.match(updated, /org.gradle.java.installations.fromEnv=JAVA_HOME_17_X64,JAVA_HOME_21_X64/);
  assert.match(updated, /org.gradle.java.installations.auto-detect=false/);
  assert.match(updated, /org.gradle.java.installations.auto-download=false/);
  assert.equal(gradleProperties(updated), updated);
});

test('local --prepare CLI audits a real runtime, preserves its source, and refuses a second publication', async t => {
  const dir = temp(t), home = path.dirname(path.dirname(keytool));
  const source = path.join(home, 'lib/security/cacerts'), before = hash(source);
  const output = path.join(dir, 'local-copy');
  const first = cli(['--prepare', '--java-home', home, '--output', output]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  const report = JSON.parse(first.stdout);
  assert.equal(report.ok, true); assert.equal(report.mode, 'prepare');
  assert.equal(hash(source), before);
  const { auditStore } = await api();
  const original = auditStore(keytool, source);
  const retained = original.filter(e => !blocked.includes(e.sha256));
  assert.deepEqual(auditStore(keytool, output), retained);
  assert.equal(report.retained, retained.length);
  assert.equal(report.removed, original.length - retained.length);
  const repeat = cli(['--prepare', '--java-home', home, '--output', output]);
  assert.notEqual(repeat.status, 0); assert.equal(repeat.stdout, '');
  assert.equal(hash(source), before);
});

test('failed temporary cleanup retains complete output and unchanged source', async t => {
  const dir = temp(t), source = makeStore(dir, true), before = hash(source);
  const output = path.join(dir, 'complete-output');
  const { hardenCopy } = await api();
  assert.throws(() => hardenCopy({ keytool, source, output, io: {
    ...fs, rmSync() { throw new Error('injected cleanup failure'); }
  } }), /cleanup failed/);
  assert.equal(hash(source), before);
  assert.equal(hash(output), before);
  assert.equal(fs.readdirSync(dir).filter(name => name.startsWith('.java-truststore-')).length, 1);
});

test('corrupted backup cannot reach replacement; properties transaction preserves secret bytes', async t => {
  const dir = temp(t), { commitStores, gradleProperties } = await api();
  const source = path.join(dir, 'gradle.properties');
  const original = '\ufeffprivate.token=do-not-log\r\norg.gradle.java.installations.paths=/untrusted/jdk\r\n';
  fs.writeFileSync(source, original);
  const before = hash(source), staged = path.join(dir, 'staged');
  const updated = gradleProperties(original, 'C:\\private job\\jdk-17');
  fs.writeFileSync(staged, updated);
  const backupDir = path.join(dir, 'backups'); fs.mkdirSync(backupDir);
  const records = [{ source, staged, originalHash: before }];
  assert.throws(() => commitStores(records, backupDir, { ...fs,
    copyFileSync(from, to, flags) { fs.copyFileSync(from, to, flags); fs.writeFileSync(to, 'corrupted-backup'); }
  }), /Backup integrity/);
  assert.equal(hash(source), before);
  const backups = commitStores(records, backupDir);
  assert.equal(fs.readFileSync(source, 'utf8'), updated);
  assert.equal(hash(backups[0].backup), before);
  assert.ok(fs.readFileSync(source).subarray(0, Buffer.byteLength(original)).equals(Buffer.from(original)));
  assert.match(updated, /org.gradle.java.installations.paths=\n/);
  assert.match(updated, /org.gradle.java.home=C\\u003a\\u005cprivate\\u0020job\\u005cjdk-17/);
});

// Full CI orchestration is exercised with synthetic disposable runtime directories
// on POSIX. Their launchers delegate to actual keytool, without copying a JDK or
// touching its cacerts. This tests selection/gates, not vendor version provenance.
test('CI CLI hardens both runtime stores, preserves active JDK and properties, and repeats cleanly',
  { skip: process.platform === 'win32' ? 'POSIX fixture launchers; run this case on the GitHub Linux runner' : false }, async t => {
    const dir = temp(t), cache = path.join(dir, 'tool-cache'), runnerTemp = path.join(dir, 'runner-temp');
    const home = path.join(dir, 'private-home');
    for (const p of [cache, runnerTemp, home]) fs.mkdirSync(p);
    const homes = [17, 21].map(major => {
      const jdk = path.join(cache, `jdk-${major}`);
      fs.mkdirSync(path.join(jdk, 'lib/security'), { recursive: true });
      fs.mkdirSync(path.join(jdk, 'bin'));
      const fixtureDir = path.join(dir, `fixture-${major}`); fs.mkdirSync(fixtureDir);
      fs.renameSync(makeStore(fixtureDir), path.join(jdk, 'lib/security/cacerts'));
      fs.writeFileSync(path.join(jdk, 'release'), `JAVA_VERSION="${major}.0.1"\n`);
      const quoted = `'${keytool.replaceAll("'", "'\\''")}'`;
      fs.writeFileSync(path.join(jdk, 'bin/keytool'), `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: 0o700 });
      return jdk;
    });
    fs.mkdirSync(path.join(home, '.gradle'));
    const properties = path.join(home, '.gradle/gradle.properties');
    const secret = 'private.token=do-not-log\norg.gradle.java.home=/third/jdk\n';
    fs.writeFileSync(properties, secret);
    const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'Hatsunama/Caption-Studio',
      RUNNER_TOOL_CACHE: cache, RUNNER_TEMP: runnerTemp, HOME: home, GRADLE_USER_HOME: '',
      JAVA_TOOL_OPTIONS: '', JDK_JAVA_OPTIONS: '', _JAVA_OPTIONS: '', GRADLE_OPTS: '', JAVA_OPTS: '',
      JAVA_HOME_17_X64: homes[0], JAVA_HOME_21_X64: homes[1], JAVA_HOME: homes[1] };
    const stores = homes.map(jdk => path.join(jdk, 'lib/security/cacerts'));
    const originals = stores.map(hash), propertiesHash = hash(properties);
    for (const option of ['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'GRADLE_OPTS']) {
      const refused = cli(['--ci'], { ...env, [option]: '-Djavax.net.ssl.trustStore=/private-do-not-log' });
      assert.notEqual(refused.status, 0, option);
      assert.equal(refused.stdout, '');
      assert.match(JSON.parse(refused.stderr).error, /ambient|override|launcher/i);
      assert.equal(refused.stderr.includes('private-do-not-log'), false);
      assert.deepEqual(stores.map(hash), originals);
      assert.equal(hash(properties), propertiesHash);
      assert.deepEqual(fs.readdirSync(runnerTemp), []);
    }
    fs.writeFileSync(properties, secret + 'systemProp.javax.net.ssl.trustStore=/private-do-not-log\n');
    const unsafeHash = hash(properties), refused = cli(['--ci'], env);
    assert.notEqual(refused.status, 0);
    assert.equal(refused.stdout, '');
    assert.equal(refused.stderr.includes('private-do-not-log'), false);
    assert.deepEqual(stores.map(hash), originals);
    assert.equal(hash(properties), unsafeHash);
    assert.deepEqual(fs.readdirSync(runnerTemp), []);
    fs.writeFileSync(properties, secret);
    const first = cli(['--ci'], env);
    assert.equal(first.status, 0, first.stderr); assert.equal(first.stderr, '');
    assert.equal(first.stdout.includes('do-not-log'), false);
    const report = JSON.parse(first.stdout);
    assert.equal(report.activeJavaHome, homes[1]);
    assert.deepEqual(report.runtimes.map(r => [r.major, r.removed, r.retained]), [[17, 2, 1], [21, 2, 1]]);
    const { auditStore } = await api();
    for (const jdk of homes) assert.equal(auditStore(keytool, path.join(jdk, 'lib/security/cacerts')).length, 1);
    const props = fs.readFileSync(properties, 'utf8'); assert.ok(props.startsWith(secret));
    const second = cli(['--ci'], { ...env, JAVA_HOME: homes[0] });
    assert.equal(second.status, 0, second.stderr);
    const repeated = JSON.parse(second.stdout);
    assert.equal(repeated.activeJavaHome, homes[0]);
    assert.deepEqual(repeated.runtimes.map(r => r.removed), [0, 0]);
    assert.ok(fs.readFileSync(properties, 'utf8').startsWith(props));
  });
