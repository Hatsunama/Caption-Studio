import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAndroidAbiCoverage } from '../scripts/verify-android-abi.mjs';

const abis = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'];
const libraries = ['libreactnative.so', 'librnwhisper.so', 'liblitertlm_jni.so'];
const entries = (format) => abis.flatMap((abi) => libraries.map((library) => `${format === 'apk' ? 'lib' : 'base/lib'}/${abi}/${library}`));

test('APK and AAB must contain every declared ABI and each required native engine', () => {
  assert.doesNotThrow(() => assertAndroidAbiCoverage(entries('base'), 'base'));
  assert.doesNotThrow(() => assertAndroidAbiCoverage(entries('apk'), 'apk'));
  assert.throws(() => assertAndroidAbiCoverage(entries('base').filter((path) => path !== 'base/lib/armeabi-v7a/liblitertlm_jni.so'), 'base'),
    /armeabi-v7a.*liblitertlm_jni/);
  assert.throws(() => assertAndroidAbiCoverage(entries('base').filter((path) => !path.includes('/x86/')), 'base'), /x86/);
});
