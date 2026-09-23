import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  FIXED_ANDROID_PACKAGE,
  PRODUCTION_ANDROID_PACKAGE,
  resolveExpectedAndroidPackage,
} = require('../scripts/verify-android-release-config.js');

test('release verification defaults to the production Android package', () => {
  assert.equal(resolveExpectedAndroidPackage({}), PRODUCTION_ANDROID_PACKAGE);
});

test('source and release verification use the same exact Android package', () => {
  assert.equal(PRODUCTION_ANDROID_PACKAGE, 'com.xmilo_at_your_side.caption_studio');
  assert.equal(FIXED_ANDROID_PACKAGE, PRODUCTION_ANDROID_PACKAGE);
  assert.equal(
    resolveExpectedAndroidPackage({
      CAPTION_STUDIO_EXPECTED_ANDROID_PACKAGE: FIXED_ANDROID_PACKAGE,
    }),
    FIXED_ANDROID_PACKAGE,
  );
});

test('release verification rejects arbitrary Android package overrides', () => {
  assert.throws(
    () =>
      resolveExpectedAndroidPackage({
        CAPTION_STUDIO_EXPECTED_ANDROID_PACKAGE: 'com.example.untrusted',
      }),
    /Unsupported Android application id requested/,
  );
});

test('release verification rejects both legacy Android package overrides', () => {
  for (const packageId of ['com.hatsunama.captionstudio', 'com.hatsunama.captionstudio.fixed']) {
    assert.throws(
      () => resolveExpectedAndroidPackage({ CAPTION_STUDIO_EXPECTED_ANDROID_PACKAGE: packageId }),
      /Unsupported Android application id requested/,
    );
  }
});
