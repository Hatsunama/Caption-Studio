import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import test from 'node:test';

// GHSA-mrhx-c7xc-m3w5, updated 2026-10-23: patched in 4.6.6.
// https://github.com/advisories/GHSA-mrhx-c7xc-m3w5
// https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd
// Three elements suffice to detect traversal before a bound; never allocate a
// large attack payload or use elapsed time / memory pressure as an assertion.
const repoRequire = createRequire(import.meta.url);
let loadedZod;

function zod() {
  if (loadedZod) return loadedZod;
  const moduleRoot = process.env.CAPTION_STUDIO_ZOD_TEST_MODULE_ROOT ?? process.env.ZOD_RELEASE_SECURITY_MODULE_ROOT;
  let entry;
  let manifest;
  if (moduleRoot !== undefined) {
    // Explicit test-only escape hatch for authentic extracted npm tarballs.
    // It selects only the executable package, never the lock graph under test.
    assert.ok(isAbsolute(moduleRoot), 'CAPTION_STUDIO_ZOD_TEST_MODULE_ROOT must be an absolute Zod package directory');
    const root = resolve(moduleRoot);
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    entry = repoRequire.resolve(root);
    const localEntry = relative(root, entry);
    assert.ok(localEntry && !isAbsolute(localEntry) && localEntry !== '..' && !localEntry.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')),
      'isolated entry must belong to the selected package');
  } else {
    // Follow Expo's actual CLI dependency, then resolve from that CLI entry.
    // Never fall back to the root Zod when CLI dependencies are unavailable.
    const expoRequire = createRequire(repoRequire.resolve('expo/package.json'));
    const cliRequire = createRequire(expoRequire.resolve('@expo/cli'));
    entry = cliRequire.resolve('zod');
    manifest = JSON.parse(readFileSync(cliRequire.resolve('zod/package.json'), 'utf8'));
  }
  assert.equal(manifest.name, 'zod', 'execute a real Zod package');
  const module = repoRequire(entry);
  loadedZod = module.z ?? module;
  return loadedZod;
}

function expectIssue(result, code, path) {
  assert.equal(result.success, false);
  assert.equal(result.error.issues.length, 1, 'reject once, without accumulating per-element issues');
  assert.equal(result.error.issues[0].code, code);
  assert.deepEqual(result.error.issues[0].path, path);
}

const collections = [
  { name: 'array.max', schema: (z, element) => z.array(element).max(2), input: values => values },
  { name: 'array.length', schema: (z, element) => z.array(element).length(2), input: values => values },
  { name: 'set.max', schema: (z, element) => z.set(element).max(2), input: values => new Set(values) },
  { name: 'set.size', schema: (z, element) => z.set(element).size(2), input: values => new Set(values) },
  { name: 'map.max', schema: (z, element) => z.map(z.string(), element).max(2), input: values => new Map(values.map((value, index) => [String(index), value])) },
  { name: 'map.size', schema: (z, element) => z.map(z.string(), element).size(2), input: values => new Map(values.map((value, index) => [String(index), value])) },
];

