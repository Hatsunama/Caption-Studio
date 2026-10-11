import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../plugins/with-font-scale-configuration.js', import.meta.url), 'utf8');
const generatedFlags = 'keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode';

// Execute the actual CommonJS plugin and its registered Android manifest mod.
// Only Expo's registration boundary is stubbed; no dependencies or prebuild needed.
// These tests prove the manifest transformation, not Android lifecycle behavior.
function register(config = {}) {
  let callback;
  const module = { exports: {} };
  runInNewContext(source, {
    module,
    require(id) {
      assert.equal(id, 'expo/config-plugins');
      return {
        withAndroidManifest(received, mod) {
          assert.equal(received, config);
          assert.equal(callback, undefined, 'register exactly one manifest mod');
          callback = mod;
          return received;
        },
      };
    },
  }, { filename: 'with-font-scale-configuration.js' });
  assert.equal(typeof module.exports, 'function');
  assert.equal(module.exports(config), config);
  assert.equal(typeof callback, 'function');
  return callback;
}

function fixture(flags = generatedFlags) {
  const main = {
    $: {
      'android:name': '.MainActivity',
      'android:configChanges': flags,
      'android:screenOrientation': 'unspecified',
      'android:launchMode': 'singleTask',
      'android:exported': 'true',
    },
    'intent-filter': [{ action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }] }],
  };
  const modResults = {
    manifest: {
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android', package: 'com.example.caption' },
      'uses-permission': [{ $: { 'android:name': 'android.permission.INTERNET' } }],
      application: [{
        $: { 'android:name': '.MainApplication' },
        activity: [
          { $: { 'android:name': '.ShareActivity', 'android:configChanges': 'locale' } },
          main,
          { $: { 'android:name': 'vendor.MainActivity', 'android:configChanges': 'density' } },
        ],
        'activity-alias': [{ $: { 'android:name': '.Launcher', 'android:targetActivity': '.MainActivity' } }],
      }, {
        $: { 'android:name': '.OtherApplication' },
        activity: [{ $: { 'android:name': '.MainActivity', 'android:configChanges': 'locale' } }],
      }],
    },
  };
  return { main, next: { name: 'Caption Studio', modResults, modRequest: { platform: 'android' } } };
}

test('plugin registration preserves the Expo config and defers native changes to the mod', () => {
  const config = { name: 'Caption Studio', ios: { supportsTablet: true }, android: { package: 'com.example.caption' } };
  const before = structuredClone(config);
  register(config);
  assert.deepEqual(config, before);
});

test('Samsung font-scale recreation regression adds only fontScale and preserves the entire remaining manifest', () => {
  const { main, next } = fixture();
  const expected = structuredClone(next);
  expected.modResults.manifest.application[0].activity[1].$['android:configChanges'] = `${generatedFlags}|fontScale`;
  const originalManifest = next.modResults;
  assert.equal(register()(next), next);
  assert.equal(next.modResults, originalManifest);
  assert.equal(main.$['android:configChanges'], `${generatedFlags}|fontScale`);
  assert.deepEqual(next, expected);
});

test('repeated plugin application appends fontScale exactly once', () => {
  const { main, next } = fixture();
  register()(next);
  const once = structuredClone(next);
  register()(next);
  assert.deepEqual(next, once);
  assert.equal(main.$['android:configChanges'].split('|').filter((flag) => flag === 'fontScale').length, 1);
});

test('existing fontScale tokens and flag formatting remain byte-for-byte unchanged', () => {
  for (const flags of ['fontScale', `fontScale|${generatedFlags}`, 'orientation | fontScale | customFlag']) {
    const { next } = fixture(flags);
    const before = structuredClone(next);
    register()(next);
    assert.deepEqual(next, before);
  }
});

test('missing or empty configChanges gets fontScale without broad configuration opt-outs', () => {
  for (const flags of [undefined, '']) {
    const { main, next } = fixture(flags);
    if (flags === undefined) delete main.$['android:configChanges'];
    const expected = structuredClone(next);
    expected.modResults.manifest.application[0].activity[1].$['android:configChanges'] = 'fontScale';
    register()(next);
    assert.deepEqual(next, expected);
  }
});

test('preserves unfamiliar flags and matches fontScale as a whole token', () => {
  const flags = 'customFlag|fontScaleFuture|orientation|customFlag';
  const { main, next } = fixture(flags);
  register()(next);
  assert.equal(main.$['android:configChanges'], `${flags}|fontScale`);
});

test('missing Expo MainActivity fails explicitly without modifying another activity', () => {
  const { next } = fixture();
  next.modResults.manifest.application[0].activity.splice(1, 1);
  const before = structuredClone(next);
  assert.throws(() => register()(next), /MainActivity/);
  assert.deepEqual(next, before);
});

test('missing application fails explicitly without inventing native manifest entries', () => {
  const next = { modResults: { manifest: {} } };
  const before = structuredClone(next);
  assert.throws(() => register()(next), /MainActivity/);
  assert.deepEqual(next, before);
});
