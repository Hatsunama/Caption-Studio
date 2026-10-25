import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FILES, RECIPIENT, SIGNER, validateManifest, validateZip, validateCms, crc32 } from '../scripts/local-signing/import-validation.mjs';

const hash = b => createHash('sha256').update(b).digest('hex');
const cipher = Buffer.from('synthetic encrypted backup');
const approved = 'a'.repeat(64);
function manifest() {
  return { schema_version: 1, envelope: 'CMS AuthEnvelopedData DER', content_encryption: 'AES-256-GCM',
    key_transport: 'RSA-OAEP', oaep_digest: 'SHA-256', mgf1_digest: 'SHA-256', openssl_version: 'OpenSSL 3.5.9',
    exporter_sha256: approved, ciphertext_file: 'recovery.p7m', ciphertext_sha256: hash(cipher),
    recipient_certificate_der_sha256: RECIPIENT, expected_signing_certificate_der_sha256: SIGNER,
    payload: { schema_version: 1, format: 'ZIP_STORED', files: [...FILES],
      keystore_encoding: 'original base64-decoded keystore bytes (JKS or PKCS#12)',
      text_encoding: 'UTF-8 without added newline', extra_entries_allowed: false, paths_allowed: false } };
}
function zip(entries = FILES.map((name, i) => ({ name, data: Buffer.from(i ? `synthetic-${i}` : 'original JKS bytes') }))) {
  let offset = 0;
  const locals = [], central = [];
  for (const e of entries) {
    const name = Buffer.from(e.name), data = e.data ?? Buffer.from('x');
    const l = Buffer.alloc(30), c = Buffer.alloc(46);
    l.writeUInt32LE(0x04034b50); l.writeUInt16LE(20, 4); l.writeUInt16LE(e.flags ?? 0, 6);
    l.writeUInt16LE(e.method ?? 0, 8); l.writeUInt32LE(crc32(data), 14);
    l.writeUInt32LE(data.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(name.length, 26);
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(0x0314, 4); c.writeUInt16LE(20, 6);
    l.copy(c, 8, 6, 30); c.writeUInt32LE(((e.mode ?? 0o100600) << 16) >>> 0, 38); c.writeUInt32LE(offset, 42);
    locals.push(l, name, data); central.push(c, name); offset += l.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
test('manifest accepts only exact approved schema, provenance, recipient and ciphertext', () => {
  assert.doesNotThrow(() => validateManifest(manifest(), cipher, approved, RECIPIENT));
  for (const change of [m => m.schema_version = 2, m => m.content_encryption = 'AES-256-CBC',
    m => m.payload.files.reverse(), m => m.payload.extra_entries_allowed = true,
    m => m.exporter_sha256 = 'b'.repeat(64), m => m.recipient_certificate_der_sha256 = 'b'.repeat(64),
    m => m.expected_signing_certificate_der_sha256 = 'b'.repeat(64), m => m.ciphertext_file = '../recovery.p7m',
    m => m.extra = 1, m => m.payload.extra = 1]) {
    const m = manifest(); change(m); assert.throws(() => validateManifest(m, cipher, approved, RECIPIENT));
  }
  assert.throws(() => validateManifest(manifest(), Buffer.from('tampered'), approved, RECIPIENT));
  assert.throws(() => validateManifest(manifest(), cipher, approved, 'b'.repeat(64)));
  assert.throws(() => validateManifest(manifest(), cipher, '', RECIPIENT));
});
test('ZIP reads four ordered original byte sequences', () => {
  const result = validateZip(zip());
  assert.deepEqual(Object.keys(result), FILES);
  assert.equal(result['keystore.p12'].toString(), 'original JKS bytes');
});
test('ZIP rejects duplicates, paths, extra/missing/order, links, directories, encryption, compression and sizes', () => {
  const entries = () => FILES.map(name => ({ name, data: Buffer.from('x') }));
  for (const change of [e => e.push({ name: 'extra' }), e => e.pop(), e => e.reverse(),
    e => e[1].name = e[0].name, e => e[0].name = '../keystore.p12', e => e[0].name = 'C:\\key',
    e => e[0].mode = 0o120600, e => e[0].mode = 0o040700, e => e[0].flags = 1,
    e => e[0].method = 8, e => e[0].data = Buffer.alloc(524289), e => e[1].data = Buffer.alloc(4097),
    e => e[1].data = Buffer.alloc(0), e => e[1].data = Buffer.from('a\nb'),
    e => e[1].data = Buffer.from([0xff]), e => e[1].data = Buffer.from('a\0b')]) {
    const e = entries(); change(e); assert.throws(() => validateZip(zip(e)));
  }
});
test('ZIP rejects tamper, truncation, leading/trailing bytes, central/local disagreement and extras', () => {
  for (const change of [b => b.subarray(0, -1), b => Buffer.concat([b, Buffer.from('x')]),
    b => Buffer.concat([Buffer.from('x'), b]), b => { b[45] ^= 1; return b; },
    b => { b.writeUInt16LE(1, 28); return b; }, b => { b.writeUInt32LE(0xffffffff, b.length - 6); return b; }]) {
    assert.throws(() => validateZip(change(zip())));
  }
});
const openssl = process.env.LOCAL_IMPORT_TEST_OPENSSL ?? (process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl');
test('real synthetic OpenSSL CMS algorithms, authenticated roundtrip and tamper failure', () => {
  const temp = mkdtempSync(join(tmpdir(), 'caption-cms-synthetic-'));
  const config = join(temp, 'empty.cnf'); writeFileSync(config, '');
  const run = args => spawnSync(openssl, args, { encoding: 'utf8', timeout: 60000,
    env: { ...process.env, OPENSSL_CONF: config, SYNTHETIC_PASS: 'synthetic recipient password' } });
  try {
    const key = join(temp, 'recipient.pem'), cert = join(temp, 'recipient.crt'), payload = join(temp, 'payload.zip');
    const encrypted = join(temp, 'recovery.p7m'), decrypted = join(temp, 'decrypted.zip');
    const generated = run(['req','-x509','-newkey','rsa:2048','-keyout',key,'-out',cert,'-passout','env:SYNTHETIC_PASS','-subj','/CN=Synthetic','-days','1']);
    assert.equal(generated.status, 0, generated.stderr);
    writeFileSync(payload, zip());
    const args = ['cms','-encrypt','-aes-256-gcm','-binary','-outform','DER','-in',payload,'-out',encrypted,'-recip',cert,
      '-keyopt','rsa_padding_mode:oaep','-keyopt','rsa_oaep_md:sha256','-keyopt','rsa_mgf1_md:sha256'];
    assert.equal(run(args).status, 0);
    const cms = readFileSync(encrypted);
    assert.doesNotThrow(() => validateCms(cms));
    const decrypt = ['cms','-decrypt','-binary','-inform','DER','-in',encrypted,'-recip',cert,'-inkey',key,'-passin','env:SYNTHETIC_PASS','-out',decrypted];
    assert.equal(run(decrypt).status, 0);
    assert.deepEqual(readFileSync(decrypted), readFileSync(payload));
    // Invalid tag may leave plaintext on disk: the importer must require exit zero.
    cms[cms.length - 1] ^= 1; writeFileSync(encrypted, cms);
    assert.notEqual(run(decrypt).status, 0);
    for (const oid of ['60864801650304012e', '2a864886f70d010107', '608648016503040201', '2a864886f70d010108']) {
      const altered = Buffer.from(cms), p = altered.indexOf(Buffer.from(oid, 'hex'));
      assert.ok(p > 0); altered[p + oid.length / 2 - 1] ^= 1;
      assert.throws(() => validateCms(altered));
    }
    assert.throws(() => validateCms(cms.subarray(0, -1)));
    assert.throws(() => validateCms(Buffer.concat([cms, Buffer.from('x')])));
    assert.equal(run(args.map(a => a === '-aes-256-gcm' ? '-aes-256-cbc' : a)).status, 0);
    assert.throws(() => validateCms(readFileSync(encrypted)));
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
const ps = resolve('scripts/local-signing/import-recovered-key.ps1');
test('production importer has fixed pins and verifies child exit before unpacking', () => {
  const s = readFileSync(ps, 'utf8');
  assert.ok(s.includes(RECIPIENT) && s.includes(SIGNER));
  assert.ok(s.indexOf("'cms', '-decrypt'") < s.indexOf("'unpack'"));
  assert.ok(s.includes('ZeroFreeBSTR'));
  assert.ok(!s.includes('Expand-Archive'));
});
test('Windows synthetic DPAPI, ACL, private-key proof, rejection and no-overwrite', { skip: process.platform !== 'win32' }, () => {
  const jdk = process.env.LOCAL_IMPORT_TEST_JDK;
  if (!jdk) return assert.fail('Set LOCAL_IMPORT_TEST_JDK to explicit Java 17 bin for Windows synthetic checks');
  const temp = mkdtempSync(join(tmpdir(), 'caption-import-synthetic-'));
  try {
    // Load function ASTs only: never execute the production entrypoint or change its pins.
    const harness = join(temp, 'synthetic.ps1');
    writeFileSync(harness, `
$ErrorActionPreference = 'Stop'
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${ps.replaceAll("'", "''")}', [ref]$null, [ref]$null)
$ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]}, $false) | ForEach-Object { Invoke-Expression $_.Extent.Text }
$root = '${temp.replaceAll("'", "''")}'
$jdk = '${jdk.replaceAll("'", "''")}'
$stage = New-PrivateStage $root
try {
  Assert-PrivateDirectory $stage
  $secret = [Text.Encoding]::UTF8.GetBytes('synthetic password')
  Save-Password (Join-Path $stage 'password.dpapi') $secret
  $round = Read-Password (Join-Path $stage 'password.dpapi')
  if ([Text.Encoding]::UTF8.GetString($round) -cne 'synthetic password') { throw 'DPAPI roundtrip' }
  [Array]::Clear($round,0,$round.Length)
  Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security')
  $secure = ConvertTo-SecureString 'synthetic password' -AsPlainText -Force
  try { [IO.File]::WriteAllText((Join-Path $stage 'powershell.dpapi'), (ConvertFrom-SecureString $secure)) } finally { $secure.Dispose() }
  $round = Read-Password (Join-Path $stage 'powershell.dpapi')
  if ([Text.Encoding]::UTF8.GetString($round) -cne 'synthetic password') { throw 'PowerShell DPAPI roundtrip' }
  [Array]::Clear($round,0,$round.Length)
  $store = Join-Path $stage 'key.p12'
  $envs = @{ IMPORT_STORE = 'synthetic password'; IMPORT_KEY = 'synthetic password' }
  $j = @('-J-Xms16m','-J-Xmx64m','-J-XX:ActiveProcessorCount=1')
  $null = Invoke-Captured (Join-Path $jdk 'keytool.exe') ($j + @('-genkeypair','-alias','synthetic','-keyalg','RSA','-keysize','2048','-dname','CN=Synthetic','-validity','2','-keystore',$store,'-storepass:env','IMPORT_STORE','-keypass:env','IMPORT_KEY')) $envs
  $derText = Invoke-Captured (Join-Path $jdk 'keytool.exe') ($j + @('-exportcert','-rfc','-alias','synthetic','-keystore',$store,'-storepass:env','IMPORT_STORE')) $envs
  $pin = Get-CertificateHash $derText
  $null = Prove-Key $stage $jdk 'synthetic password' 'synthetic password' 'synthetic' $pin
  # A certificate-only store cannot satisfy private-key proof.
  [IO.File]::WriteAllText((Join-Path $stage 'public.crt'), $derText)
  [IO.File]::Move($store, (Join-Path $stage 'original.p12'))
  $null = Invoke-Captured (Join-Path $jdk 'keytool.exe') ($j + @('-importcert','-noprompt','-alias','synthetic','-file',(Join-Path $stage 'public.crt'),'-keystore',$store,'-storepass:env','IMPORT_STORE')) $envs
  $failed = $false
  try { $null = Prove-Key $stage $jdk 'synthetic password' 'synthetic password' 'synthetic' $pin } catch { $failed = $true }
  if (-not $failed) { throw 'Certificate-only store accepted' }
  [IO.File]::Delete($store)
  [IO.File]::Move((Join-Path $stage 'original.p12'),$store)
  $jks = Join-Path $stage 'jks'
  [IO.Directory]::CreateDirectory($jks) | Out-Null
  $jksAlias = 'synthetic alias"quoted'
  $null = Invoke-Captured (Join-Path $jdk 'keytool.exe') ($j + @('-genkeypair','-storetype','JKS','-alias',$jksAlias,'-keyalg','RSA','-keysize','2048','-dname','CN=SyntheticJKS','-validity','2','-keystore',(Join-Path $jks 'key.p12'),'-storepass:env','IMPORT_STORE','-keypass:env','IMPORT_KEY')) @{ IMPORT_STORE = 'synthetic store'; IMPORT_KEY = 'synthetic key' }
  $jksCert = Invoke-Captured (Join-Path $jdk 'keytool.exe') ($j + @('-exportcert','-rfc','-alias',$jksAlias,'-keystore',(Join-Path $jks 'key.p12'),'-storepass:env','IMPORT_STORE')) @{ IMPORT_STORE = 'synthetic store' }
  $null = Prove-Key $jks $jdk 'synthetic store' 'synthetic key' $jksAlias (Get-CertificateHash $jksCert)
  $failed = $false
  try { $null = Prove-Key $jks $jdk 'synthetic store' 'wrong key' $jksAlias (Get-CertificateHash $jksCert) } catch { $failed = $true }
  if (-not $failed) { throw 'Wrong JKS key password accepted' }
  foreach ($case in @('wrong-password','wrong-alias','wrong-pin')) {
    $failed = $false
    try {
      $pw = 'synthetic password'; $alias = 'synthetic'; $expected = $pin
      if ($case -eq 'wrong-password') { $pw = 'wrong' }
      if ($case -eq 'wrong-alias') { $alias = 'missing' }
      if ($case -eq 'wrong-pin') { $expected = '0' * 64 }
      $null = Prove-Key $stage $jdk $pw $pw $alias $expected
    } catch { $failed = $true }
    if (-not $failed) { throw 'Probe accepted failure' }
  }
  $dest = Join-Path $root 'existing'
  [IO.Directory]::CreateDirectory($dest) | Out-Null
  $failed = $false
  try { Publish-Bundle $stage $dest } catch { $failed = $true }
  if (-not $failed -or -not [IO.Directory]::Exists($stage)) { throw 'Overwrite' }
  # Failures are captured, including diagnostic output; caller never reaches parsing.
  $bad = Join-Path $stage 'bad.cmd'
  [IO.File]::WriteAllText($bad, '@echo synthetic-secret-value & exit /b 7')
  $parsed = $false; $failed = $false
  try { $null = Invoke-Captured $env:ComSpec @('/d','/c',$bad); $parsed = $true } catch { $failed = $true }
  if (-not $failed -or $parsed) { throw 'Child failure did not gate parsing' }
  # A junction ancestor is rejected before writing or recursive cleanup.
  $link = Join-Path $root 'junction'
  New-Item -ItemType Junction -Path $link -Target $stage | Out-Null
  $failed = $false
  try { $null = Assert-Path $link $true } catch { $failed = $true }
  [IO.Directory]::Delete($link)
  if (-not $failed) { throw 'Reparse ancestor accepted' }
  # Publish complete synthetic bundle through an atomic same-volume rename.
  $complete = New-PrivateStage $root
  [IO.File]::WriteAllText((Join-Path $complete 'sentinel'),'complete')
  Publish-Bundle $complete (Join-Path $root 'published-synthetic')
  if ([IO.Directory]::Exists($complete)) { throw 'Non-atomic publication' }
  # Production CLI with unchanged pins rejects synthetic inputs and cleans its stage.
  $sandbox = New-PrivateStage $root
  [IO.File]::WriteAllText((Join-Path $stage 'manifest.json'),'{}')
  [IO.File]::WriteAllText((Join-Path $stage 'recovery.p7m'),'not a real envelope')
  $cli = @('-NoProfile','-NonInteractive','-File','${ps.replaceAll("'", "''")}','-Envelope',(Join-Path $stage 'recovery.p7m'),'-Manifest',(Join-Path $stage 'manifest.json'),'-RecipientCertificate',(Join-Path $stage 'public.crt'),'-RecipientPrivatePem',$store,'-RecipientPasswordDpapi',(Join-Path $stage 'password.dpapi'),'-ApprovedExporterSha256',('a' * 64),'-JdkBin',$jdk,'-OpenSslExe','${openssl.replaceAll("'", "''")}','-NodeExe','${process.execPath.replaceAll("'", "''")}','-DestinationRoot',$sandbox)
  $failed = $false
  try { $null = Invoke-Captured (Join-Path $PSHOME 'powershell.exe') $cli } catch { $failed = $true }
  if (-not $failed -or @(Get-ChildItem -LiteralPath $sandbox -Force).Count -ne 0) { throw 'Production failure left a bundle or stage' }
  $final = Join-Path $sandbox 'solana-release'
  [IO.Directory]::CreateDirectory($final) | Out-Null
  [IO.File]::WriteAllText((Join-Path $final 'sentinel'),'untouched')
  $failed = $false
  try { $null = Invoke-Captured (Join-Path $PSHOME 'powershell.exe') $cli } catch { $failed = $true }
  if (-not $failed -or [IO.File]::ReadAllText((Join-Path $final 'sentinel')) -ne 'untouched') { throw 'Production overwrote final' }
  Remove-OwnedStage $sandbox $root
} finally { Remove-OwnedStage $stage $root }
if ([IO.Directory]::Exists($stage)) { throw 'Cleanup failed' }
`);
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', harness], { encoding: 'utf8', timeout: 180000 });
    assert.equal(r.status, 0, `Synthetic harness failed: ${r.stdout}\n${r.stderr}`);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
