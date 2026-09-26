import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import * as lifecycle from '../src/lib/media-lifecycle.ts';
import * as ledger from '../src/lib/media-permission-release-ledger.ts';

const require = createRequire(import.meta.url);
const { transformSync } = require(process.env.CAPTION_TEST_ESBUILD_PATH ?? 'esbuild');

const compiled = Object.fromEntries(['preferences', 'media-permissions'].map((name) => [name,
  transformSync(readFileSync(new URL(`../src/services/${name}.ts`, import.meta.url), 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'es2022',
  }).code,
]));
const key = 'android-media-permission-release-ledger';
const oldUri = 'content://provider/old';
const newUri = 'content://provider/new';

function harness(initialRow) {
  const rows = new Map(initialRow === undefined ? [] : [[key, initialRow]]);
  const released = [];
  const warnings = [];
  let inspections = 0;
  const database = {
    async getFirstAsync(_sql, queriedKey) {
      return rows.has(queriedKey) ? { value_json: rows.get(queriedKey) } : null;
    },
    async runAsync(_sql, writtenKey, value) { rows.set(writtenKey, value); },
  };
  const modules = {
    '@/services/database': {
      async getDatabase() { return database; },
      async inspectProjectPermissionReferences() {
        inspections += 1;
        return { complete: true, projects: [], protectedUris: [] };
      },
    },
    '@/lib/media-lifecycle': lifecycle,
    '@/lib/media-permission-release-ledger': ledger,
    'caption-media': { async releaseReadPermission(uri) { released.push(uri); return true; } },
  };
  function load(name) {
    const module = { exports: {} };
    runInNewContext(compiled[name], {
      module, exports: module.exports,
      console: { warn: (...args) => warnings.push(args) },
      require(id) {
        assert.ok(Object.hasOwn(modules, id), `Unexpected import: ${id}`);
        return modules[id];
      },
    });
    return module.exports;
  }
  modules['@/services/preferences'] = load('preferences');
  return { service: load('media-permissions'), rows, released, warnings,
    inspections: () => inspections };
}

for (const [label, row] of [
  ['malformed JSON', '{"version":1,"uris":'],
  ['invalid schema', JSON.stringify({ version: 2, uris: [oldUri] })],
  ['invalid URI entry', JSON.stringify({ version: 1, uris: [oldUri, 42] })],
]) {
  test(`${label} blocks release and preserves pending candidates until repair`, async () => {
    const state = harness(row);
    await state.service.releaseUnreferencedReadPermissions([newUri]);
    assert.equal(state.rows.get(key), row);
    assert.deepEqual(state.released, []);
    assert.equal(state.inspections(), 0);
    assert.ok(state.warnings.some(([message]) => message.includes('cleanup ledger')));

    await state.service.releaseUnreferencedReadPermissions([oldUri]);
    assert.equal(state.rows.get(key), row);
    assert.deepEqual(state.released, []);

    state.rows.set(key, JSON.stringify({ version: 1, uris: [] }));
    await state.service.retryPendingReadPermissionReleases();
    assert.deepEqual(state.released, [newUri, oldUri]);
    assert.deepEqual(JSON.parse(state.rows.get(key)), { version: 1, uris: [] });
  });
}

test('missing preference starts an empty ledger and releases a new candidate', async () => {
  const state = harness();
  await state.service.releaseUnreferencedReadPermissions([newUri]);
  assert.deepEqual(state.released, [newUri]);
  assert.deepEqual(JSON.parse(state.rows.get(key)), { version: 1, uris: [] });
});
