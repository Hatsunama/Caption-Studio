import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const mediaManifest = readFileSync(
  new URL('../modules/caption-media/android/src/main/AndroidManifest.xml', import.meta.url),
  'utf8',
);
const appPermissionPolicy = readFileSync(
  new URL('../plugins/with-legacy-export-permission.js', import.meta.url),
  'utf8',
);

test('legacy external-write permission is owned by the app manifest policy, not a media library', () => {
  assert.doesNotMatch(mediaManifest, /android\.permission\.WRITE_EXTERNAL_STORAGE/);
  assert.match(appPermissionPolicy, /'android:maxSdkVersion': '28'/);
  assert.match(appPermissionPolicy, /'tools:replace': 'android:maxSdkVersion'/);
});
