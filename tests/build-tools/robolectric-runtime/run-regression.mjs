import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, lstatSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { freemem, tmpdir } from 'node:os';

const tests = dirname(fileURLToPath(import.meta.url));
const source = resolve(tests, '../../..');
const gradleHome = process.argv[2];
assert(gradleHome, 'Pass an existing Gradle installation directory');
const realArtifacts = process.argv.includes('--real-artifacts');
const root = mkdtempSync(join(tmpdir(), 'caption-robolectric-fixture-'));
try {
  const fixture = join(root, 'project');
  mkdirSync(fixture);
  writeFileSync(join(fixture, 'settings.gradle'), "rootProject.name = 'robolectric-bootstrap-fixture'\n");
  writeFileSync(join(fixture, 'build.gradle'), readFileSync(join(tests, realArtifacts ? 'production.gradle' : 'fixture.gradle')));
  if (!realArtifacts) {
    for (const [repo, group, name, version, text] of [
      ...['7.0.0_r1-robolectric-r1-i7', '9-robolectric-4913185-2-i7', '10-robolectric-5803371-i7', '14-robolectric-10818077-i7', '16-robolectric-13921718-i7']
        .map(version => ['repo', 'org/robolectric', 'android-all-instrumented', version, 'tiny sdk']),
      ['repo', 'org/robolectric', 'nativeruntime-dist-compat', '1.0.18', 'tiny native'],
      ['other-repo', 'org/robolectric', 'unrelated', '1', 'other repository'],
      ['other-repo', 'org/robolectric', 'android-all-instrumented', 'fixture-only', 'must not resolve'],
    ]) {
      const directory = join(fixture, repo, group, name, version);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${name}-${version}.jar`), text);
      writeFileSync(join(directory, `${name}-${version}.pom`), `<project><modelVersion>4.0.0</modelVersion><groupId>${group.replaceAll('/', '.')}</groupId><artifactId>${name}</artifactId><version>${version}</version></project>`);
    }
  }
  const bootstrap = join(source, 'modules/caption-media/android/robolectric-runtime.gradle');
  assert(existsSync(bootstrap), 'Required Robolectric bootstrap/local SDK binding is missing');
  function run(args, expectedSuccess) {
    assert(freemem() >= 512 * 1024 * 1024, 'Need at least 512 MiB free physical memory');
    const command = ['-Xmx128m', '-XX:ActiveProcessorCount=1', '-XX:+UseSerialGC',
      '-Dorg.gradle.internal.instrumentation.agent=false', '-Dorg.gradle.jvmargs=-Xmx128m -XX:ActiveProcessorCount=1 -XX:+UseSerialGC',
      '-cp', join(gradleHome, 'lib/*'), 'org.gradle.launcher.GradleMain',
      ...(!realArtifacts ? ['--offline'] : []), '--no-daemon', '--no-watch-fs', '--max-workers=1', '--console=plain',
      '--project-dir', fixture, '--gradle-user-home', join(root, 'gradle-home'), `-Pbootstrap=${bootstrap}`, ...args];
    const result = spawnSync('java', command, { encoding: 'utf8', timeout: realArtifacts ? 600000 : 60000, maxBuffer: 4 * 1024 * 1024 });
    const output = (result.stdout ?? '') + (result.stderr ?? '');
    if ((result.status === 0) !== expectedSuccess) console.error(output);
    assert.equal(result.status === 0, expectedSuccess, result.error?.message ?? 'Unexpected Gradle result');
    console.log(expectedSuccess ? output : `PASS: observed expected Gradle rejection for ${args[0]}`);
    return output;
  }
  if (realArtifacts) {
    run(['prepareRobolectricRuntime'], true);
    console.log('PASS: unmodified production task resolved and verified all real pinned runtimes');
  } else {
    run(['verifyContract'], true);
    run(['fixtureTest', 'lateFixtureTest', '-PwiringOnly'], true);
    for (const task of ['fixtureTest', 'lateFixtureTest']) assert(existsSync(join(fixture, `${task}.marker`)));
    rmSync(join(fixture, 'fixtureTest.marker'));
    assert.match(run(['fixtureTest'], false), /size/);
    assert(!existsSync(join(fixture, 'fixtureTest.marker')), 'Corrupt bootstrap must block Test');
    assert.match(run(['fixtureTest'], false), /size/);
    assert(!existsSync(join(fixture, 'fixtureTest.marker')));
    console.log('PASS: corruption, repository scope, complete inventory, graph and local SDK binding');
  }
} finally {
  assert(dirname(root) === resolve(tmpdir()) && basename(root).startsWith('caption-robolectric-fixture-') && !lstatSync(root).isSymbolicLink(), 'Temporary cleanup boundary mismatch');
  rmSync(root, { recursive: true, force: true });
}
