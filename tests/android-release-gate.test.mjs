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
  for (const file of ['ci.yml', 'publish-sidecar.yml']) {
    const workflow = await readFile(new URL(`.github/workflows/${file}`, root), 'utf8');
    const testCommand = workflow.match(/^\s*run: (\.\/gradlew (?:[^\r\n]*testReleaseUnitTest[^\r\n]*))$/m)?.[1];
    assert.ok(testCommand, `${file} must run explicit native release tests`);
    const args = testCommand.split(/\s+/).slice(1);
    assert.deepEqual(args.slice(0, ownedTasks.length), ownedTasks);
    assert.deepEqual(args.slice(ownedTasks.length), ['--no-daemon', '--stacktrace', '--warning-mode', 'all']);
    assert.doesNotMatch(testCommand, /expo-modules-core|(?:^|\s)(?:-x|--exclude-task)(?:\s|$)/);
    assert.ok(workflow.indexOf(testCommand) < workflow.indexOf(':app:assembleRelease'));
  }
});
