import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, access, copyFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as gate from '../scripts/unsigned-store-build.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const original = { expo: { name: 'source', version: '1.4.101', android: {
  package: 'com.xmilo_at_your_side.caption_studio', versionCode: 101,
}, extra: { preserved: true } } };
const context = { GITHUB_REPOSITORY: 'Hatsunama/Caption-Studio', GITHUB_REPOSITORY_OWNER: 'Hatsunama',
  GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_ACTOR: 'Hatsunama',
  GITHUB_TRIGGERING_ACTOR: 'Hatsunama', GITHUB_SHA: 'a'.repeat(40),
  GITHUB_WORKFLOW_REF: 'Hatsunama/Caption-Studio/.github/workflows/unsigned-store-build.yml@refs/heads/main',
  GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
const release = () => gate.parseRelease('1.4.136', '148', original);
const identity = () => ({ package: original.expo.android.package, version: '1.4.136',
  versionCode: '148', minSdk: '24', targetSdk: '36' });
const abis = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'];
const entries = (prefix) => abis.flatMap((abi) => ['libreactnative.so', 'librnwhisper.so',
  ...(['arm64-v8a', 'x86_64'].includes(abi) ? ['liblitertlm_jni.so'] : [])].map((lib) => `${prefix}/${abi}/${lib}`));
function evidence() {
  return { apkIdentity: identity(), aabIdentity: identity(),
    apkEntries: ['AndroidManifest.xml', ...entries('lib')],
    aabEntries: ['base/manifest/AndroidManifest.xml', gate.mappingEntry, ...entries('base/lib')],
    apkJar: 'jar is unsigned', aabJar: 'jar is unsigned', apkManifest: '', aabManifest: '',
    apkSigningBlock: false, bundleConfig: { optimizations: { uncompressNativeLibraries: { alignment: 'PAGE_ALIGNMENT_16K' } } },
    bundletool: true, zipalign16k: true, apkElf16k: true, aabElf16k: true,
    payloadHashes: { apk: sha('unsigned apk bytes'), aab: sha('unsigned aab bytes'), mapping: sha('exact R8 map') },
    generatedMapping: Buffer.from('exact R8 map'), embeddedMapping: Buffer.from('exact R8 map') };
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'unsigned-store-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {};
  for (const [name, bytes] of Object.entries({ apk: 'unsigned apk bytes', aab: 'unsigned aab bytes', mapping: 'exact R8 map' })) {
    files[name] = path.join(root, name);
    await writeFile(files[name], bytes);
  }
  return { root, files, output: path.join(root, 'result'), release: release(),
    source: { sourceCommit: context.GITHUB_SHA, sourceTree: 'b'.repeat(40) }, context, evidence: evidence() };
}

test('canonical inputs use shared package/version validation', () => {
  assert.equal(release().configured.expo.extra.preserved, true);
  for (const version of ['1.04.136', '1.4.136-beta', ' 1.4.136', '1.4.100'])
    assert.throws(() => gate.parseRelease(version, '148', original));
  for (const code of ['0148', '148.0', '0', '-1', '2100000001', '1e3', ''])
    assert.throws(() => gate.parseRelease('1.4.136', code, original));
  assert.throws(() => gate.parseRelease('1.4.136', '148', { expo: { android: { package: 'attacker' } } }));
});

test('manual owner main gate rejects each altered authority field and signing environment', () => {
  gate.assertContext(context);
  for (const name of Object.keys(context)) assert.throws(() => gate.assertContext({ ...context, [name]: 'wrong' }), name);
  for (const name of ['CAPTION_STUDIO_PLAY_KEY_PASSWORD', 'ORG_GRADLE_PROJECT_CAPTION_STUDIO_RELEASE_STORE_FILE', 'KEYSTORE_BASE64'])
    assert.throws(() => gate.assertContext({ ...context, [name]: '' }), /refuses signing/);
});

test('source is actual HEAD/tree and stamp must equal shared transformation', async (t) => {
  const { root } = await fixture(t);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  await writeFile(path.join(root, 'app.json'), JSON.stringify(original));
  await writeFile(path.join(root, 'source.txt'), 'trusted');
  git('add', 'app.json', 'source.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  const env = { ...context, GITHUB_SHA: git('rev-parse', 'HEAD') };
  const before = await gate.inspectSource(root, release(), false, env);
  assert.equal(before.sourceTree, git('rev-parse', 'HEAD^{tree}'));
  await assert.rejects(gate.inspectSource(root, release(), false, context));
  await writeFile(path.join(root, 'app.json'), JSON.stringify(release().configured));
  await gate.inspectSource(root, release(), true, env);
  await writeFile(path.join(root, 'app.json'), JSON.stringify({ ...release().configured, injected: true }));
  await assert.rejects(gate.inspectSource(root, release(), true, env));
  await writeFile(path.join(root, 'app.json'), JSON.stringify(release().configured));
  await writeFile(path.join(root, 'source.txt'), 'changed');
  await assert.rejects(gate.inspectSource(root, release(), true, env));
});

test('payload checks reject identity, signatures, missing ABI, mapping and alignment failures', () => {
  gate.assertPayload(evidence(), release());
  const mutations = [
    (e) => { e.apkIdentity.minSdk = '23'; }, (e) => { e.aabIdentity.targetSdk = '35'; },
    (e) => { e.apkIdentity.package = 'other'; }, (e) => { e.aabIdentity.versionCode = '147'; },
    (e) => { e.apkEntries.push('META-INF/RELEASE.RSA'); }, (e) => { e.aabJar = 'jar verified.'; },
    (e) => { e.apkManifest = 'SHA-256-Digest: forbidden'; }, (e) => { e.apkSigningBlock = true; },
    (e) => { e.aabEntries.pop(); }, (e) => { e.apkEntries.push(e.apkEntries[0]); },
    (e) => { e.embeddedMapping = Buffer.from('wrong'); }, (e) => { e.generatedMapping = Buffer.alloc(0); },
    (e) => { e.aabEntries = e.aabEntries.filter((name) => name !== gate.mappingEntry); },
    (e) => { e.bundleConfig = {}; },
    ...['bundletool', 'zipalign16k', 'apkElf16k', 'aabElf16k'].map((key) => (e) => { delete e[key]; }),
  ];
  for (const mutate of mutations) { const e = evidence(); mutate(e); assert.throws(() => gate.assertPayload(e, release())); }
});

test('publication creates a missing parent after validation and preserves exclusive output ownership', async (t) => {
  const f = await fixture(t);
  f.output = path.join(f.root, 'dist', 'unsigned-store');
  await assert.rejects(access(path.dirname(f.output)));
  const result = await gate.publishVerified(f);
  const manifest = await readFile(path.join(f.output, 'provenance.json'));
  assert.deepEqual(JSON.parse(manifest), result);
  assert.deepEqual((await readdir(f.output)).sort(), ['caption-studio-UNSIGNED-not-installable.aab',
    'caption-studio-UNSIGNED-not-installable.apk', 'mapping.txt', 'provenance.json'].sort());
  await assert.rejects(gate.publishVerified(f), /EEXIST/);
  assert.deepEqual(await readFile(path.join(f.output, 'provenance.json')), manifest);
  const invalid = await fixture(t);
  invalid.output = path.join(invalid.root, 'dist', 'unsigned-store');
  invalid.evidence.bundletool = false;
  await assert.rejects(gate.publishVerified(invalid));
  await assert.rejects(access(path.dirname(invalid.output)));
  const failed = await fixture(t);
  failed.output = path.join(failed.root, 'dist', 'unsigned-store');
  await assert.rejects(gate.publishVerified(failed, { copy: async () => { throw Error('synthetic copy failure'); } }), /synthetic copy failure/);
  await assert.rejects(access(failed.output));
  assert.deepEqual(await readdir(path.dirname(failed.output)), []);
  const blocked = await fixture(t);
  const parent = path.join(blocked.root, 'dist');
  await writeFile(parent, 'existing caller-owned file');
  blocked.output = path.join(parent, 'unsigned-store');
  await assert.rejects(gate.publishVerified(blocked));
  assert.equal(await readFile(parent, 'utf8'), 'existing caller-owned file');
});

test('publication verifies real copied bytes and binds unsigned provenance to source and identity', async (t) => {
  const f = await fixture(t);
  const result = await gate.publishVerified(f);
  const manifest = JSON.parse(await readFile(path.join(f.output, 'provenance.json')));
  assert.deepEqual(manifest, result);
  assert.equal(manifest.sourceCommit, context.GITHUB_SHA);
  assert.equal(manifest.sourceTree, f.source.sourceTree);
  assert.equal(manifest.version, '1.4.136');
  assert.deepEqual(manifest.signing, { status: 'unsigned', certificateSha256: null, storeReady: false, installable: false });
  for (const [key, value] of Object.entries(manifest.payloads)) {
    const bytes = await readFile(path.join(f.output, value.name));
    assert.equal(value.sha256, sha(bytes));
    assert.equal(value.sha256, sha(await readFile(f.files[key])));
    assert.equal(value.bytes, bytes.length);
  }
  await assert.rejects(gate.publishVerified(f), /EEXIST/);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.output, 'provenance.json'))), manifest);
});

