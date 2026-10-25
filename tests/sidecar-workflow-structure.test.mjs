import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/unsigned-store-build.yml', import.meta.url),
  'utf8',
);

test('unsigned prebuild retains explicit production package and verification', () => {
  assert.match(workflow, /CAPTION_STUDIO_EXPECTED_ANDROID_PACKAGE: com\.xmilo_at_your_side\.caption_studio/);
  assert.match(workflow, /name: Clean native prebuild and original release configuration verification\r?\n        env:\r?\n          NODE_ENV: production/);
  assert.match(workflow, /npx expo prebuild --platform android --clean --no-install/);
  assert.match(workflow, /npm run verify:android-config/);
});
