import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAndroidAbiCoverage } from '../scripts/verify-android-abi.mjs';

const abis = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'];
const coreLibraries = ['libreactnative.so', 'librnwhisper.so'];
const translationAbis = ['arm64-v8a', 'x86_64'];
const entries = (format) => {
  const prefix = format === 'apk' ? 'lib' : 'base/lib';
  return [
    ...abis.flatMap((abi) => coreLibraries.map((library) => `${prefix}/${abi}/${library}`)),
    ...translationAbis.map((abi) => `${prefix}/${abi}/liblitertlm_jni.so`),
  ];
};

test('APK and AAB require core engines on every ABI and LiteRT-LM on supported 64-bit ABIs', () => {
  assert.doesNotThrow(() => assertAndroidAbiCoverage(entries('base'), 'base'));
  assert.doesNotThrow(() => assertAndroidAbiCoverage(entries('apk'), 'apk'));
  assert.throws(() => assertAndroidAbiCoverage(entries('base').filter((path) => path !== 'base/lib/armeabi-v7a/librnwhisper.so'), 'base'),
    /armeabi-v7a.*librnwhisper/);
  assert.throws(() => assertAndroidAbiCoverage(entries('base').filter((path) => path !== 'base/lib/x86_64/liblitertlm_jni.so'), 'base'),
    /x86_64.*liblitertlm_jni/);
  assert.throws(() => assertAndroidAbiCoverage(entries('base').filter((path) => !path.includes('/x86/')), 'base'), /x86/);
});
