import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { configureSidecarApp } from '../scripts/configure-sidecar-release.mjs';

const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
const contract = JSON.parse(readFileSync(new URL('../config/product-contract.json', import.meta.url), 'utf8'));
const release = contract.android.release;

test('the Android release preserves the source app link and product identity', () => {
  assert.equal(release.scheme, app.expo.scheme);
  assert.equal(release.slug, app.expo.slug);
  assert.doesNotMatch(release.channel, /fixed/i);

  const configured = configureSidecarApp(app, app.expo.version, app.expo.android.versionCode);
  assert.equal(configured.expo.scheme, app.expo.scheme);
  assert.equal(configured.expo.slug, app.expo.slug);
  assert.equal(configured.expo.android.package, app.expo.android.package);
  assert.equal(configured.expo.extra.releaseChannel, release.channel);
});
