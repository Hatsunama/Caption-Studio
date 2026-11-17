import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const r8Entry = 'BUNDLE-METADATA/com.android.tools/r8.json';

// This is an artifact contract, independent of Gradle flags and provenance
// claims. Kept JNI/reflection code is expected; only 100% unoptimized fails.
// Older producer provenance remains schema v1, but old/missing/disabled R8
// artifact metadata is intentionally no longer accepted for new signing.
export function assertR8Optimization(metadata, aabHashes, apkHashes) {
  if (typeof metadata === 'string') metadata = JSON.parse(metadata);
  for (const key of ['isOptimizationsEnabled', 'isShrinkingEnabled', 'isObfuscationEnabled'])
    assert.equal(metadata?.options?.[key], true, `R8 ${key} must be enabled`);
  const percentage = metadata?.stats?.noOptimizationPercentage;
  assert.ok(typeof percentage === 'number' && Number.isFinite(percentage) &&
    percentage >= 0 && percentage < 100, 'R8 noOptimizationPercentage must be finite and in [0, 100)');

  const inventory = metadata?.dexFiles;
  assert.ok(Array.isArray(inventory) && inventory.length > 0, 'Missing R8 DEX checksum inventory');
  const expected = inventory.map(dex => {
    assert.match(dex?.checksum ?? '', /^[0-9a-f]{64}$/, 'Invalid R8 DEX SHA-256');
    return dex.checksum;
  }).sort();
  function dexInventory(hashes, bundle) {
    assert.ok(hashes && typeof hashes === 'object', 'Missing actual DEX hashes');
    const result = {};
    for (const [name, hash] of Object.entries(hashes).filter(([n]) => n.endsWith('.dex'))) {
      // Active pipeline is base-only. Refuse extra DEX in other modules/paths
      // rather than silently dropping it from the checksum inventory.
      assert.match(name, bundle ? /^base\/dex\/classes(?:[2-9]|[1-9][0-9]+)?\.dex$/ :
        /^classes(?:[2-9]|[1-9][0-9]+)?\.dex$/, 'Unexpected DEX archive path');
      assert.match(hash, /^[0-9a-f]{64}$/, 'Invalid actual DEX SHA-256');
      result[bundle ? name.slice('base/dex/'.length) : name] = hash;
    }
    assert.ok(Object.hasOwn(result, 'classes.dex'), 'Missing actual classes.dex');
    return result;
  }
  const aab = dexInventory(aabHashes, true), apk = dexInventory(apkHashes, false);
  assert.deepEqual(Object.values(aab).sort(), expected, 'R8 checksum inventory differs from actual AAB DEX');
  assert.deepEqual(apk, aab, 'APK DEX differs from R8-verified AAB DEX');
}

// Standard-library ZIP reader: stream DEX bytes, never extract archives or load
// entire DEX files into the Node heap. SHA-256 matches R8 8.13.19 r8.json.
const inspection = String.raw`import sys,zipfile,hashlib,json,re
result={}
for role,file in zip(('apk','aab'),sys.argv[1:]):
 hashes={}; metadata=None; seen=set()
 with zipfile.ZipFile(file) as z:
  for i in z.infolist():
   n=i.filename
   if n in seen or re.search(r'(^/|\\|(^|/)\.\.(/|$)|[\x00-\x1f])',n) or ':' in n: raise ValueError('Unsafe R8 ZIP entry')
   seen.add(n)
   if ((i.external_attr>>16)&0o170000) not in (0,0o100000,0o040000) or i.flag_bits&1: raise ValueError('Nonregular/encrypted R8 ZIP entry')
   if n.endswith('.dex'):
    h=hashlib.sha256()
    with z.open(i) as s:
     while True:
      b=s.read(65536)
      if not b: break
      h.update(b)
    hashes[n]=h.hexdigest()
   if role=='aab' and n=='BUNDLE-METADATA/com.android.tools/r8.json':
    if i.file_size>1048576: raise ValueError('Oversize R8 metadata')
    metadata=z.read(i).decode('utf-8')
 result[role]={'hashes':hashes,'r8Metadata':metadata}
print(json.dumps(result))
`;

export function inspectR8Artifacts(files) {
  const archives = JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3',
    ['-c', inspection, files.apk, files.aab], { encoding: 'utf8', windowsHide: true,
      timeout: 180000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  assertR8Optimization(archives.aab.r8Metadata, archives.aab.hashes, archives.apk.hashes);
  return archives;
}

export function optimizationSummary(archives) {
  assertR8Optimization(archives.aab.r8Metadata, archives.aab.hashes, archives.apk.hashes);
  const metadata = typeof archives.aab.r8Metadata === 'string'
    ? JSON.parse(archives.aab.r8Metadata) : archives.aab.r8Metadata;
  return { schemaVersion: 1, options: {
    isOptimizationsEnabled: metadata.options.isOptimizationsEnabled,
    isShrinkingEnabled: metadata.options.isShrinkingEnabled,
    isObfuscationEnabled: metadata.options.isObfuscationEnabled,
  }, stats: Object.fromEntries(['noOptimizationPercentage', 'noObfuscationPercentage', 'noShrinkingPercentage']
    .filter(key => Object.hasOwn(metadata.stats, key)).map(key => [key, metadata.stats[key]])),
    dexSha256Match: true, dexFiles: Object.entries(archives.aab.hashes)
      .filter(([name]) => name.endsWith('.dex')).map(([name, sha256]) => ({ name, sha256 })) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), files = {};
    assert.equal(args.length, 4, 'Usage: --apk APK --aab AAB');
    for (let i = 0; i < args.length; i += 2) {
      assert.ok(['--apk', '--aab'].includes(args[i]) && args[i + 1] &&
        !args[i + 1].startsWith('--'), 'Usage: --apk APK --aab AAB');
      const key = args[i].slice(2);
      assert.ok(!Object.hasOwn(files, key), 'Duplicate artifact argument');
      files[key] = path.resolve(args[i + 1]);
    }
    assert.ok(files.apk && files.aab, 'Both APK and AAB required');
    console.log(JSON.stringify(optimizationSummary(inspectR8Artifacts(files))));
  } catch (error) {
    console.error(`R8 artifact verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
