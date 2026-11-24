import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./verify-android-native-compatibility.py', import.meta.url));
const defaultContract = fileURLToPath(new URL('../config/product-contract.json', import.meta.url));
const abis = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'];

// The receipt is exact-schema, hash-bound evidence. It is never a substitute for
// executing the parser on final bytes at the producer/local signing boundaries.
export function assertNativeCompatibility(receipts, hashes) {
  const translationMinSdk = JSON.parse(readFileSync(defaultContract, 'utf8')).translation?.minimumAndroidSdk;
  assert.ok(Number.isSafeInteger(translationMinSdk) && translationMinSdk > 24 && translationMinSdk <= 36,
    'Missing/invalid translation.minimumAndroidSdk contract');
  assert.deepEqual(Object.keys(receipts ?? {}).sort(), ['aab', 'apk'], 'Missing native compatibility receipts');
  for (const format of ['apk', 'aab']) {
    const r = receipts[format];
    assert.ok(Number.isSafeInteger(r?.libraries) && r.libraries >= 10, 'Native library count');
    assert.deepEqual(r, { schemaVersion: 1, sha256: hashes[format], format,
      coreMinSdk: 24, translationMinSdk, libraries: r.libraries, abis }, 'Native compatibility receipt mismatch');
    assert.match(r.sha256, /^[0-9a-f]{64}$/);
  }
  return receipts;
}

export function verifyAndroidNativeCompatibility({ files, ndk, objdump, contract = defaultContract }, run =
  (program, args) => execFileSync(program, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 })) {
  ndk ??= objdump && path.resolve(path.dirname(objdump), '../../../../..');
  assert.ok(ndk, 'NDK required for native compatibility');
  const python = process.platform === 'win32' ? 'python' : 'python3';
  return JSON.parse(run(python, ['-B', script, '--apk', files.apk, '--aab', files.aab,
    '--ndk', ndk, '--contract', contract]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok(args.length === 6 && args[0] === '--apk' && args[2] === '--aab' && args[4] === '--ndk',
    'Usage: --apk APK --aab AAB --ndk NDK');
  const result = verifyAndroidNativeCompatibility({ files: { apk: args[1], aab: args[3] }, ndk: args[5] });
  assertNativeCompatibility(result, { apk: result.apk?.sha256, aab: result.aab?.sha256 });
  process.stdout.write(JSON.stringify(result) + '\n');
}
