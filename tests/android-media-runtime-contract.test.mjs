import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const appConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'app.json'), 'utf8'));
const require = createRequire(import.meta.url);
const lintContract = require('../plugins/with-android-lint-contract.js');
const lintConfig = fs.readFileSync(path.join(repoRoot, 'config', 'android-lint.xml'), 'utf8');

function pluginOptions(name) {
  const entry = appConfig.expo.plugins.find(
    (plugin) => plugin === name || (Array.isArray(plugin) && plugin[0] === name)
  );
  assert.ok(Array.isArray(entry), `${name} must declare explicit native capability options`);
  return entry[1];
}

test('Expo media modules are configured for foreground-only editing', () => {
  assert.deepEqual(pluginOptions('expo-video'), {
    supportsBackgroundPlayback: false,
    supportsPictureInPicture: false,
  });
  assert.deepEqual(pluginOptions('expo-audio'), {
    microphonePermission: false,
    recordAudioAndroid: false,
    enableBackgroundRecording: false,
    enableBackgroundPlayback: false,
  });
});

test('Android lint suppression is limited to the unregistered Expo Video service', () => {
  assert.equal(
    lintContract.LINT_CONFIG_LINE,
    'lintConfig = file("../../config/android-lint.xml")'
  );
  assert.match(lintConfig, /<issue id="NotificationPermission">/);
  assert.match(
    lintConfig,
    /usage from expo\[\.\]modules\[\.\]video\[\.\]playbackService\[\.\]ExpoVideoPlaybackService/
  );
  assert.doesNotMatch(lintConfig, /severity="(?:ignore|disable)"|id="all"/);
});

test('Android lint contract plugin is registered', () => {
  assert.equal(appConfig.expo.plugins.at(-1), './plugins/with-android-lint-contract');
});