test('missing inputs, copy errors, corruption or invalid evidence never publish successful provenance', async (t) => {
  for (const failure of ['missing', 'copy', 'corrupt', 'mapping', 'evidence', 'source', 'changed-apk', 'changed-aab']) {
    const f = await fixture(t);
    if (failure === 'missing') await rm(f.files.aab);
    if (failure === 'mapping') await writeFile(f.files.mapping, 'not embedded');
    if (failure === 'evidence') f.evidence.bundletool = false;
    if (failure === 'source') f.source.sourceCommit = 'c'.repeat(40);
    if (failure === 'changed-apk') await writeFile(f.files.apk, 'changed after native verification');
    if (failure === 'changed-aab') await writeFile(f.files.aab, 'changed after native verification');
    const copy = failure === 'copy' ? async () => { throw new Error('copy failed'); }
      : failure === 'corrupt' ? async (src, dst, flags) => { await copyFile(src, dst, flags); await writeFile(dst, 'corrupt'); }
        : copyFile;
    await assert.rejects(gate.publishVerified(f, { copy }));
    await assert.rejects(access(path.join(f.output, 'provenance.json')));
  }
});

test('tool adapter binds parsed synthetic identities, exact mapping and successful commands to publication', async (t) => {
  const f = await fixture(t);
  const calls = [];
  const options = { source: f.root, files: f.files, bundletool: path.join(f.root, 'bundletool.jar'),
    objdump: 'llvm-objdump', buildTools: f.root, temporary: f.root };
  const run = (program, args, binary) => {
    calls.push([program, args]);
    if (program === 'python3') return args[1].includes('APK Sig Block 42') ? 'unsigned\n' : '';
    if (program === 'jarsigner') return 'jar is unsigned';
    if (program === 'unzip') {
      if (args[0] === '-Z') return (args.at(-1) === f.files.apk ? evidence().apkEntries : evidence().aabEntries).join('\n');
      assert.equal(binary, true);
      return Buffer.from('exact R8 map');
    }
    if (path.basename(program) === 'aapt') return "package: name='com.xmilo_at_your_side.caption_studio' versionCode='148' versionName='1.4.136'\nsdkVersion:'24'\ntargetSdkVersion:'36'\n";
    if (program === 'java' && args.includes('manifest')) {
      const xpath = args.at(-1);
      return Object.entries({ '@package': identity().package, '@android:versionName': '1.4.136',
        '@android:versionCode': '148', '@android:minSdkVersion': '24', '@android:targetSdkVersion': '36' })
        .find(([suffix]) => xpath.endsWith(suffix))[1];
    }
    if (program === 'java' && args.includes('config')) return JSON.stringify(evidence().bundleConfig);
    return '';
  };
  const collected = await gate.inspectPayloads(options, run);
  gate.assertPayload(collected, f.release);
  await gate.publishVerified({ ...f, evidence: collected });
  assert.ok(calls.some(([program, args]) => program === 'java' && args.includes('validate')));
  assert.ok(calls.some(([program, args]) => path.basename(program) === 'zipalign' && args.join(' ') === `-c -P 16 -v 4 ${f.files.apk}`));
  assert.equal(calls.filter(([program]) => program === 'bash').length, 2);
  // Every native tool failure is fatal before output/provenance publication.
  const commandCount = calls.length;
  for (let index = 0; index < commandCount; index++) {
    let call = 0;
    await assert.rejects(gate.inspectPayloads(options, (program, args, binary) => {
      if (call++ === index) throw new Error('synthetic tool error');
      return run(program, args, binary);
    }), /synthetic tool error/);
  }
});

