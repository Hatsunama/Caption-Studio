import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.env.LINT_TRANSPORT_SOURCE ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const read = p => readFileSync(resolve(root, p), 'utf8');
const init = 'scripts/robolectric-lint-transport.init.gradle';

for (const workflow of ['ci.yml', 'unsigned-store-build.yml']) {
  test(`${workflow}: lint itself loads shared transport, independently of SDK36 Test launcher`, () => {
    const source = read(`.github/workflows/${workflow}`);
    const command = source.split(/\r?\n/).find(line => /run: .*gradlew :app:lintRelease\b/.test(line));
    assert.ok(command, 'Original release lint command must remain');
    assert.ok(command.includes(`--init-script ../${init}`), 'Expo lint model resolution lacks shared Robolectric transport');
    assert.ok(command.includes('--init-script ../scripts/first-party-android-lint.gradle'));
    assert.ok(!command.includes('sdk36-test-runtime'), 'Transport must not configure Test launcher');
    assert.match(source, /:app:testReleaseUnitTest :caption-diagnostics:testReleaseUnitTest :caption-media:testReleaseUnitTest :caption-translation:testReleaseUnitTest/);
  });
}

test('shared init uses the existing exclusive repository boundary without bootstrap/Test side effects', () => {
  assert.ok(existsSync(resolve(root, init)), 'Shared transport init is missing');
  const source = read(init);
  const module = read('modules/caption-media/android/robolectric-runtime.gradle');
  for (const text of [
    "name = 'captionRobolectricMirror'",
    "url = uri('https://maven-central.storage-download.googleapis.com/maven2/')",
    "includeModule('org.robolectric', 'android-all-instrumented')",
    "includeModule('org.robolectric', 'nativeruntime-dist-compat')",
  ]) {
    assert.ok(module.includes(text), `Existing reviewed policy changed: ${text}`);
    assert.ok(source.includes(text), `Shared policy differs: ${text}`);
  }
  assert.match(source, /gradle\.afterProject/);
  assert.match(source, /project\.repositories\.findByName\('captionRobolectricMirror'\)/);
  assert.match(source, /exclusiveContent/);
  assert.equal((source.match(/includeModule\(/g) ?? []).length, 2);
  assert.doesNotMatch(source, /withType|systemProperty|dependsOn|enabled\s*=|exclude|force|projectDir|prepareRobolectricRuntime/);
});
