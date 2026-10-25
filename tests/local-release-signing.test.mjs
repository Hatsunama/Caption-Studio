import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as gate from '../scripts/local-signing/sign-validation.mjs';
import { parseSigningCertificate } from '../scripts/configure-sidecar-release.mjs';

const windows = process.platform === 'win32';
const windowsOnly = { skip: !windows };
// Discover an absolute Python 3 interpreter; never rely on a fixture's PATH.
const python = (() => {
  for (const candidate of windows ? ['C:\\Python311\\python.exe', 'python', 'python3'] : ['python3', 'python']) {
    try {
      return execFileSync(candidate, ['-c', 'import sys; assert sys.version_info.major == 3; print(sys.executable)'],
        { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
    } catch {}
  }
  throw Error('Python 3 required for archive fixtures');
})();
const signer = path.resolve('scripts/local-signing/sign-release.ps1');
const powershell = windows && process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : undefined;
const shellEnv = { ...process.env, ...(powershell ? { PSModulePath: path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') } : {}) };
const commit = 'a'.repeat(40);
const provenance = () => ({ schemaVersion: 1, repository: 'Hatsunama/Caption-Studio',
  sourceCommit: commit, sourceTree: 'b'.repeat(40), version: '1.4.136', versionCode: 148,
  package: 'com.xmilo_at_your_side.caption_studio', runId: '123', runAttempt: '1',
  workflowRef: 'Hatsunama/Caption-Studio/.github/workflows/unsigned-store-build.yml@refs/heads/main', sourceRef: 'refs/heads/main',
  signing: { status: 'unsigned', certificateSha256: null, storeReady: false, installable: false },
  checks: { bundletoolVersion: '1.18.3', bundletoolSha256: gate.bundletoolSha256, minSdk: 24, targetSdk: 36,
    abi: true, translation64BitOnly: true, apkZipalign16k: true, apkElf16k: true, aabElf16k: true,
    bundlePageAlignment: 'PAGE_ALIGNMENT_16K', unsignedArchives: true, exactEmbeddedMapping: true },
  payloads: Object.fromEntries(['apk', 'aab', 'mapping'].map(k => [k, { name: gate.inputNames[k], bytes: 3, sha256: gate.sha(Buffer.from('abc')) }])) });
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'local-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {};
  for (const k of ['apk', 'aab', 'mapping']) { files[k] = path.join(root, gate.inputNames[k]); await writeFile(files[k], 'abc'); }
  files.provenance = path.join(root, 'provenance.json');
  await writeFile(files.provenance, JSON.stringify(provenance()));
  return { root, files, output: path.join(root, 'out') };
}

test('production parameter defaults use canonical signing root and preserve explicit KeyRoot', windowsOnly, async t => {
  const f = await fixture(t);
  const script = path.join(f.root, 'parameter-defaults.ps1');
  await writeFile(script, `param($Signer,$Root)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Signer,[ref]$tokens,[ref]$errors)
if($errors.Count -or $null -eq $ast.ParamBlock){throw 'Parse failure'}
# Execute the production parameter block only; the stub never opens any path.
$stub=[scriptblock]::Create($ast.ParamBlock.Extent.Text + [Environment]::NewLine + 'Write-Output $KeyRoot')
$arguments=@{}
foreach($parameter in $ast.ParamBlock.Parameters) {
  $name=$parameter.Name.VariablePath.UserPath
  if($name -ne 'KeyRoot'){$arguments[$name]=Join-Path $Root ('synthetic-'+$name)}
}
$env:USERPROFILE=Join-Path $Root 'profile-one'
$first=& $stub @arguments
$env:USERPROFILE=Join-Path $Root 'profile-two'
$second=& $stub @arguments
$arguments.KeyRoot=Join-Path $Root 'explicit synthetic keys'
$explicit=& $stub @arguments
ConvertTo-Json -Compress -InputObject @($first,$second,$explicit)
`);
  const actual = JSON.parse(execFileSync(powershell,
    ['-NoProfile', '-NonInteractive', '-File', script, signer, f.root],
    { encoding: 'utf8', env: shellEnv, windowsHide: true, timeout: 15000 }));
  assert.deepEqual(actual, ['C:\\caption_studio\\signing', 'C:\\caption_studio\\signing', path.join(f.root, 'explicit synthetic keys')]);
});
test('source-bound producer schema and production-only identity fail closed', () => {
  gate.assertProvenance(provenance(), commit, '123');
  const mutations = [p => p.sourceCommit = 'c'.repeat(40), p => p.runId = '124', p => p.package = 'migration',
    p => p.version = '1.4.135', p => p.versionCode = 135, p => p.sourceTree = '', p => p.runAttempt = '01',
    p => p.signing.installable = true, p => p.checks.unsignedArchives = false, p => p.checks.bundletoolSha256 = '0'.repeat(64),
    p => p.payloads.apk.name = '../other', p => p.sourceRef = 'refs/pull/1', p => p.workflowRef = 'other'];
  for (const mutate of mutations) { const p = provenance(); mutate(p); assert.throws(() => gate.assertProvenance(p, commit, '123')); }
  assert.throws(() => gate.assertLocal({ GITHUB_ACTIONS: '' }));
  gate.assertLocal({});
});
test('published baseline rejects version codes 146 and 147 but accepts 148', () => {
  for (const versionCode of [146, 147]) {
    assert.throws(() => gate.assertProvenance({ ...provenance(), versionCode }, commit, '123'), /Future release code required/);
  }
  gate.assertProvenance({ ...provenance(), versionCode: 148 }, commit, '123');
  assert.deepEqual(gate.contract.publishedBaseline, { version: '1.4.135', versionCode: 147 });
});
test('portable module initialization does not require Windows environment', () => {
  const env = { ...process.env }; for (const k of Object.keys(env)) if (['systemroot', 'windir'].includes(k.toLowerCase())) delete env[k];
  execFileSync(process.execPath, ['--max-old-space-size=64', '--test-name-pattern=source-bound producer', '--input-type=module', '-e', `delete process.env.SystemRoot; delete process.env.WINDIR; await import(${JSON.stringify(new URL(import.meta.url).href)});`], { env, stdio: 'pipe', timeout: 15000 });
});
test('distinct public roles match product contract and reject wrong certificates', () => {
  assert.notEqual(gate.contract.roles.apk, gate.contract.roles.aab);
  assert.equal(gate.contract.roles.apk, 'd02d23b28cbc615e3686d181aedefbbe5de993a0b6ba3f8e4ea2b6160211b35f');
  assert.equal(gate.contract.roles.aab, '50d77dfe5b3239d2fa86856613cb193898662a6a9dad2103812ea099ba102ddb');
  assert.throws(() => gate.assertCertificate('apk', Buffer.from('wrong key')));
  assert.throws(() => gate.assertCertificate('unknown', Buffer.alloc(0)));
});
test('actual input bytes, size, duplicate paths, overlap and existing output are refused', async t => {
  const f = await fixture(t);
  await gate.validateInputs(f.files, f.output, commit, '123');
  await writeFile(f.files.apk, 'abd');
  await assert.rejects(gate.validateInputs(f.files, f.output, commit, '123'));
  await writeFile(f.files.apk, 'abc');
  await assert.rejects(gate.validateInputs(f.files, f.root, commit, '123'));
  await assert.rejects(gate.validateInputs({ ...f.files, aab: f.files.apk }, f.output, commit, '123'));
  await mkdir(f.output);
  await assert.rejects(gate.validateInputs(f.files, f.output, commit, '123'));
  assert.deepEqual(await readdir(f.output), []);
});
test('real ZIP hashes preserve all license/assets/native/profile/mapping entries', async t => {
  const f = await fixture(t);
  const a = path.join(f.root, 'before.zip'), b = path.join(f.root, 'after.zip');
  const make = (file, mutation = '') => execFileSync(python, ['-c', `import zipfile,sys,struct
h=bytearray(120);h[:6]=b'\\x7fELF\\x02\\x01';struct.pack_into('<Q',h,32,64);struct.pack_into('<HH',h,54,56,1);struct.pack_into('<I',h,64,1);struct.pack_into('<Q',h,112,16384)
with zipfile.ZipFile(sys.argv[1],'x') as z:
 for n in ['META-INF/LICENSE','assets/x','lib/arm64-v8a/libx.so','assets/dexopt/baseline.prof','BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map']:
  z.writestr(n, bytes(h) if n.endswith('.so') else ('changed' if n==sys.argv[2] else n).encode())
 z.writestr('META-INF/MANIFEST.MF','manifest')
`, file, mutation]);
  make(a); make(b);
  const before = await gate.inspectArchive(a, python), after = await gate.inspectArchive(b, python);
  gate.comparePayloads(before, after);
  await rm(b); make(b, 'META-INF/LICENSE');
  await assert.rejects(async () => gate.comparePayloads(before, await gate.inspectArchive(b, python)));
  assert.equal(gate.isSignatureMetadata('META-INF/LICENSE'), false);
  assert.equal(gate.isSignatureMetadata('META-INF/services/X.SF'), false);
  assert.equal(gate.isSignatureMetadata('META-INF/KEY.RSA'), true);
});

const javaBin = process.env.LOCAL_RELEASE_TEST_JDK ?? process.env.LOCAL_IMPORT_TEST_JDK ??
  path.resolve(path.dirname(process.execPath), '../liberica-jdk-17.0.21.0.2+5/jdk-17.0.21.0.2/bin');
const buildTools = process.env.LOCAL_RELEASE_TEST_BUILD_TOOLS ?? path.join(
  process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? path.join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk'),
  'build-tools', '36.0.0');
test('actual synthetic JAR signature verifies, rejects production role, tamper and appended unsigned entry', windowsOnly, async t => {
  const f = await fixture(t);
  const key = path.join(f.root, 'synthetic.p12'), jar = path.join(f.root, 'synthetic.jar'), der = path.join(f.root, 'synthetic.der');
  const env = { ...process.env, SYNTHETIC_PASS: 'synthetic-only-test-password' };
  const javaTool = (tool, args) => execFileSync(path.join(javaBin, tool + '.exe'), ['-J-Xms16m','-J-Xmx96m','-J-XX:ActiveProcessorCount=1', ...args], { env, stdio: 'pipe', windowsHide: true });
  javaTool('keytool', ['-genkeypair','-alias','synthetic','-keyalg','RSA','-keysize','2048','-validity','2','-dname','CN=Synthetic Only','-storetype','PKCS12','-keystore',key,'-storepass:env','SYNTHETIC_PASS','-keypass:env','SYNTHETIC_PASS']);
  javaTool('keytool', ['-exportcert','-alias','synthetic','-keystore',key,'-storepass:env','SYNTHETIC_PASS','-file',der]);
  const make = () => execFileSync(python, ['-c', "import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'x') as z:z.writestr('META-INF/LICENSE','preserved');z.writestr('assets/data','payload')", jar]);
  const sign = () => javaTool('jarsigner', ['-keystore',key,'-storepass:env','SYNTHETIC_PASS','-keypass:env','SYNTHETIC_PASS',jar,'synthetic']);
  make(); sign();
  const syntheticPin = gate.sha(await readFile(der));
  await gate.verifyJarSignature(jar, javaBin, f.root, syntheticPin);
  const syntheticDer = await readFile(der);
  assert.throws(() => gate.assertCertificate('aab', syntheticDer));
  await assert.rejects(gate.verifyJarSignature(jar, javaBin, f.root, gate.contract.roles.aab));
  execFileSync(python, ['-c', "import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'a') as z:z.writestr('assets/unsigned','extra')", jar]);
  await assert.rejects(gate.verifyJarSignature(jar, javaBin, f.root, syntheticPin));
  await rm(jar); make(); sign();
  const changed = path.join(f.root, 'changed.jar');
  execFileSync(python, ['-c', "import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as src,zipfile.ZipFile(sys.argv[2],'x') as dst:\n for i in src.infolist():dst.writestr(i,b'tampered' if i.filename=='assets/data' else src.read(i))", jar, changed]);
  await assert.rejects(gate.verifyJarSignature(changed, javaBin, f.root, syntheticPin));
  assert.ok(!(await readdir(f.root)).includes('VerifyBundle.java'), 'helper cleaned after failure');

  // Actual apksigner v2/v3 over a synthetic ZIP, with explicit SDK for its text
  // manifest. This proves the crypto adapter only, never Android identity.
  const apk = path.join(f.root,'synthetic.apk');
  execFileSync(python,['-c',"import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'x') as z:z.writestr('AndroidManifest.xml','synthetic manifest');z.writestr('assets/data','payload')",apk]);
  const before = await gate.inspectArchive(apk,python);
  const signerJar = path.join(buildTools, 'lib', 'apksigner.jar');
  const java = args => execFileSync(path.join(javaBin,'java.exe'),['-Xms16m','-Xmx96m','-XX:ActiveProcessorCount=1','-jar',signerJar,...args],{env,encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true});
  java(['sign','--ks',key,'--ks-key-alias','synthetic','--ks-pass','env:SYNTHETIC_PASS','--key-pass','env:SYNTHETIC_PASS','--min-sdk-version','24','--v1-signing-enabled','false','--v2-signing-enabled','true','--v3-signing-enabled','true','--v4-signing-enabled','false',apk]);
  const verified = java(['verify','--min-sdk-version','24','--verbose','--print-certs',apk]);
  assert.match(verified,/Verified using v2 scheme .*: true/); assert.match(verified,/Verified using v3 scheme .*: true/);
  parseSigningCertificate(verified,syntheticPin);
  assert.throws(() => parseSigningCertificate(verified,gate.contract.roles.apk));
  assert.equal((await gate.inspectArchive(apk,python)).signingBlock,true);
  gate.comparePayloads(before,await gate.inspectArchive(apk,python));
});
test('real ZIP parser refuses duplicates, traversal, symlinks, and detects APK signing footer', async t => {
  const f = await fixture(t);
  for (const mode of ['duplicate', 'traversal', 'symlink']) {
    const file = path.join(f.root, mode + '.zip');
    execFileSync(python, ['-c', `import sys,zipfile
with zipfile.ZipFile(sys.argv[1],'x') as z:
 mode=sys.argv[2]
 if mode=='duplicate':
  z.writestr('x','a');z.writestr('x','b')
 elif mode=='traversal': z.writestr('../x','a')
 else:
  i=zipfile.ZipInfo('link');i.external_attr=0o120777<<16;z.writestr(i,'target')
`, file, mode], { stdio: 'ignore' });
    await assert.rejects(gate.inspectArchive(file, python));
  }
  const file = path.join(f.root, 'block.zip');
  execFileSync(python, ['-c', `import sys,zipfile,struct
p=sys.argv[1]
with zipfile.ZipFile(p,'x') as z:z.writestr('x','APK Sig Block 42')
b=bytearray(open(p,'rb').read());e=b.rfind(b'PK\\x05\\x06');cd=struct.unpack_from('<I',b,e+16)[0]
b[cd:cd]=b'APK Sig Block 42';struct.pack_into('<I',b,e+16+16,cd+16);open(p,'wb').write(b)
`, file]);
  assert.equal((await gate.inspectArchive(file, python)).signingBlock, true);
});
test('atomic publication refuses replacement and removes owned staging on failure', windowsOnly, async t => {
  const f = await fixture(t);
  const file=path.join(f.root,'publication-test.ps1');
  await writeFile(file,`param($Signer,$Root)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Signer,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Parse failure'}
foreach($n in @('Publish-Release','Remove-OwnedStage','Assert-LocalPath')) {
 $fn=$ast.FindAll({param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst]},$true) | Where-Object Name -eq $n
 Invoke-Expression $fn.Extent.Text
}
$output=Join-Path $Root 'out'
$stage=Join-Path $Root ('.local-signing-pending-'+[Guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $stage
[IO.File]::WriteAllText((Join-Path $stage 'x'),'partial')
Remove-OwnedStage $stage $output
if(Test-Path -LiteralPath $stage){throw 'Cleanup failure'}
$null=New-Item -ItemType Directory -Path $stage
[IO.File]::WriteAllText((Join-Path $stage 'x'),'complete')
Publish-Release $stage $output
$null=New-Item -ItemType Directory -Path $stage
$rejected=$false;try{Publish-Release $stage $output}catch{$rejected=$true};if(-not $rejected){throw 'Overwrite allowed'}
$empty=Join-Path $Root 'empty';$null=New-Item -ItemType Directory -Path $empty
$rejected=$false;try{Publish-Release $stage $empty}catch{$rejected=$true};if(-not $rejected){throw 'Empty overwrite allowed'}
$rejected=$false;try{Remove-OwnedStage $output $output}catch{$rejected=$true};if(-not $rejected){throw 'Unowned cleanup allowed'}
Remove-OwnedStage $stage $output
Write-Output 'ATOMIC_OK'
`);
  assert.equal(execFileSync(powershell,['-NoProfile','-NonInteractive','-File',file,signer,f.root],{encoding:'utf8',stdio:['ignore','pipe','pipe'],env:shellEnv,windowsHide:true}).trim(),'ATOMIC_OK');
  assert.equal(await readFile(path.join(f.output, 'x'), 'utf8'), 'complete');
  assert.deepEqual((await readdir(f.root)).filter(n => n.includes('pending')), []);
});

test('actual Windows CurrentUser DPAPI reader, environment isolation, sanitized failure and linked path refusal', windowsOnly, async t => {
  const f = await fixture(t);
  // Import only named function ASTs; never run the production entry body or
  // resolve its default profile. Every secret/file here is synthetic.
  const script = `param($Signer,$Root)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Signer,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Parse failed'}
foreach($n in @('Read-Password','Invoke-PrivateTool','Quote-Argument','Assert-LocalPath')) {
 $fn=$ast.FindAll({param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst]},$true) | Where-Object Name -eq $n
 Invoke-Expression $fn.Extent.Text
}
$null=Assert-LocalPath $Root
$raw=[Text.Encoding]::UTF8.GetBytes('  synthetic DPAPI password  ')
$file=Join-Path $Root 'password.dpapi'
[IO.File]::WriteAllBytes($file,[Security.Cryptography.ProtectedData]::Protect($raw,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))
$secure=Read-Password $file
$child=Join-Path $Root 'child.ps1'
[IO.File]::WriteAllText($child,'if($env:CS_STORE_PASS -cne "  synthetic DPAPI password  " -or $env:UNRELATED_SECRET -or $env:JAVA_TOOL_OPTIONS){exit 8}; Write-Output "MUST_REMAIN_CAPTURED"')
$env:UNRELATED_SECRET='must-not-inherit';$env:JAVA_TOOL_OPTIONS='must-not-inherit'
$env:CS_STORE_PASS='parent-unchanged'
Invoke-PrivateTool (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') @('-NoProfile','-NonInteractive','-File',$child) @{CS_STORE_PASS=$secure}
if($env:CS_STORE_PASS -cne 'parent-unchanged'){throw 'Parent changed'}
$secure.Dispose()
$serialized=ConvertFrom-SecureString (ConvertTo-SecureString '  synthetic DPAPI password  ' -AsPlainText -Force)
[IO.File]::WriteAllText($file,(' '+$serialized+"\r\n"),(New-Object Text.UTF8Encoding($false)))
$secure=Read-Password $file
Invoke-PrivateTool (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') @('-NoProfile','-NonInteractive','-File',$child) @{CS_STORE_PASS=$secure}
$secure.Dispose()
[IO.File]::WriteAllBytes($file,[Security.Cryptography.ProtectedData]::Protect($raw,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine))
$rejected=$false;try{$s=Read-Password $file;$s.Dispose()}catch{$rejected=$true};if(-not $rejected){throw 'Machine scope accepted'}
[IO.File]::WriteAllBytes($file,[byte[]](1,2,3))
$rejected=$false;try{$s=Read-Password $file;$s.Dispose()}catch{$rejected=$true};if(-not $rejected){throw 'Corruption accepted'}
$rejected=$false;try{Assert-LocalPath 'D:\\key.p12'}catch{$rejected=$true};if(-not $rejected){throw 'Non C accepted'}
$target=Join-Path $Root 'target';$null=New-Item -ItemType Directory -Path $target
$junction=Join-Path $Root 'junction';$null=New-Item -ItemType Junction -Path $junction -Target $target
try{$rejected=$false;try{Assert-LocalPath $junction}catch{$rejected=$true};if(-not $rejected){throw 'Link accepted'}}finally{[IO.Directory]::Delete($junction)}
[IO.File]::WriteAllText($child,'Write-Output "SENSITIVE_CHILD_OUTPUT"; [Console]::Error.WriteLine("SENSITIVE_CHILD_ERROR"); exit 9')
$rejected=$false;try{Invoke-PrivateTool (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') @('-NoProfile','-NonInteractive','-File',$child)}catch{if($_.Exception.Message -cne 'Local tool failed; output and arguments suppressed.'){throw};$rejected=$true}
if(-not $rejected){throw 'Failure accepted'}
Write-Output 'SYNTHETIC_DPAPI_OK'
`;
  const file = path.join(f.root, 'dpapi-test.ps1'); await writeFile(file, script);
  const out = execFileSync(powershell, ['-NoProfile','-NonInteractive','-File',file,signer,f.root], { encoding:'utf8', stdio:['ignore','pipe','pipe'], windowsHide:true, env:shellEnv });
  assert.equal(out.trim(), 'SYNTHETIC_DPAPI_OK');
});

test('production CLI fails before key access on wrong bundletool and cleans staging/input handles', windowsOnly, async t => {
  const f = await fixture(t);
  const bundle = path.join(f.root, 'fake-bundletool.jar'); await writeFile(bundle, 'not bundletool');
  await assert.rejects(gate.validateToolchain({python,javaBin,buildTools,bundletool:bundle}),/bundletool checksum mismatch/);
  const args = ['-NoProfile','-NonInteractive','-File',signer,'-UnsignedApk',f.files.apk,'-UnsignedAab',f.files.aab,
    '-Mapping',f.files.mapping,'-Provenance',f.files.provenance,'-ExpectedSourceCommit',commit,'-ExpectedRunId','123',
    '-OutputDirectory',f.output,'-JavaBin',javaBin,'-BuildTools',buildTools,
    '-Bundletool',bundle,'-NodePath',process.execPath,'-PythonPath',python,'-KeyRoot',path.join(f.root,'absent-synthetic-keys')];
  let failed;
  try { execFileSync(powershell,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true,env:shellEnv}); } catch(e) { failed=e; }
  assert.equal(failed?.status,1);
  assert.equal(failed.stdout.trim(),'Local production signing failed; no output published. Details suppressed.');
  assert.equal(failed.stderr,'');
  assert.ok(!(await readdir(f.root)).some(n => n.startsWith('.local-signing-pending-') || n === 'out'));
  await writeFile(f.files.apk,'handles released');
  await mkdir(f.output); await writeFile(path.join(f.output,'keep'),'existing');
  assert.throws(() => execFileSync(powershell,args,{stdio:'pipe',windowsHide:true,env:shellEnv}));
  assert.equal(await readFile(path.join(f.output,'keep'),'utf8'),'existing');
});

test('native tool boundary rejects wrong identity, alignment, config, and tool failures', async () => {
  const o={javaBin:'C:\\synthetic-jdk',buildTools:'C:\\synthetic-build-tools',bundletool:'C:\\synthetic.jar'};
  const files={apk:'synthetic.apk',aab:'synthetic.aab'}, p=provenance();
  function adapter(mutation) {
    return (program,args) => {
      if(mutation==='toolFailure')throw Error('synthetic tool failed');
      if(program.endsWith('aapt.exe'))return `package: name='${mutation==='package'?'wrong':p.package}' versionCode='${p.versionCode}' versionName='${p.version}'\nsdkVersion:'${mutation==='min'?'23':'24'}'\ntargetSdkVersion:'36'`;
      if(program.endsWith('zipalign.exe')) { assert.deepEqual(args.slice(0,5),['-c','-P','16','-v','4']); if(mutation==='alignment')throw Error('alignment failure');return ''; }
      assert.ok(args.includes('-Xmx96m')&&args.includes('-XX:ActiveProcessorCount=1'));
      if(args.includes('validate'))return '';
      if(args.includes('config'))return JSON.stringify({optimizations:{uncompressNativeLibraries:{alignment:mutation==='config'?'PAGE_ALIGNMENT_4K':'PAGE_ALIGNMENT_16K'}}});
      const xpath=args.find(a=>a.startsWith('--xpath='));
      const values={'/manifest/@package':p.package,'/manifest/@android:versionName':p.version,'/manifest/@android:versionCode':String(p.versionCode),'/manifest/uses-sdk/@android:minSdkVersion':'24','/manifest/uses-sdk/@android:targetSdkVersion':mutation==='target'?'35':'36'};
      return values[xpath.slice(8)];
    };
  }
  await gate.verifyNativeIdentity(o,files,p,adapter(''));
  for(const failure of ['package','min','alignment','target','config','toolFailure'])await assert.rejects(gate.verifyNativeIdentity(o,files,p,adapter(failure)));
});

test('verification adapter bounds execution and reaps owned sleeper tree', windowsOnly, async t => {
  const f = await fixture(t);
  const pidFile = path.join(f.root, 'pids.json'), sentinel = path.join(f.root, 'late-success');
  const code = `const {spawn}=require('node:child_process');const fs=require('node:fs');
    const child=spawn(process.execPath,['-e', ${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'unexpected'),6000);`)} ,${JSON.stringify(sentinel)}],{stdio:'ignore',windowsHide:true});
    fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid])); console.log('SENSITIVE');setInterval(()=>{},1000);`;
  assert.equal(typeof gate.runTool, 'function', 'bounded runtime adapter must be testable');
  await assert.rejects(gate.runTool(process.execPath, ['-e', code], 1500), /^Error: Local verification tool failed \(output suppressed\)$/);
  const pids = JSON.parse(await readFile(pidFile, 'utf8'));
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), 'owned child survived');
  assert.equal(await readFile(f.files.apk, 'utf8'), 'abc');
  assert.ok(!(await readdir(f.root)).includes('late-success'));
});

test('Windows private adapter timeout kills owned child and descendant before staging cleanup', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const source = await readFile(signer, 'utf8');
  assert.match(source, /function Invoke-PrivateTool[^\n]*TimeoutMilliseconds/, 'bounded wait must exist before launching sleeper');
  const script = path.join(f.root, 'timeout-test.ps1');
  await writeFile(script, `param($Signer,$Root,$Node)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Signer,[ref]$tokens,[ref]$errors)
