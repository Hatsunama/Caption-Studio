import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const ownedTasks = [
  ':app:testReleaseUnitTest',
  ':caption-diagnostics:testReleaseUnitTest',
  ':caption-media:testReleaseUnitTest',
  ':caption-translation:testReleaseUnitTest',
];

test('both release workflows test every owned Android module before building', async () => {
  for (const file of ['ci.yml', 'unsigned-store-build.yml']) {
    const workflow = await readFile(new URL(`.github/workflows/${file}`, root), 'utf8');
    const testCommand = workflow.match(/^\s*run: (\.\/gradlew (?:[^\r\n]*testReleaseUnitTest[^\r\n]*))$/m)?.[1];
    assert.ok(testCommand, `${file} must run explicit native release tests`);
    const args = testCommand.split(/\s+/).slice(1);
    assert.deepEqual(args.slice(0, ownedTasks.length), ownedTasks);
    const unsignedArgs = file === 'unsigned-store-build.yml'
      ? ['--init-script', '../scripts/unsigned-play-release.gradle'] : [];
    assert.deepEqual(args.slice(ownedTasks.length), [...unsignedArgs,
      '--init-script', '../scripts/react-native-fontfit/sdk36-test-runtime.init.gradle',
      '-Dorg.gradle.java.installations.auto-detect=false',
      '-Dorg.gradle.java.installations.auto-download=false',
      '-Dorg.gradle.java.installations.paths="$JAVA_HOME_17_X64,$JAVA_HOME_21_X64"',
      '--no-daemon', '--stacktrace', '--warning-mode', 'all']);
    assert.doesNotMatch(testCommand, /expo-modules-core|(?:^|\s)(?:-x|--exclude-task)(?:\s|$)/);
    assert.ok(workflow.indexOf(testCommand) < workflow.indexOf(':app:assembleRelease'));
  }
});

test('CI validates actual R8 APK/AAB output before successful binary retention', async () => {
  const workflow = await readFile(new URL('.github/workflows/ci.yml', root), 'utf8');
  const command = 'node ./scripts/verify-r8-optimization.mjs --apk "$apk" --aab "$aab"';
  assert.match(workflow, /^\s*node \.\/scripts\/verify-r8-optimization\.mjs --apk "\$apk" --aab "\$aab"\s*$/m);
  assert.ok(workflow.indexOf(':app:assembleRelease :app:bundleRelease') < workflow.indexOf(command));
  assert.ok(workflow.indexOf(command) < workflow.indexOf('- name: Retain CI-signed release-validation APK and AAB'));
});
test('R8 regression suites run independently without weakening the full release gate', async () => {
  const workflow = await readFile(new URL('.github/workflows/unsigned-store-build.yml', root), 'utf8');
  const synthetic = workflow.slice(workflow.indexOf('  synthetic:'), workflow.indexOf('  unsigned:'));
  for (const suite of ['tests/r8-optimization.test.mjs', 'tests/android-release-config.test.mjs',
    'tests/android-release-gate.test.mjs', 'tests/local-release-signing.test.mjs'])
    assert.ok(synthetic.includes(suite), suite + ' must run without installing production dependencies');
  const release = await readFile(new URL('.github/workflows/ci.yml', root), 'utf8');
  assert.ok(release.includes('npm audit --omit=dev --audit-level=high'));
});