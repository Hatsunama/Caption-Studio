// Runs the real producer adapter. Only identity/signature tools are fixtures;
// ZIP inspection and ABI checks run for real. A portable alignment adapter uses
// NDK readelf (MSYS Bash is unavailable in the Windows sandbox).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const [modulePath, fixtureRoot, bash, objdump] = process.argv.slice(2);
const gate = await import(pathToFileURL(modulePath));
const files = { apk: path.join(fixtureRoot, 'fixture.apk'), aab: path.join(fixtureRoot, 'fixture.aab'), mapping: path.join(fixtureRoot, 'mapping.txt') };
const python = process.platform === 'win32' ? 'python' : 'python3';
const run = (program, args, binary) => {
  if (program === 'python3' || program === 'python') return execFileSync(python, args, { encoding: 'utf8', windowsHide: true });
  if (program === 'bash') return execFileSync(python, ['-B', '-c', `import sys,zipfile,pathlib,subprocess,tempfile,re
with zipfile.ZipFile(sys.argv[1]) as z:
 for n in z.namelist():
  if re.match(r'^lib/(arm64-v8a|x86_64)/[^/]+[.]so$',n):
   with tempfile.TemporaryDirectory(dir=sys.argv[3]) as t:
    p=pathlib.Path(t)/'probe.so'; p.write_bytes(z.read(n))
    if sys.argv[2] != 'fixture':
     text=subprocess.check_output([sys.argv[2],'-lW',str(p)],text=True)
     values=re.findall(r'LOAD[^\\n]*?0x([0-9a-f]+)\\s*$',text,re.M)
     assert values and all(int(v,16)>=16384 for v in values), text
    else:
     import struct
     b=p.read_bytes(); off=struct.unpack_from('<Q',b,32)[0]; size,count=struct.unpack_from('<HH',b,54)
     values=[struct.unpack_from('<Q',b,off+i*size+48)[0] for i in range(count) if struct.unpack_from('<I',b,off+i*size)[0]==1]
     assert values and all(v>=16384 and not v&(v-1) for v in values)
`, args[1], args[2].replace('objdump', 'readelf'), fixtureRoot], { encoding: 'utf8', windowsHide: true });
  if (program === 'jarsigner') return 'jar is unsigned';
  if (program === 'unzip') {
    if (args[0] === '-Z') return execFileSync(python, ['-B', '-c', 'import sys,zipfile; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', args.at(-1)], { encoding: 'utf8' });
    assert.equal(binary, true); return Buffer.from('exact R8 map');
  }
  if (path.basename(program).startsWith('aapt')) return "package: name='com.xmilo_at_your_side.caption_studio' versionCode='148' versionName='1.4.136'\nsdkVersion:'24'\ntargetSdkVersion:'36'\n";
  if (program === 'java' && args.includes('manifest')) return Object.entries({ '@package': 'com.xmilo_at_your_side.caption_studio', '@android:versionName': '1.4.136', '@android:versionCode': '148', '@android:minSdkVersion': '24', '@android:targetSdkVersion': '36' }).find(([key]) => args.at(-1).endsWith(key))[1];
  if (program === 'java' && args.includes('config')) return JSON.stringify({ optimizations: { uncompressNativeLibraries: { alignment: 'PAGE_ALIGNMENT_16K' } } });
  return '';
};
const evidence = await gate.inspectPayloads({ source: path.resolve(path.dirname(modulePath), '..'), files,
  bundletool: 'fixture', objdump, buildTools: fixtureRoot, temporary: fixtureRoot,
  nativeCompatibility: { ndk: path.join(fixtureRoot, 'ndk'), contract: path.join(fixtureRoot, 'contract.json') } }, run);
gate.assertPayload(evidence, gate.parseRelease('1.4.136', '148', { expo: { android: { package: 'com.xmilo_at_your_side.caption_studio' } } }));
console.log('PRODUCER_ACCEPTED_ARCHIVES');
