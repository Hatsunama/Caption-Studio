import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const plugin = readFileSync(new URL('../plugins/with-legacy-export-permission.js', import.meta.url), 'utf8');

test('legacy export permission declares the tools namespace used by its replace attribute', () => {
  const module = { exports: {} };
  runInNewContext(plugin, { module, require(name) {
    assert.equal(name, 'expo/config-plugins');
    return { withAndroidManifest: (config, callback) => callback(config) };
  } });
  const config = module.exports({ modResults: { manifest: { $: {}, 'uses-permission': [] } } });
  const manifest = config.modResults.manifest;
  assert.equal(manifest.$['xmlns:tools'], 'http://schemas.android.com/tools');
  assert.equal(manifest['uses-permission'][0].$['tools:replace'], 'android:maxSdkVersion');
});