test('bundletool checksum is enforced before any archive tools execute', async (t) => {
  const { root } = await fixture(t);
  const bundletool = path.join(root, 'bundletool.jar');
  await writeFile(bundletool, 'untrusted tool');
  let called = false;
  await assert.rejects(gate.collectEvidence({ bundletool }, () => { called = true; }), /checksum mismatch/);
  assert.equal(called, false);
});

test('actual ZIP fixtures detect APK signing blocks and reject symlinks or malformed ZIPs', async (t) => {
  const { root } = await fixture(t);
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const run = (_program, args) => execFileSync(python, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const clean = path.join(root, 'clean.zip');
  const signed = path.join(root, 'signed.zip');
  const symlink = path.join(root, 'symlink.zip');
  run('python3', ['-c', `import sys,zipfile,struct
clean,signed,symlink=sys.argv[1:]
with zipfile.ZipFile(clean,'x') as z: z.writestr('AndroidManifest.xml',b'fixture')
with open(clean,'rb') as f: b=f.read()
e=b.rfind(b'PK\\x05\\x06')
cd=struct.unpack_from('<I',b,e+16)[0]
block=struct.pack('<QQ',24,24)+b'APK Sig Block 42'
b=bytearray(b[:cd]+block+b[cd:])
struct.pack_into('<I',b,e+len(block)+16,cd+len(block))
with open(signed,'xb') as f: f.write(b)
with zipfile.ZipFile(symlink,'x') as z:
 i=zipfile.ZipInfo('link'); i.create_system=3; i.external_attr=(0o120777<<16)
 z.writestr(i,'target')
`, clean, signed, symlink]);
  assert.equal(gate.inspectZip(clean, run), false);
  assert.equal(gate.inspectZip(signed, run), true);
  assert.throws(() => gate.inspectZip(symlink, run));
  assert.throws(() => gate.inspectZip(path.join(root, 'apk'), run));
});
