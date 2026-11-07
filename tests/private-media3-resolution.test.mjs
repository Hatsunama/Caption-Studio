import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const script = readFileSync(new URL('../scripts/private-media3-version.gradle', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

// Narrow lexical scope reader, not a Groovy interpreter. Keep strings opaque so
// braces/comments cannot accidentally change the task's modeled owner.
function scopes(source) {
  const stack = [];
  const blocks = [];
  let start = 0;
  for (const token of source.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|[{}\n]/g)) {
    const [value] = token;
    if (value.startsWith('//') || value.startsWith('/*')) continue;
    if (value === '{') {
      const block = { header: source.slice(start, token.index).trim(), parents: [...stack] };
      stack.push(block);
      blocks.push(block);
      start = token.index + 1;
    } else if (value === '}') {
      const block = stack.pop();
      assert.ok(block, 'balanced closure');
      block.body = source.slice(block.start, token.index);
      start = token.index + 1;
    } else if (value === '\n') start = token.index + 1;
    if (value === '{') stack.at(-1).start = token.index + 1;
  }
  assert.equal(stack.length, 0, 'balanced closures');
  return blocks;
}

function ownershipModel(source) {
  const blocks = scopes(source);
  const task = blocks.find(({ header }) => /\.tasks\.register\('verifyPrivateMedia3Resolution'\)/.test(header));
  assert.ok(task, 'reporter task exists');
  const receiver = task.header.match(/(\w+)\.tasks\.register/)[1];
  const rootCallback = task.parents.find(({ header }) => header === `gradle.rootProject`);
  const appGuard = task.parents.find(({ header }) => header === `if (${receiver}.path == ':app')`);
  const beforeProject = task.parents.find(({ header }) => header === 'gradle.beforeProject');
  // Closure parameter names live in the parent's body, preceding its children.
  const owner = rootCallback && rootCallback.body.trimStart().startsWith(`${receiver} ->`)
    ? ':' : appGuard && beforeProject?.body.trimStart().startsWith(`${receiver} ->`) ? ':app' : undefined;
  assert.ok(owner, 'task must have an explicit project owner');
  const lookup = source.match(/(\w+)(\.project\(':app'\))?\.configurations\.(?:getByName|named)\('releaseRuntimeClasspath'\)/);
  assert.ok(lookup, 'runtime configuration lookup exists');
  const configOwner = lookup[2] ? ':app' : lookup[1] === receiver ? owner : undefined;
  assert.ok(configOwner, 'configuration owner must be known');
  let resolutions = 0;
  return {
    owner,
    get resolutions() { return resolutions; },
    execute(lockOwner = owner) {
      // Model DefaultConfiguration.resolveGraphIfRequired's exclusive-owner check.
      if (lockOwner !== configOwner) throw new Error('resolution attempted without an exclusive lock');
      resolutions++;
    },
  };
}

test('private graph reporter executes under the runtime configuration owner lock', () => {
  const model = ownershipModel(script);
  assert.equal(model.resolutions, 0);
  model.execute(); // Old root-owned task fails here before task-path assertions.
  assert.equal(model.resolutions, 1);
  assert.equal(model.owner, ':app');
  assert.throws(() => model.execute(':'), /exclusive lock/);
});

test('ownership model rejects the original cross-project task', () => {
  const old = ownershipModel(`gradle.rootProject { root ->
    root.tasks.register('verifyPrivateMedia3Resolution') {
      doLast {
        def config = root.project(':app').configurations.getByName('releaseRuntimeClasspath')
      }
    }
  }`);
  assert.throws(() => old.execute(), /exclusive lock/);
});

test('reporter wires a lazy graph provider and retains private report/version contracts', () => {
  const blocks = scopes(script);
  const mapping = blocks.find(({ header }) => /configurations\.named\('releaseRuntimeClasspath'\)\.map$/.test(header));
  assert.ok(mapping, 'configuration provider maps to the component graph lazily');
  assert.match(mapping.body, /config\.incoming\.resolutionResult\.allComponents/);
  const action = blocks.find(({ header }) => header === 'doLast');
  assert.match(action.body, /def components = media3Components\.get\(\)/);
  assert.doesNotMatch(mapping.body, /\.files\b|\.resolve\(|resolvedConfiguration|artifactView/);
  assert.match(script, /components\.isEmpty\(\) \|\| components\.any \{ !it\.endsWith\(':' \+ comparisonVersion\) \}/);
  assert.match(script, /\.unique\(\)\.sort\(\)/);
  assert.match(script, /rootProject\.layout\.buildDirectory\.file\('reports\/private-media3-resolution\.txt'\)/);
  assert.match(script, /GITHUB_REF.*refs\/heads\/diagnostic\/media3-clipping-111-20261107/);
  assert.match(script, /comparisonVersion in \['1\.10\.1', '1\.11\.0'\]/);
  assert.match(workflow, /CAPTION_PRIVATE_MEDIA3_VERSION: '1\.11\.0'/);
  assert.match(workflow, /\.\/gradlew :app:verifyPrivateMedia3Resolution --no-daemon --stacktrace/);
  assert.match(workflow, /android\/build\/reports\/private-media3-resolution\.txt/);
});
