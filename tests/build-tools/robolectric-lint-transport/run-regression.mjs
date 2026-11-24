// Cloud-only: real Gradle resolves simulated Expo lint model classpaths over HTTP.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
assert.ok(process.argv[2], 'Pass an existing cloud Gradle installation directory');
const gradle = resolve(process.argv[2]);
const real = process.argv.includes('--real-artifact');
const work = await mkdtemp(join(tmpdir(), 'lint-transport-'));
const requests = [];
const server = createServer((req, res) => {
  requests.push(`${req.method} ${req.url}`);
  if (req.url.startsWith('/throttled/org/robolectric/nativeruntime-dist-compat/')) {
    res.writeHead(429); res.end('rate limited'); return;
  }
  const match = /\/(nativeruntime-dist-compat|unrelated)\/([^/]+)\/[^/]+\.(pom|jar)$/.exec(req.url);
  if (!match) { res.writeHead(404); res.end(); return; }
  const [, name, version, ext] = match;
  const body = ext === 'jar' ? Buffer.from(`tiny ${name}`) : Buffer.from(`<project><modelVersion>4.0.0</modelVersion><groupId>org.robolectric</groupId><artifactId>${name}</artifactId><version>${version}</version></project>`);
  res.writeHead(200, { 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
async function run(args, success) {
  const result = await new Promise((done, reject) => {
    const child = spawn('java', ['-Xmx128m', '-XX:ActiveProcessorCount=2',
      '-Dorg.gradle.internal.instrumentation.agent=false', '-cp', join(gradle, 'lib/*'),
      'org.gradle.launcher.GradleMain', '--no-daemon', '--max-workers=1', '--console=plain',
      '-Dorg.gradle.jvmargs=-Xmx128m', '--project-dir', work,
      '--gradle-user-home', join(work, 'gradle-home'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', b => { output += b; });
    child.stderr.on('data', b => { output += b; });
    child.on('error', reject);
    const timer = setTimeout(() => child.kill(), 540000);
    child.on('close', code => { clearTimeout(timer); done({ code, output }); });
  });
  console.log(result.output);
  assert.equal(result.code === 0, success, 'Unexpected Gradle result');
  return result.output;
}
try {
  await writeFile(join(work, 'settings.gradle'), "rootProject.name='lint-transport-fixture'\ninclude ':expo', ':expo-modules-core', ':app', ':caption-media'\n");
  for (const name of ['expo', 'expo-modules-core', 'app', 'caption-media']) await mkdir(join(work, name));
  // Existing module policy must remain in place, without a second exclusive repository.
  await writeFile(join(work, 'caption-media/build.gradle'), `repositories.maven {
    name = 'captionRobolectricMirror'
    url = uri('https://maven-central.storage-download.googleapis.com/maven2/')
  }
  ext.originalMirror = repositories.findByName('captionRobolectricMirror')
  tasks.register('verifyExistingRepository') {
    doLast {
      assert repositories.findByName('captionRobolectricMirror').is(originalMirror)
      assert repositories.size() == 2
    }
  }`);
  const bootstrap = await readFile(join(root, 'modules/caption-media/android/robolectric-runtime.gradle'), 'utf8');
  const pin = /def nativeRuntime = \[name: '([^']+)',\s*coordinate: '([^']+)', size: (\d+)L,\s*sha512: '([^']+)'\]/.exec(bootstrap);
  assert.ok(pin, 'Existing native pin must remain parseable');
  await writeFile(join(work, 'build.gradle'), `
allprojects {
  repositories.maven { url = uri('${origin}/throttled/'); allowInsecureProtocol = true }
  configurations.create('releaseUnitTestRuntimeClasspath')
  dependencies.add('releaseUnitTestRuntimeClasspath', '${pin[2]}')
  tasks.register('generateReleaseUnitTestLintModel') {
    doLast {
      def jars = configurations.releaseUnitTestRuntimeClasspath.files
      assert jars.size() == 1 && jars.first().name == '${pin[1]}'
      ${real ? `assert jars.first().length() == ${pin[3]}L
      def hash = java.security.MessageDigest.getInstance('SHA-512')
      jars.first().withInputStream { input ->
        byte[] buffer = new byte[65536]
        int count
        while ((count = input.read(buffer)) != -1) hash.update(buffer, 0, count)
      }
      assert hash.digest().encodeHex().toString() == '${pin[4]}'` : "assert jars.first().text == 'tiny nativeruntime-dist-compat'"}
      assert tasks.findByName('prepareRobolectricRuntime') == null
      println 'VERIFIED_LINT_CLASSPATH ' + project.path + ' ' + jars.first()
    }
  }
  tasks.register('verifyUnrelated') {
    doLast {
      def other = configurations.detachedConfiguration(dependencies.create('org.robolectric:unrelated:1@jar'))
      assert other.singleFile.text == 'tiny unrelated'
    }
  }
}
`);
  // Run after the production init's afterProject hooks; production policy stays unmodified.
  const fixtureInit = join(work, 'fixture.init.gradle');
  await writeFile(fixtureInit, `gradle.projectsEvaluated {
  allprojects { p ->
    def mirror = p.repositories.findByName('captionRobolectricMirror')
    if (mirror != null) {
      ${real ? '' : `mirror.url = uri('${origin}/healthy/'); mirror.allowInsecureProtocol = true`}
    }
  }
}`);
  // Demonstrate the exact failing HTTP method independently of Gradle retry policy.
  assert.equal((await fetch(`${origin}/throttled/org/robolectric/nativeruntime-dist-compat/1.0.18/nativeruntime-dist-compat-1.0.18.jar`, { method: 'HEAD' })).status, 429);
  const broken = await run([':expo:generateReleaseUnitTestLintModel'], false);
  assert.match(broken, /429/);
  requests.length = 0;
  const output = await run(['--init-script', join(root, 'scripts/robolectric-lint-transport.init.gradle'),
    '--init-script', fixtureInit, ':expo:generateReleaseUnitTestLintModel',
    ':expo-modules-core:generateReleaseUnitTestLintModel', ':app:generateReleaseUnitTestLintModel',
    ':app:verifyUnrelated', ':caption-media:verifyExistingRepository'], true);
  for (const name of ['expo', 'expo-modules-core', 'app']) assert.ok(output.includes(`VERIFIED_LINT_CLASSPATH :${name} `));
  assert.ok(!requests.some(r => r.includes('/throttled/org/robolectric/nativeruntime-dist-compat/')), 'Exclusive transport leaked to throttled repository');
  assert.ok(requests.some(r => r.includes('/throttled/org/robolectric/unrelated/')), 'Unrelated dependency routing changed');
  console.log(`PASS: HTTP429 baseline rejected; all three lint classpaths resolved via shared transport (${real ? 'real pinned bytes' : 'HTTP fixture'}); unrelated routing retained`);
} finally {
  await new Promise(done => server.close(done));
  assert.ok(work.startsWith(join(tmpdir(), 'lint-transport-')));
  await rm(work, { recursive: true, force: true });
}
