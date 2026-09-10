import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

test('splash API contract wraps the Expo Android splash style generator', async () => {
  const config = JSON.parse(await readFile(new URL('app.json', root), 'utf8'));
  const plugins = config.expo.plugins.map((entry) => Array.isArray(entry) ? entry[0] : entry);
  const expoIndex = plugins.indexOf('expo-splash-screen');
  const contractIndex = plugins.indexOf('./plugins/with-splash-screen-api-contract');
  assert.ok(expoIndex >= 0);
  assert.ok(contractIndex >= 0);
  assert.ok(contractIndex < expoIndex);
});

test('splash API contract targets only the Android 13 behavior item', async () => {
  const plugin = await readFile(new URL('plugins/with-splash-screen-api-contract.js', root), 'utf8');
  assert.match(plugin, /Theme\.App\.SplashScreen/);
  assert.match(plugin, /android:windowSplashScreenBehavior/);
  assert.match(plugin, /'tools:targetApi': '33'/);
  assert.doesNotMatch(plugin, /lint-baseline|NewApi|abortOnError/);
});
