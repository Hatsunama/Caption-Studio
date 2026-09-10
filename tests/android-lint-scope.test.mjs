import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

test('Android lint excludes analyzers by dependency ownership, not package name', async () => {
  const policy = await readFile(new URL('scripts/first-party-android-lint.gradle', root), 'utf8');
  assert.match(policy, /new File\(project\.rootDir\.parentFile, 'node_modules'\)\.canonicalFile\.toPath\(\)/);
  assert.match(policy, /projectPath\.startsWith\(nodeModulesRoot\)/);
  assert.match(policy, /task\.name\.startsWith\('lintAnalyze'\)/);
  assert.doesNotMatch(policy, /react-native-(?:worklets|reanimated)/);
});

test('both release workflows use the same first-party Android lint policy', async () => {
  for (const file of ['.github/workflows/ci.yml', '.github/workflows/publish-sidecar.yml']) {
    const workflow = await readFile(new URL(file, root), 'utf8');
    assert.match(workflow, /:app:lintRelease/);
    assert.match(workflow, /--init-script \.\.\/scripts\/first-party-android-lint\.gradle/);
    assert.doesNotMatch(workflow, /-x :react-native-(?:worklets|reanimated):lintAnalyzeRelease/);
  }
});
