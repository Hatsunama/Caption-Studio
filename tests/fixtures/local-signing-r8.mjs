import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const python = process.platform === 'win32' ? 'python' : 'python3';
// Exact r8.json from signed-1.4.145-44091481517's final Play AAB.
export const oldR8Metadata = JSON.parse(readFileSync(new URL('./local-signing-r8-old.json', import.meta.url), 'utf8'));
// Small real ZIPs: SHA-256 is computed from the same DEX bytes written to both
// containers, just as R8 8.13.19 does. No release tools or keys are involved.
export function writeR8Fixture(files, mutation = '') {
  execFileSync(python, ['-c', String.raw`import sys,zipfile,hashlib,json
apk,aab,mutation=sys.argv[1:4]
dex=b'dex\n035\x00synthetic fixture bytecode'
metadata={'options':{'isOptimizationsEnabled':True,'isShrinkingEnabled':True,'isObfuscationEnabled':True},'stats':{'noOptimizationPercentage':12.5},'dexFiles':[{'checksum':hashlib.sha256(dex).hexdigest(),'startup':False}]}
if mutation=='old-release':
 metadata=json.loads(sys.argv[4])
if mutation=='disabled': metadata['options']['isOptimizationsEnabled']=False
if mutation=='all-unoptimized': metadata['stats']['noOptimizationPercentage']=100.0
if mutation=='nonfinite': metadata['stats']['noOptimizationPercentage']=float('inf')
if mutation=='negative': metadata['stats']['noOptimizationPercentage']=-1
if mutation=='out-of-range': metadata['stats']['noOptimizationPercentage']=101
if mutation=='string-stat': metadata['stats']['noOptimizationPercentage']='12.5'
if mutation=='missing-stat': metadata['stats']={}
if mutation=='wrong-checksum': metadata['dexFiles'][0]['checksum']='0'*64
if mutation=='empty-inventory': metadata['dexFiles']=[]
for file,bundle in [(apk,False),(aab,True)]:
 with zipfile.ZipFile(file,'w',compression=zipfile.ZIP_DEFLATED) as z:
  z.writestr('base/manifest/AndroidManifest.xml' if bundle else 'AndroidManifest.xml','synthetic manifest')
  z.writestr('base/dex/classes.dex' if bundle else 'classes.dex',dex+(b'changed' if mutation=='apk-dex' and not bundle else b''))
  if bundle:
   z.writestr('BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map','exact R8 map')
   if mutation!='missing':
    z.writestr('BUNDLE-METADATA/com.android.tools/r8.json','{' if mutation=='malformed' else json.dumps(metadata))
`, files.apk, files.aab, mutation, JSON.stringify(oldR8Metadata)], { stdio: 'pipe', windowsHide: true });
}