for (const collection of collections) {
  for (const asyncParse of [false, true]) {
    test(`GHSA-mrhx-c7xc-m3w5: ${collection.name} rejects before callbacks (${asyncParse ? 'async' : 'sync'})`, async () => {
      const z = zod();
      let visits = 0;
      let transforms = 0;
      let collectionRefinements = 0;
      const element = z.string().refine(() => { visits++; return true; })
        .transform(value => { transforms++; return value.toUpperCase(); });
      const capped = collection.schema(z, element).refine(() => { collectionRefinements++; return true; });
      // Exercise both a standalone schema and the object parsing path used by CLI.
      for (const nested of [false, true]) {
        const schema = nested ? z.object({ values: capped }) : capped;
        const input = collection.input(['a', 'b', 'c']);
        const value = nested ? { values: input } : input;
        const result = asyncParse ? await schema.safeParseAsync(value) : schema.safeParse(value);
        expectIssue(result, 'too_big', nested ? ['values'] : []);
        assert.deepEqual({ visits, transforms, collectionRefinements },
          { visits: 0, transforms: 0, collectionRefinements: 0 });
      }
    });
  }

  test(`GHSA-mrhx-c7xc-m3w5: ${collection.name} does not visit invalid oversized elements`, () => {
    const z = zod();
    let visits = 0;
    const element = z.preprocess(value => { visits++; return value; }, z.string());
    const result = collection.schema(z, element).safeParse(collection.input([1, 2, 3]));
    expectIssue(result, 'too_big', []);
    assert.equal(visits, 0, 'the size gate must precede element parsing, even for invalid elements');
  });

  test(`${collection.name} still transforms valid elements and rejects small invalid inputs`, () => {
    const z = zod();
    let visits = 0;
    const element = z.string().refine(value => { visits++; return value.length > 0; })
      .transform(value => value.toUpperCase());
    const schema = collection.schema(z, element);
    assert.deepEqual(schema.parse(collection.input(['a', 'b'])), collection.input(['A', 'B']));
    assert.equal(visits, 2, 'valid elements must still be parsed');
    const badType = schema.safeParse(collection.input(['a', 2]));
    assert.equal(badType.success, false);
    assert.ok(badType.error.issues.some(issue => issue.code === 'invalid_type'));
    const badRefinement = schema.safeParse(collection.input(['a', '']));
    assert.equal(badRefinement.success, false);
    assert.ok(badRefinement.error.issues.some(issue => issue.code === 'custom'));
    if (collection.name.endsWith('.length') || collection.name.endsWith('.size')) {
      expectIssue(schema.safeParse(collection.input(['a'])), 'too_small', []);
    } else {
      assert.deepEqual(schema.parse(collection.input([])), collection.input([]));
    }
  });
}

test('CLI-style object, string, literal union and optional schemas preserve validation behavior', () => {
  const z = zod();
  const schema = z.object({
    name: z.string().min(1),
    platform: z.union([z.literal('android'), z.literal('ios')]),
    profile: z.string().optional(),
  });
  const input = { name: 'caption-studio', platform: 'android', extra: { retained: true } };
  assert.deepEqual(schema.parse(input), { name: 'caption-studio', platform: 'android' });
  assert.deepEqual(schema.passthrough().parse(input), input, 'explicit passthrough preserves unknown keys');
  assert.deepEqual(schema.parse({ name: 'app', platform: 'ios', profile: 'release' }),
    { name: 'app', platform: 'ios', profile: 'release' });
  assert.equal(schema.strict().safeParse(input).success, false);
  for (const [field, value] of [['name', ''], ['name', 1], ['platform', 'web'], ['profile', 1]]) {
    const result = schema.safeParse({ name: 'app', platform: 'android', [field]: value });
    assert.equal(result.success, false, field + ' must remain validated');
    assert.ok(result.error.issues.some(issue => issue.path[0] === field));
  }
});

