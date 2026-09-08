import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Android dependency verification follows npm package ownership instead of hoisting', () => {
  const source = readFileSync(new URL('../scripts/patch-android-dependencies.js', import.meta.url), 'utf8');
  assert.match(source, /resolvePackageRoot\('expo', projectRoot\)/);
  assert.match(source, /resolvePackageRoot\('expo-modules-core', expoRoot\)/);
  assert.doesNotMatch(source, /path\.join\(nodeModules, 'expo-modules-core'/);
});
