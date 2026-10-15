import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as boundaries from '../src/lib/persistence-boundaries.ts';
import * as schema from '../src/lib/project-schema.ts';
import * as mediaBoundary from '../src/lib/project-file-uri-boundary.ts';
import * as codec from '../src/lib/project-codec.ts';
import * as library from '../src/lib/project-library.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';

const compiled = ts.transpileModule(readFileSync(new URL('../src/services/database.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const poster = (id) => `file:///documents/${id}.jpg`;

function fixture(id = 'project') {
  const project = createCaptionProject({ id, name: 'Keep my title', sources: ['old', 'new', 'third'].map((id) => ({
    id, uri: `content://video/${id}`, storageMode: 'linked', displayName: `${id}.mp4`,
    thumbnailUri: poster(id), durationMs: 4000, width: 1080, height: 1920, rotation: 0,
  })) });
  return { ...project, clips: [project.clips[1]] };
}

function harness(t, options = {}) {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  const calls = [];
  let decoded = 0;
  let transactionTail = Promise.resolve();
  const adapter = (owner) => ({
    async execAsync(query) { sql.exec(query); },
    async runAsync(query, ...params) {
      calls.push({ owner, query, params });
      await options.beforeWrite?.(query, params);
      return sql.prepare(query).run(...params);
    },
    async getFirstAsync(query, ...params) {
      calls.push({ owner, query, params });
      return sql.prepare(query).get(...params) ?? null;
    },
    async getAllAsync(query, ...params) {
      calls.push({ owner, query, params });
      const rows = sql.prepare(query).all(...params);
      await options.afterRead?.(query, rows);
      return rows;
    },
  });
  const database = {
    ...adapter('database'),
    async closeAsync() {},
    async withExclusiveTransactionAsync(operation) {
      const result = transactionTail.then(async () => {
        sql.exec('BEGIN');
        try { await operation(adapter('transaction')); sql.exec('COMMIT'); }
        catch (error) { sql.exec('ROLLBACK'); throw error; }
      });
      transactionTail = result.catch(() => undefined);
      return result;
    },
  };
  const modules = {
    'expo-sqlite': { openDatabaseAsync: async () => database },
    'expo-file-system/legacy': { documentDirectory: 'file:///documents/', cacheDirectory: 'file:///cache/' },
    '@/lib/persistence-boundaries': boundaries,
    '@/lib/project-schema': schema,
    '@/lib/project-file-uri-boundary': mediaBoundary,
    '@/lib/project-codec': { decodePersistedProject(value) { decoded += 1; return codec.decodePersistedProject(value); } },
    '@/lib/project-library': library,
  };
  const module = { exports: {} };
  runInNewContext(compiled, { exports: module.exports, module, require(id) {
    assert.ok(Object.hasOwn(modules, id), `Unexpected import: ${id}`);
    return modules[id];
  } });
  return {
    api: module.exports, sql, calls, get decoded() { return decoded; },
    seed(project, version = 2, raw = schema.serializeProjectSnapshot(project)) {
      sql.prepare(`INSERT INTO projects (id, name, source_uri, updated_at, project_json,
        created_at, source_id, thumbnail_uri, duration_ms, lifecycle_status, clip_count, caption_count, metadata_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 4000, 'draft', 1, 0, ?)`).run(
        project.id, project.name, project.sources[0].uri, project.updatedAt, raw,
        project.createdAt, project.sources[0].id, project.sources[0].thumbnailUri, version,
      );
    },
    row(id = 'project') { return sql.prepare('SELECT * FROM projects WHERE id = ?').get(id); },
  };
}

test('library uses the first clip source in clip order without changing the retained catalog or visuals', () => {
  const project = fixture();
  const before = JSON.stringify(project);
  const summary = library.projectLibraryProject(project);
  assert.equal(summary.sourceId, 'new');
  assert.equal(summary.sourceUri, 'content://video/new');
  assert.equal(summary.thumbnailUri, poster('new'));
  assert.equal(summary.name, project.name);
  assert.equal(JSON.stringify(project), before);
  project.clips.push({ ...project.clips[0], id: 'third-clip', sourceId: 'third' });
  project.clips.reverse();
  assert.equal(library.projectLibraryProject(project).sourceId, 'third');
});

test('a project with retained sources and no clips has no representative source or thumbnail', () => {
  const summary = library.projectLibraryProject({ ...fixture(), clips: [] });
  assert.equal(summary.sourceId, undefined);
  assert.equal(summary.sourceUri, undefined);
  assert.equal(summary.thumbnailUri, undefined);
});

test('late thumbnails for retired, nonrepresentative, or changed-URI sources are rejected', () => {
  const project = fixture();
  for (const [id, uri] of [['old', 'content://video/old'], ['third', 'content://video/third'], ['new', 'content://video/stale']]) {
    assert.equal(library.applyProjectSourceThumbnail(project, id, uri, poster('late')), null);
  }
  const multiple = { ...project, clips: [...project.clips, { ...project.clips[0], id: 'third-clip', sourceId: 'third' }] };
  assert.equal(library.applyProjectSourceThumbnail(multiple, 'third', 'content://video/third', poster('late')), null);
  assert.equal(library.applyProjectSourceThumbnail({ ...project, clips: [] }, 'new', 'content://video/new', poster('late')), null);
});

test('representative thumbnail completion preserves other sources and project edits', () => {
  const project = fixture();
  const updated = library.applyProjectSourceThumbnail(project, 'new', 'content://video/new', poster('fresh'));
  assert.equal(updated.sources[1].thumbnailUri, poster('fresh'));
  assert.equal(updated.sources[0], project.sources[0]);
  assert.equal(updated.clips, project.clips);
  assert.equal(updated.layers, project.layers);
  assert.equal(updated.name, project.name);
});

test('version 2 and legacy metadata repair incrementally without rewriting project bodies or names', async (t) => {
  const h = harness(t);
  await h.api.getDatabase();
  for (let index = 0; index < 45; index += 1) h.seed(fixture(`p-${String(index).padStart(3, '0')}`), index === 0 ? 0 : 2);
  h.seed({ ...fixture('empty'), clips: [] });
  const before = h.row('p-000');
  const records = await h.api.listProjectRecords();
  assert.equal(records.length, 46);
  assert.ok(records.every((record) => record.kind === 'project'));
  assert.equal(records.find((record) => record.project.id === 'p-000').project.sourceId, 'new');
  assert.equal(records.find((record) => record.project.id === 'empty').project.thumbnailUri, undefined);
  const after = h.row('p-000');
  assert.equal(after.metadata_version, 3);
  for (const key of ['project_json', 'name', 'updated_at', 'created_at']) assert.equal(after[key], before[key]);
  const repairs = h.calls.filter(({ query }) => /^UPDATE projects SET name/.test(query));
  assert.equal(repairs.length, 46);
  assert.ok(repairs.every(({ owner }) => owner === 'transaction'));
  const scans = h.calls.filter(({ query }) => /SELECT.*FROM projects WHERE metadata_version/s.test(query));
  assert.ok(scans.length >= 3);
  assert.ok(scans.every(({ query }) => /LIMIT/.test(query) && !/project_json/.test(query)));
  const decoded = h.decoded;
  await h.api.listProjectRecords();
  assert.equal(h.decoded, decoded, 'current metadata must not hydrate full projects');
});

test('unreadable snapshots remain recoverable and valid neighbors repair', async (t) => {
  const h = harness(t);
  await h.api.getDatabase();
  h.seed(fixture('broken'), 2, '{broken');
  h.seed(fixture('valid'));
  const records = await h.api.listProjectRecords();
  assert.equal(records.find((record) => record.id === 'broken').kind, 'unreadable');
  assert.equal(h.row('broken').metadata_version, -1);
  assert.equal(await h.api.getRawProjectRecord('broken'), '{broken');
  assert.equal(h.row('valid').source_id, 'new');
});

test('repair write failures propagate without marking a valid snapshot corrupt and can retry', async (t) => {
  let fail = true;
  const h = harness(t, { beforeWrite(query) {
    if (fail && /^UPDATE projects SET name/.test(query)) throw new Error('disk full');
  } });
  await h.api.getDatabase();
  h.seed(fixture());
  await assert.rejects(h.api.listProjectRecords(), /disk full/);
  assert.equal(h.row().metadata_version, 2);
  fail = false;
  await h.api.listProjectRecords();
  assert.equal(h.row().metadata_version, 3);
});

test('save during first initialization finishes and writes version 3 active metadata', { timeout: 3000 }, async (t) => {
  const h = harness(t);
  await h.api.saveProject(fixture());
  assert.equal(h.row().metadata_version, 3);
  assert.equal(h.row().source_id, 'new');
  assert.equal(codec.decodePersistedProject(h.row().project_json).sources.length, 3);
});

test('queued replacement wins over a late thumbnail and preserves newer edits', async (t) => {
  const h = harness(t);
  const original = fixture();
  await h.api.saveProject({ ...original, clips: [{ ...original.clips[0], sourceId: 'old' }] });
  const saving = h.api.saveProject({ ...original, name: 'New title' });
  const late = h.api.updateProjectSourceThumbnail({ projectId: original.id, sourceId: 'old', sourceUri: 'content://video/old', thumbnailUri: poster('late') });
  await saving;
  assert.equal(await late, null);
  assert.equal(h.row().name, 'New title');
  assert.equal(h.row().thumbnail_uri, poster('new'));
  const fresh = await h.api.updateProjectSourceThumbnail({ projectId: original.id, sourceId: 'new', sourceUri: 'content://video/new', thumbnailUri: poster('fresh') });
  assert.equal(fresh.thumbnailUri, poster('fresh'));
  assert.equal(h.row().metadata_version, 3);
});

test('repair rereads a scanned row after a concurrent save and never resurrects a deleted project', { timeout: 3000 }, async (t) => {
  let h;
  let armed = false;
  let changed = false;
  h = harness(t, { async afterRead(query) {
    if (armed && !changed && /WHERE metadata_version/.test(query)) {
      changed = true;
      await h.api.saveProject({ ...fixture('save'), name: 'Concurrent title', clips: [] });
      await h.api.deleteProjectRecord('delete');
    }
  } });
  await h.api.getDatabase();
  h.seed(fixture('save'));
  h.seed(fixture('delete'));
  armed = true;
  await h.api.listProjectRecords();
  assert.equal(changed, true);
  assert.equal(h.row('save').name, 'Concurrent title');
  assert.equal(h.row('save').source_id, null);
  assert.equal(h.row('delete'), undefined);
});