test('installed Expo CLI plugin and MCP schemas retain their input and output contracts', () => {
  const expoRequire = createRequire(repoRequire.resolve('expo/package.json'));
  const cliRoot = dirname(expoRequire.resolve('@expo/cli/package.json'));
  const server = join(cliRoot, 'build/src/start/server');
  const { PluginSchema, DevToolsPluginOutputSchema } = repoRequire(join(server, 'DevToolsPlugin.schema.js'));
  const { createMCPDevToolsExtensionSchema } = repoRequire(join(server, 'createMCPDevToolsExtensionSchema.js'));
  const { DevToolsPluginCliExtensionResults } = repoRequire(join(server, 'DevToolsPluginCliExtensionResults.js'));
  const plugin = {
    packageName: 'synthetic-plugin', packageRoot: '/synthetic', extra: 'discard',
    cliExtensions: {
      description: 'Synthetic test', entryPoint: 'index.js',
      commands: [{ name: 'run', title: 'Run', environments: ['cli', 'mcp'], parameters: [
        { name: 'text', type: 'text' }, { name: 'count', type: 'number' }, { name: 'accept', type: 'confirm' },
      ] }],
    },
  };
  const parsed = PluginSchema.parse(plugin);
  assert.equal(parsed.extra, undefined);
  assert.ok(Object.isFrozen(parsed.cliExtensions.commands[0].environments));
  assert.equal(PluginSchema.safeParse({ ...plugin, packageName: '' }).success, false);
  assert.equal(PluginSchema.safeParse({ ...plugin, cliExtensions: { ...plugin.cliExtensions, commands: [] } }).success, false);
  const schema = createMCPDevToolsExtensionSchema(parsed);
  const input = { command: 'run', text: 'hello', count: 2, accept: true };
  assert.deepEqual(schema.parse(input), input);
  for (const invalid of [{ command: 'unknown' }, { command: 'run', count: '2' },
    { command: 'run', accept: 'true' }, { command: 'run', extra: true }]) {
    assert.equal(schema.safeParse(invalid).success, false);
  }
  assert.throws(() => createMCPDevToolsExtensionSchema({ packageName: 'empty' }), /no commands/);
  const output = [{ type: 'text', text: 'Hello', level: 'info' },
    { type: 'image', url: 'https://example.invalid/image.png' },
    { type: 'audio', url: 'https://example.invalid/audio.mp3', text: 'voice' }];
  assert.deepEqual(DevToolsPluginOutputSchema.parse(output), output);
  assert.equal(DevToolsPluginOutputSchema.safeParse([{ type: 'image', url: 'not a URL' }]).success, false);
  const collector = new DevToolsPluginCliExtensionResults();
  assert.deepEqual(collector.parseOutputText(JSON.stringify(output)), output);
  assert.deepEqual(collector.parseOutputText('plain output'), [{ type: 'text', text: 'plain output', level: 'info' }]);
});

test('release lock graph has no Zod below the patched 4.6.6 floor, including Expo CLI', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.lockfileVersion, 3);
  const entries = Object.entries(lock.packages);
  const zodEntries = entries.filter(([path, entry]) => /(^|\/)node_modules\/zod$/.test(path) || entry.name === 'zod');
  assert.ok(zodEntries.length > 0, 'Zod must exist in the resolved lock graph');
  const vulnerable = [];
  for (const [path, entry] of zodEntries) {
    const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(entry.version ?? '');
    const patched = version && (Number(version[1]) > 4 || (Number(version[1]) === 4 &&
      (Number(version[2]) > 6 || (Number(version[2]) === 6 && Number(version[3]) >= 6))));
    if (!patched) vulnerable.push(`${path}: ${entry.version ?? 'missing version'}`);
    assert.match(entry.integrity ?? '', /^sha512-[A-Za-z0-9+/]+={0,2}$/, path + ' needs package integrity');
  }
  assert.deepEqual(vulnerable, [], 'every resolved Zod node must be patched, not just an override or root node');

  const cliEntries = entries.filter(([path]) => /(^|\/)node_modules\/@expo\/cli$/.test(path));
  assert.ok(cliEntries.length > 0, 'Expo CLI must exist in the resolved lock graph');
  for (const [cliPath, cli] of cliEntries) {
    assert.equal(typeof cli.dependencies?.zod, 'string', cliPath + ' must declare its Zod dependency');
    let current = cliPath;
    let resolvedZod;
    while (current !== '.') {
      if (posix.basename(current) !== 'node_modules') {
        const candidate = current + '/node_modules/zod';
        if (lock.packages[candidate]) { resolvedZod = candidate; break; }
      }
      current = posix.dirname(current);
    }
    resolvedZod ??= lock.packages['node_modules/zod'] ? 'node_modules/zod' : undefined;
    assert.ok(resolvedZod, cliPath + ' must resolve a concrete Zod node');
    assert.ok(zodEntries.some(([path]) => path === resolvedZod), cliPath + ' must resolve a checked Zod node');
  }
});