foreach($n in @('Invoke-PrivateTool','Quote-Argument','Remove-OwnedStage','Assert-LocalPath')) {
 $fn=$ast.FindAll({param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst]},$true) | Where-Object Name -eq $n
 Invoke-Expression $fn.Extent.Text
}
$stage=Join-Path $Root ('.local-signing-pending-'+[Guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $stage
$pidFile=Join-Path $stage 'pids.json';$sentinel=Join-Path $Root 'late-success'
$child=Join-Path $Root 'sleeper.cjs'
[IO.File]::WriteAllText($child,'const fs=require("node:fs");const c=require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>require(''node:fs'').writeFileSync(process.argv[1],process.env.CS_STORE_PASS),6000)",process.argv[3]],{stdio:"ignore",windowsHide:true});fs.writeFileSync(process.argv[2],JSON.stringify([process.pid,c.pid]));console.log("SENSITIVE");setInterval(()=>{},1000);')
$secure=ConvertTo-SecureString 'synthetic-secret' -AsPlainText -Force
$rejected=$false
try { Invoke-PrivateTool $Node @($child,$pidFile,$sentinel) @{CS_STORE_PASS=$secure} -TimeoutMilliseconds 1500 }
catch { if($_.Exception.Message -cne 'Local tool failed; output and arguments suppressed.'){throw};$rejected=$true }
finally { $secure.Dispose() }
if(-not $rejected){throw 'Timeout accepted'}
foreach($owned in (Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json)) {
 try { $p=[Diagnostics.Process]::GetProcessById($owned) } catch { continue }
 try { if(-not $p.HasExited){throw 'Owned child survived'} } finally { $p.Dispose() }
}
Remove-OwnedStage $stage (Join-Path $Root 'out')
if((Test-Path $stage) -or (Test-Path $sentinel) -or (Test-Path Env:CS_STORE_PASS)){throw 'Leftover state'}
Write-Output 'TIMEOUT_OK'
`);
  assert.equal(execFileSync(powershell, ['-NoProfile','-NonInteractive','-File',script,signer,f.root,process.execPath], {encoding:'utf8',env:shellEnv,windowsHide:true,timeout:15000}).trim(), 'TIMEOUT_OK');
  assert.ok(!(await readdir(f.root)).some(n => n === 'out' || n.includes('pending') || n === 'late-success'));
});

test('verification adapter cancellation reaps owned process before rejecting', windowsOnly, async t => {
  const f = await fixture(t), pidFile = path.join(f.root, 'cancel-pid');
  const pending = gate.runTool(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));console.error('PRIVATE');setInterval(()=>{},1000);`]);
  const rejected = assert.rejects(pending, /^Error: Local verification tool failed \(output suppressed\)$/);
  let pid;
  for (let i = 0; i < 100 && !pid; i++) {
    try { pid = Number(await readFile(pidFile, 'utf8')); } catch {}
    if (!pid) await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(pid, 'controlled process started');
  process.emit('SIGTERM');
  await rejected;
  assert.throws(() => process.kill(pid, 0));
});
