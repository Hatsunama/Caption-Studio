import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expo = JSON.parse(readFileSync(path.join(root, 'app.json'), 'utf8')).expo;

test('the Android adaptive foreground reuses the app icon asset', () => {
  const foreground = expo.android.adaptiveIcon.foregroundImage;
  assert.equal(foreground, expo.icon);
  assert.ok(existsSync(path.join(root, foreground)));
  assert.ok(existsSync(path.join(root, expo.android.adaptiveIcon.backgroundImage)));
  assert.ok(existsSync(path.join(root, expo.android.adaptiveIcon.monochromeImage)));
});
