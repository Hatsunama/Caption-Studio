import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAndroidAbiCoverage } from '../scripts/verify-android-abi.mjs';
import { assertNativeCompatibility } from '../scripts/verify-android-native-compatibility.mjs';

const abis = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'];
const entries = prefix => abis.flatMap(abi => [
  'libreactnative.so', 'librnwhisper.so', 'libexpo-sqlite.so',
  ...(['arm64-v8a', 'x86_64'].includes(abi) ? ['liblitertlm_jni.so'] : []),
].map(name => `${prefix}/${abi}/${name}`));

for (const [format, prefix] of [['apk', 'lib'], ['base', 'base/lib']]) {
  test(`${format}: complete essential libraries and asymmetric optional JNI pass`, () => {
    assertAndroidAbiCoverage([...entries(prefix), `${prefix}/arm64-v8a/liboptional.so`], format);
  });
  for (const missing of [...abis.map(abi => [abi]), ['armeabi-v7a', 'x86', 'x86_64']]) {
    test(`${format}: rejects SQLite absent on ${missing.join(', ')}`, () => {
      const names = entries(prefix).filter(name => !missing.some(abi => name === `${prefix}/${abi}/libexpo-sqlite.so`));
      // Other-ABI and wrong-root copies cannot satisfy the missing path.
      names.push('other/lib/x86/libexpo-sqlite.so');
      assert.throws(() => assertAndroidAbiCoverage(names, format), /libexpo-sqlite[.]so/);
    });
  }
}

test('native receipts require at least fourteen libraries and preserve exact hash/schema checks', () => {
  const hashes = { apk: 'a'.repeat(64), aab: 'b'.repeat(64) };
  const receipts = () => Object.fromEntries(['apk', 'aab'].map(format => [format, {
    schemaVersion: 1, sha256: hashes[format], format, coreMinSdk: 24,
    translationMinSdk: 26, libraries: 14, abis,
  }]));
  assertNativeCompatibility(receipts(), hashes);
  for (const format of ['apk', 'aab']) {
    for (const libraries of [10, 11, 12, 13]) {
      const r = receipts(); r[format].libraries = libraries;
      assert.throws(() => assertNativeCompatibility(r, hashes), /Native library count/);
    }
    const r = receipts(); r[format].sha256 = 'c'.repeat(64);
    assert.throws(() => assertNativeCompatibility(r, hashes), /receipt mismatch/);
    const extra = receipts(); extra[format].extra = true;
    assert.throws(() => assertNativeCompatibility(extra, hashes), /receipt mismatch/);
  }
});
