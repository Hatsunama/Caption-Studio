import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { readFile, writeFile, lstat, realpath, rm, copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundletoolSha256, parseRelease } from '../unsigned-store-build.mjs';
import { assertUnsigned } from '../verify-unsigned-play-aab.mjs';
import { assertAndroidAbiCoverage } from '../verify-android-abi.mjs';
import { parseSigningCertificate, validateReleaseMetadata } from '../configure-sidecar-release.mjs';
export { bundletoolSha256 };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const contract = JSON.parse(await readFile(path.join(root, 'config/local-signing-contract.json'), 'utf8'));
const product = JSON.parse(await readFile(path.join(root, 'config/product-contract.json'), 'utf8'));
assert.equal(contract.roles.apk, product.android.release.signingCertificateSha256);
assert.equal(contract.roles.aab, '50d77dfe5b3239d2fa86856613cb193898662a6a9dad2103812ea099ba102ddb');
assert.notEqual(contract.roles.apk, contract.roles.aab);
export const inputNames = { apk: 'caption-studio-UNSIGNED-not-installable.apk', aab: 'caption-studio-UNSIGNED-not-installable.aab', mapping: 'mapping.txt' };
const outputNames = { apk: 'caption-studio-android.apk', aab: 'caption-studio-play-android.aab', mapping: 'mapping.txt' };
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function hashFile(file) {
  const h = createHash('sha256');
  for await (const bytes of createReadStream(file)) h.update(bytes);
  return h.digest('hex');
}
export function assertLocal(env = process.env) {
  assert.ok(!Object.keys(env).some(k => k.toUpperCase() === 'GITHUB_ACTIONS'), 'Cloud execution refused');
}
export function assertCertificate(role, der) {
  assert.ok(Object.hasOwn(contract.roles, role), 'Unknown signing role');
  assert.equal(sha(der), contract.roles[role], 'Wrong production certificate');
}
export function assertProvenance(p, expectedCommit, expectedRunId) {
  assert.match(expectedCommit, /^[0-9a-f]{40}$/);
  assert.match(expectedRunId, /^[1-9][0-9]*$/);
  assert.equal(p.schemaVersion, 1);
  assert.equal(p.repository, product.repository);
  assert.equal(p.sourceCommit, expectedCommit, 'Unexpected source commit');
  assert.equal(p.runId, expectedRunId, 'Unexpected source run');
  assert.match(p.sourceTree ?? '', /^[0-9a-f]{40}$/);
  assert.match(p.runAttempt ?? '', /^[1-9][0-9]*$/);
  assert.equal(p.sourceRef, 'refs/heads/main');
  assert.equal(p.workflowRef, `${product.repository}/.github/workflows/unsigned-store-build.yml@refs/heads/main`);
  assert.deepEqual(p.signing, { status: 'unsigned', certificateSha256: null, storeReady: false, installable: false });
  assert.equal(p.package, product.android.release.package);
  parseRelease(p.version, String(p.versionCode), { expo: { android: { package: p.package } } });
  assert.ok(Number.isSafeInteger(p.versionCode) && p.versionCode > contract.publishedBaseline.versionCode, 'Future release code required');
  const v = p.version.split('.').map(Number), baseline = contract.publishedBaseline.version.split('.').map(Number);
  assert.ok(v.some((n, i) => n > baseline[i] && v.slice(0, i).every((x, j) => x === baseline[j])), 'Future version required');
  assert.deepEqual(p.checks, { bundletoolVersion: '1.18.3', bundletoolSha256, minSdk: 24, targetSdk: 36,
    abi: true, translation64BitOnly: true, apkZipalign16k: true, apkElf16k: true, aabElf16k: true,
    bundlePageAlignment: 'PAGE_ALIGNMENT_16K', unsignedArchives: true, exactEmbeddedMapping: true });
  assert.deepEqual(Object.keys(p.payloads).sort(), ['aab', 'apk', 'mapping']);
  for (const k of Object.keys(inputNames)) {
    assert.equal(p.payloads[k].name, inputNames[k]);
    assert.match(p.payloads[k].sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(p.payloads[k].bytes) && p.payloads[k].bytes > 0);
  }
}
async function absent(file) {
  try { await lstat(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  throw Error('Existing output refused');
}
async function noLinks(file) {
  let p = path.resolve(file);
  while (true) {
    assert.ok(!(await lstat(p)).isSymbolicLink(), 'Linked paths refused');
    const parent = path.dirname(p);
    if (parent === p) return;
    p = parent;
  }
}
const overlaps = (a, b) => { const r = path.relative(a, b); return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)); };
export async function validateInputs(files, output, expectedCommit, expectedRunId) {
  assertLocal();
  output = path.resolve(output);
  await absent(output);
  await noLinks(path.dirname(output));
  const seen = new Set();
  for (const file of Object.values(files)) {
    await noLinks(file);
    const p = await realpath(file), key = p.toLowerCase();
    assert.ok(!seen.has(key), 'Duplicate input path'); seen.add(key);
    assert.ok((await lstat(p)).isFile(), 'Regular input required');
    assert.ok(!overlaps(output.toLowerCase(), key) && !overlaps(key, output.toLowerCase()), 'Input/output overlap');
  }
  const p = JSON.parse(await readFile(files.provenance, 'utf8'));
  assertProvenance(p, expectedCommit, expectedRunId);
  for (const k of Object.keys(inputNames)) {
    assert.equal((await lstat(files[k])).size, p.payloads[k].bytes, 'Input size mismatch');
    assert.equal(await hashFile(files[k]), p.payloads[k].sha256, 'Input hash mismatch');
  }
  return p;
}
export function isSignatureMetadata(name) {
  return /^META-INF\/(?:MANIFEST\.MF|[^/]+\.(?:SF|RSA|DSA|EC)|SIG-[^/]+)$/i.test(name);
}
export function comparePayloads(before, after) {
  const payload = a => Object.fromEntries(Object.entries(a.hashes).filter(([n]) => !isSignatureMetadata(n)).sort(([a], [b]) => a.localeCompare(b)));
  assert.deepEqual(payload(after), payload(before), 'ZIP payload changed during signing');
}
// Python stdlib streams each member: no archive extraction and bounded memory.
const zipInspection = String.raw`import sys,zipfile,hashlib,json,struct,re
hashes={}; manifest=''; mapping=None
with zipfile.ZipFile(sys.argv[1]) as z:
 cd=z.start_dir
 for i in z.infolist():
  n=i.filename
  if n in hashes or re.search(r'(^/|\\|(^|/)\.\.(/|$)|[\x00-\x1f])',n) or ':' in n: raise ValueError('Unsafe ZIP')
  mode=(i.external_attr>>16)&0o170000
  if mode not in (0,0o100000,0o040000): raise ValueError('Nonregular ZIP entry')
  if i.flag_bits&1: raise ValueError('Encrypted ZIP')
  h=hashlib.sha256()
  with z.open(i) as s:
   while True:
    b=s.read(65536)
    if not b: break
    h.update(b)
  hashes[n]=h.hexdigest()
  if n.upper()=='META-INF/MANIFEST.MF':
   if i.file_size>16777216: raise ValueError('Oversize manifest')
   manifest=z.read(i).decode('utf-8')
  if n=='BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map': mapping=h.hexdigest()
  if re.match(r'^(base/)?lib/(arm64-v8a|x86_64)/[^/]+\.so$',n):
   with z.open(i) as s:
    header=s.read(64)
    if header[:4]!=b'\x7fELF' or header[5]!=1 or header[4] not in (1,2): raise ValueError('Invalid ELF')
    wide=header[4]==2
    off=struct.unpack_from('<Q' if wide else '<I',header,32 if wide else 28)[0]
    size,count=struct.unpack_from('<HH',header,54 if wide else 42)
    if size!=(56 if wide else 32) or count==0: raise ValueError('Invalid ELF table')
    s.seek(off)
    loads=0
    for _ in range(count):
     ph=s.read(size)
     if struct.unpack_from('<I',ph)[0]==1:
      loads+=1
      alignment=struct.unpack_from('<Q' if wide else '<I',ph,48 if wide else 28)[0]
      if alignment<16384 or alignment&(alignment-1): raise ValueError('ELF alignment')
    if loads==0: raise ValueError('No ELF LOAD segments')
with open(sys.argv[1],'rb') as f:
 f.seek(max(0,cd-16)); block=(cd>=16 and f.read(16)==b'APK Sig Block 42')
print(json.dumps(dict(hashes=hashes,manifest=manifest,mapping=mapping,signingBlock=block)))
`;
// Never propagate child output, argv, or process errors to a caller/log.
// Internal timeout argument is for controlled fixtures, never request/CLI data.
export async function runTool(program, args, timeoutMilliseconds = 180000) {
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: process.env.SystemRoot + '\\System32' };
  const child = spawn(program, args, { windowsHide: true, detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'], env });
  let exited = false, closed = false, failed = false, bytes = 0;
  const output = [];
  // Keep the root alive until tree termination: do not kill it before taskkill /T.
  let stopPromise;
  const stop = () => stopPromise ??= (async () => {
    failed = true;
    if (!exited && child.pid) {
      if (process.platform === 'win32') {
        await new Promise((resolve, reject) => {
          const killer = spawn(path.join(process.env.SystemRoot, 'System32/taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          const timer = setTimeout(() => { killer.kill(); reject(Error('Tree termination failed')); }, 10000);
          killer.once('error', e => { clearTimeout(timer); reject(e); });
          killer.once('close', code => { clearTimeout(timer); code === 0 || exited ? resolve() : reject(Error('Tree termination failed')); });
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
      }
    }
  })();
  let rejectStop, drainTimer;
  const stopped = new Promise((_, reject) => { rejectStop = reject; });
  const cancel = () => {
    void stop().then(() => {
      if (!closed && !drainTimer) drainTimer = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); rejectStop(Error('Output drain timed out'));
      }, 5000);
    }, rejectStop);
  };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  const timer = setTimeout(cancel, timeoutMilliseconds);
  child.stdout.on('data', b => { bytes += b.length; if (bytes > 16 * 1024 * 1024) cancel(); else output.push(b); });
  child.stderr.on('data', b => { bytes += b.length; if (bytes > 16 * 1024 * 1024) cancel(); });
  child.once('exit', () => { exited = true; });
  try {
    const code = await Promise.race([new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', code => { closed = true; resolve(code); });
    }), stopped]);
    if (stopPromise) await stopPromise;
    assert.ok(!failed && code === 0);
    return Buffer.concat(output).toString('utf8');
  } catch { throw Error('Local verification tool failed (output suppressed)'); }
  finally {
    clearTimeout(timer); clearTimeout(drainTimer); process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    if (!exited && child.pid) {
      try { await stop(); } catch { throw Error('Local verification tool failed (output suppressed)'); }
    }
  }
}
const run = runTool;
export async function inspectArchive(file, python) { return JSON.parse(await run(python, ['-c', zipInspection, file])); }
const javaFlags = ['-Xms16m', '-Xmx96m', '-XX:ActiveProcessorCount=1', '-Duser.language=en', '-Duser.country=US'];
export async function validateToolchain(o) {
  for (const file of [o.python, path.join(o.javaBin, 'java.exe'), path.join(o.javaBin, 'jarsigner.exe'),
    path.join(o.buildTools, 'aapt.exe'), path.join(o.buildTools, 'zipalign.exe'), path.join(o.buildTools, 'lib/apksigner.jar'), o.bundletool]) await noLinks(file);
  assert.equal(await hashFile(o.bundletool), bundletoolSha256, 'bundletool checksum mismatch');
  await run(path.join(o.javaBin, 'java.exe'), [...javaFlags, '-version']);
  // java -version writes stderr; inspect the installed JDK release descriptor.
  assert.match(await readFile(path.join(o.javaBin, '../release'), 'utf8'), /^JAVA_VERSION="17\./m, 'JDK17 required');
  assert.match(await readFile(path.join(o.buildTools, 'source.properties'), 'utf8'), /^Pkg.Revision\s*=\s*36\.0\.0\s*$/m, 'Build tools 36.0.0 required');
}
export async function verifyNativeIdentity(o, files, p, execute = run) {
  const java = (...a) => execute(path.join(o.javaBin, 'java.exe'), [...javaFlags, ...a]);
  const badging = await execute(path.join(o.buildTools, 'aapt.exe'), ['dump', 'badging', files.apk]);
  const m = /^package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']+)'/m.exec(badging);
  assert.ok(m, 'Missing APK identity');
  assert.deepEqual([m[1], m[2], m[3], /^sdkVersion:'(\d+)'/m.exec(badging)?.[1], /^targetSdkVersion:'(\d+)'/m.exec(badging)?.[1]],
    [p.package, String(p.versionCode), p.version, '24', '36']);
  await execute(path.join(o.buildTools, 'zipalign.exe'), ['-c', '-P', '16', '-v', '4', files.apk]);
  await java('-jar', o.bundletool, 'validate', '--bundle=' + files.aab);
  for (const [xpath, value] of Object.entries({ '/manifest/@package': p.package, '/manifest/@android:versionName': p.version,
    '/manifest/@android:versionCode': String(p.versionCode), '/manifest/uses-sdk/@android:minSdkVersion': '24', '/manifest/uses-sdk/@android:targetSdkVersion': '36' })) {
    assert.equal((await java('-jar', o.bundletool, 'dump', 'manifest', '--bundle=' + files.aab, '--xpath=' + xpath)).trim(), value, 'AAB identity mismatch');
  }
  const config = JSON.parse(await java('-jar', o.bundletool, 'dump', 'config', '--bundle=' + files.aab));
  assert.equal(config.optimizations?.uncompressNativeLibraries?.alignment, 'PAGE_ALIGNMENT_16K');
}
async function unsigned(o, files, p) {
  const archives = {};
  for (const k of ['apk', 'aab']) {
    const a = archives[k] = await inspectArchive(files[k], o.python);
    assert.equal(a.signingBlock, false, 'Signing block in unsigned input');
    const entries = Object.keys(a.hashes);
    if (k === 'apk') assert.ok(entries.includes('AndroidManifest.xml') && !entries.includes('base/manifest/AndroidManifest.xml'));
    const jar = await run(path.join(o.javaBin, 'jarsigner.exe'), ['-J-Xms16m', '-J-Xmx96m', '-J-XX:ActiveProcessorCount=1', '-J-Duser.language=en', '-verify', '-verbose', files[k]]);
    assertUnsigned(k === 'apk' ? entries.map(n => n === 'AndroidManifest.xml' ? 'base/manifest/AndroidManifest.xml' : n) : entries, jar, a.manifest);
    assertAndroidAbiCoverage(entries, k === 'apk' ? 'apk' : 'base');
  }
  assert.equal(archives.aab.mapping, p.payloads.mapping.sha256, 'Embedded mapping mismatch');
  await verifyNativeIdentity(o, files, p);
  return archives;
}
// JarFile verifies every byte and exposes actual signer leaf certificates per
// payload member. keytool alone would only prove certificate presence.
const jarVerifier = String.raw`import java.util.*;import java.util.jar.*;import java.security.*;import java.security.cert.X509Certificate;
class VerifyBundle { public static void main(String[] a) throws Exception {
 try(JarFile j=new JarFile(a[0],true)) { var entries=j.entries(); int count=0; byte[] b=new byte[65536];
 while(entries.hasMoreElements()) { var e=entries.nextElement(); try(var in=j.getInputStream(e)){while(in.read(b)!=-1){}}
 if(e.isDirectory() || e.getName().toUpperCase(Locale.ROOT).matches("META-INF/(MANIFEST\\.MF|[^/]+\\.(SF|RSA|DSA|EC)|SIG-[^/]+)"))continue;
 var signers=e.getCodeSigners(); if(signers==null||signers.length!=1)throw new Exception();
 var cert=(X509Certificate)signers[0].getSignerCertPath().getCertificates().get(0); cert.checkValidity();
 if(cert.getSubjectX500Principal().getName().toLowerCase(Locale.ROOT).contains("android debug"))throw new Exception();
 var h=HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(cert.getEncoded()));
 if(!h.equals(a[1]))throw new Exception(); count++; }
 if(count==0)throw new Exception(); } System.out.println("VERIFIED"); }}
`;
// Testable Java verifier; the production caller always supplies the fixed role
// pin, never a CLI, environment or provenance-derived certificate value.
export async function verifyJarSignature(file, javaBin, stage, expectedCertificate) {
  const helper = path.join(stage, 'VerifyBundle.java');
  await writeFile(helper, jarVerifier, { flag: 'wx' });
  try { assert.equal((await run(path.join(javaBin, 'java.exe'), [...javaFlags, helper, file, expectedCertificate])).trim(), 'VERIFIED'); }
  finally { await rm(helper, { force: true }); }
}
async function prepare(o) {
  await validateToolchain(o);
  const p = await validateInputs(o.files, o.output, o.expectedCommit, o.expectedRunId);
  await unsigned(o, o.files, p);
  for (const k of Object.keys(outputNames)) {
    await copyFile(o.files[k], path.join(o.stage, outputNames[k]), constants.COPYFILE_EXCL);
    assert.equal(await hashFile(path.join(o.stage, outputNames[k])), p.payloads[k].sha256);
  }
  // Recheck the copies themselves before exposing them to private keys.
  await unsigned(o, Object.fromEntries(Object.keys(outputNames).map(k => [k, path.join(o.stage, outputNames[k])])), p);
}
async function finalize(o) {
  await validateToolchain(o);
  const p = await validateInputs(o.files, o.output, o.expectedCommit, o.expectedRunId);
  const before = await unsigned(o, o.files, p);
  const files = Object.fromEntries(Object.keys(outputNames).map(k => [k, path.join(o.stage, outputNames[k])]));
  for (const k of ['apk', 'aab']) comparePayloads(before[k], await inspectArchive(files[k], o.python));
  assert.equal(await hashFile(files.mapping), p.payloads.mapping.sha256);
  await verifyNativeIdentity(o, files, p);
  const certs = await run(path.join(o.javaBin, 'java.exe'), [...javaFlags, '-jar', path.join(o.buildTools, 'lib/apksigner.jar'), 'verify', '--verbose', '--print-certs', files.apk]);
  parseSigningCertificate(certs, contract.roles.apk);
  assert.doesNotMatch(certs, /android debug/i);
  assert.match(certs, /^Verified using v2 scheme .*: true\r?$/m, 'APK v2 signature required');
  assert.match(certs, /^Verified using v3 scheme .*: true\r?$/m, 'APK v3 signature required');
  await verifyJarSignature(files.aab, o.javaBin, o.stage, contract.roles.aab);
  const hashes = {};
  for (const [k, file] of Object.entries(files)) {
    hashes[k] = await hashFile(file);
    await writeFile(file + '.sha256', `${hashes[k]}  ${outputNames[k]}\n`, { flag: 'wx' });
  }
  const metadata = { schemaVersion: 1, repository: p.repository, tag: 'v' + p.version, sourceCommit: p.sourceCommit,
    package: p.package, version: p.version, versionCode: p.versionCode, signingCertificateSha256: contract.roles.apk,
    apk: { name: outputNames.apk, sha256: hashes.apk } };
  validateReleaseMetadata(metadata, metadata.tag);
  await writeFile(path.join(o.stage, 'caption-studio-release.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
  await writeFile(path.join(o.stage, 'source-signature-receipt.json'), JSON.stringify({ schemaVersion: 1,
    repository: p.repository, sourceCommit: p.sourceCommit, sourceTree: p.sourceTree, runId: p.runId, runAttempt: p.runAttempt,
    workflowRef: p.workflowRef, unsignedProvenanceSha256: await hashFile(o.files.provenance),
    package: p.package, version: p.version, versionCode: p.versionCode, certificates: contract.roles,
    payloads: Object.fromEntries(Object.keys(outputNames).map(k => [k, { name: outputNames[k], sha256: hashes[k] }])),
    checks: { exactPayloadPreservation: true, exactEmbeddedMapping: true, apkSignature: true, aabSignature: true,
      apkZipalign16k: true, bundletoolVersion: '1.18.3', bundletoolSha256, minSdk: 24, targetSdk: 36 },
    runtimeVerification: 'REQUIRED', deviceTests: 'NOT_PERFORMED', storeReady: false, published: false,
  }, null, 2) + '\n', { flag: 'wx' });
  // Detect source or payload races up to the final local verification boundary.
  await validateInputs(o.files, o.output, o.expectedCommit, o.expectedRunId);
  for (const k of Object.keys(files)) assert.equal(await hashFile(files[k]), hashes[k]);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assertLocal();
    assert.equal(process.platform, 'win32', 'Windows required');
    const [mode, request, ...extra] = process.argv.slice(2);
    assert.ok(extra.length === 0 && ['--prepare', '--finalize'].includes(mode));
    const o = JSON.parse(await readFile(request, 'utf8'));
    if (mode === '--prepare') await prepare(o); else await finalize(o);
  } catch { process.stderr.write('Local release validation failed; tool details suppressed.\n'); process.exitCode = 1; }
}
