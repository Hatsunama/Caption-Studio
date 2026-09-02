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

test('release verification explicitly permits the fixed side-by-side package', () => {
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
