import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Test the real installed Gradle Copy task using tiny disposable archives. No
// fixture output is supplied to a compiler or to the later real SDK build.
assert.equal(process.platform, 'linux');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.ok(process.env.RUNNER_TEMP);
const root = fileURLToPath(new URL('../..', import.meta.url));
const temporary = mkdtempSync(path.join(process.env.RUNNER_TEMP, 'cs-hermes-copy-'));
const downloads = path.join(temporary, 'downloads');
const output = path.join(temporary, 'output');
mkdirSync(downloads);
try {
  const python = `import tarfile,io,sys
with tarfile.open(sys.argv[1], 'w:gz') as archive:
 for folder,name,body in [('facebook-hermes-fixture','legacy.txt',b'legacy'),('meta-hermes-fixture','current.txt',b'current'),('unknown-fixture','retained.txt',b'unknown')]:
  item=tarfile.TarInfo(folder+'/'+name);item.size=len(body);archive.addfile(item,io.BytesIO(body))
`;
  const create = spawnSync('python3', ['-c', python, path.join(downloads, 'hermes.tar.gz')], { stdio: 'inherit', timeout: 10000 });
  assert.equal(create.status, 0);
  const task = ':react-native:packages:react-native:ReactAndroid:hermes-engine:';
  const run = spawnSync('./gradlew', [task + 'unzipHermes', '-x', task + 'downloadHermes',
    '--init-script', path.join(root, 'scripts/react-native-fontfit/test-hermes-archive.init.gradle'),
    '--no-daemon', '--console=plain'], {
      cwd: path.join(root, 'android'), stdio: 'inherit', timeout: 480000,
      env: { ...process.env, REACT_NATIVE_DOWNLOADS_DIR: downloads, CS_HERMES_FIXTURE_OUTPUT: output },
    });
  assert.equal(run.status, 0, 'Actual Gradle Copy fixture failed');
  assert.equal(readFileSync(path.join(output, 'legacy.txt'), 'utf8'), 'legacy');
  assert.equal(readFileSync(path.join(output, 'current.txt'), 'utf8'), 'current');
  assert.equal(readFileSync(path.join(output, 'unknown-fixture/retained.txt'), 'utf8'), 'unknown');
  assert.equal(existsSync(path.join(output, 'meta-hermes-fixture')), false);
  assert.equal(existsSync(path.join(output, 'facebook-hermes-fixture')), false);
  console.log('Actual Hermes Copy task: legacy/current prefixes flattened, unknown retained.');
} finally {
  assert.ok(path.dirname(temporary) === path.resolve(process.env.RUNNER_TEMP));
  rmSync(temporary, { recursive: true, force: true });
}
