import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/publish-sidecar.yml', import.meta.url),
  'utf8',
);

test('sidecar prebuild keeps identity selection inside the named workflow step', () => {
  assert.match(
    workflow,
    /^      - name: Generate clean Android project\r?\n        env:\r?\n          NODE_ENV: production\r?\n          CAPTION_STUDIO_EXPECTED_ANDROID_PACKAGE: com\.hatsunama\.captionstudio\.fixed\r?\n        run: \|$/m,
  );
});
