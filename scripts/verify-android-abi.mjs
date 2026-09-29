import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const requiredAbis = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'];
const requiredLibraries = ['libreactnative.so', 'librnwhisper.so', 'liblitertlm_jni.so'];

export function assertAndroidAbiCoverage(entries, format) {
  assert.ok(format === 'apk' || format === 'base', 'Unknown Android archive format');
  const paths = new Set(entries);
  const prefix = format === 'apk' ? 'lib' : 'base/lib';
  for (const abi of requiredAbis) {
    for (const library of requiredLibraries) {
      assert.ok(paths.has(`${prefix}/${abi}/${library}`), `Missing ${abi}/${library} in ${format} archive`);
    }
  }
}

function archiveEntries(file) {
  const listing = execFileSync('unzip', ['-Z', '-1', file], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return listing.split(/\r?\n/).filter(Boolean);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok((args.length === 2 || args.length === 4)
    && args.every((value, index) => index % 2 === 1 || value === '--apk' || value === '--aab'),
  'Usage: verify-android-abi.mjs --apk APK [--aab AAB] | --aab AAB');
  for (let index = 0; index < args.length; index += 2) {
    assertAndroidAbiCoverage(archiveEntries(args[index + 1]), args[index] === '--apk' ? 'apk' : 'base');
  }
  process.stdout.write('Android native ABI coverage verified.\n');
}
