import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createKeyedOperationQueue } from '../src/lib/keyed-operation-queue.ts';
import * as mediaLifecycle from '../src/lib/media-lifecycle.ts';
import * as projectFactory from '../src/lib/project-factory.ts';
import * as generationSession from '../src/services/caption-generation-session.ts';

const compiled = Object.fromEntries(['editor-draft-journal', 'project-workflows'].map((name) => [name,
  ts.transpileModule(readFileSync(new URL(`../src/services/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText,
]));
const directory = 'file:///test-documents/editor-drafts/';
const kinds = ['caption-script', 'dual-captions-es', 'dual-captions-removed-track'];
const plain = (value) => JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(status = 'saved') {
  const project = projectFactory.createCaptionProject({
    id: 'project-1', name: 'Test project',
    sources: [{ id: 'source-1', uri: 'content://video/1', storageMode: 'linked',
      displayName: 'Video.mp4', durationMs: 4000, width: 1080, height: 1920, rotation: 0 }],
  });
  return { ...project, lifecycle: { status } };
}

// Real lifecycle and journal services, with in-memory database/native storage.
// No device documents or existing project records are accessed by these tests.
function harness(options = {}) {
  const files = new Map();
  const directories = new Set();
  const events = [];
  const warnings = [];
  let stored = options.project ?? fixture();
  const fail = (operation) => {
    if (options.fail === operation) throw new Error(`${operation} failed`);
  };
  const fs = {
    documentDirectory: options.unavailable ? null : 'file:///test-documents/',
    async getInfoAsync(uri) {
      return { exists: files.has(uri) || directories.has(uri), isDirectory: directories.has(uri),
        size: files.get(uri)?.length ?? 0 };
    },
    async makeDirectoryAsync(uri) { directories.add(uri); },
    async readDirectoryAsync(uri) {
      events.push(['list', uri]);
      fail('list');
      return [...files.keys(), ...directories].filter((key) => key.startsWith(uri) && key !== uri)
        .map((key) => key.slice(uri.length));
    },
    async readAsStringAsync(uri) {
      fail('read');
      if (!files.has(uri)) throw new Error('Missing file');
      return files.get(uri);
    },
    async writeAsStringAsync(uri, value) {
      events.push(['write', uri]);
      await options.beforeWrite?.(uri);
      files.set(uri, value);
    },
    async moveAsync({ from, to }) {
      fail('move');
      files.set(to, files.get(from));
      files.delete(from);
      events.push(['move', to]);
    },
    async deleteAsync(uri, config) {
      assert.equal(config.idempotent, true);
      events.push(['deleteJournal', uri]);
      if (options.failDelete === uri) throw new Error('Journal deletion failed');
      files.delete(uri);
    },
  };
  const modules = {
    '@/lib/keyed-operation-queue': { createKeyedOperationQueue },
    'expo-file-system/legacy': fs,
    '@/lib/project-factory': projectFactory,
    '@/lib/media-lifecycle': mediaLifecycle,
    '@/lib/audio-timeline': {},
    '@/lib/audio-waveform': {},
    '@/lib/video-timeline': {},
    '@/lib/project-timeline': {},
    '@/lib/project-presentation': { humanVideoName: (name) => name },
    '@/services/database': {
      async getProject() { return stored; },
      async saveProject(project) { fail('save'); stored = project; events.push(['save', project.id]); },
      async deleteProjectRecord(id) {
        fail('deleteRecord');
        const previous = stored; stored = null; events.push(['deleteRecord', id]); return previous;
      },
      async deleteUnreadableProjectRecord(id) {
        fail('deleteUnreadableRecord'); stored = null; events.push(['deleteUnreadableRecord', id]);
        return ['content://video/1'];
      },
      async listProjectRecords() { return stored ? [{ kind: 'project', project: stored }] : []; },
      async listProjectRecordIds() { return stored ? [stored.id] : []; },
    },
    '@/services/project-media': {
      async deleteProjectFiles(id) { events.push(['deleteMedia', id]); fail('media'); },
      async deleteProjectOwnedFiles(id) { events.push(['deleteOwnedMedia', id]); fail('media'); },
      async reconcileProjectOwnedFiles() {},
      async reconcileOrphanedProjectDirectories() {},
      async ensureProjectThumbnail() { return 'file:///thumbnail.jpg'; },
    },
    '@/services/project-persistence': {
      async persistProjectCheckpoint(project) { await modules['@/services/database'].saveProject(project); return project; },
    },
    '@/services/project-recovery': { async cleanupStaleProjectRecoveryCache() {} },
    '@/services/media-permissions': {
      linkedMediaUris: mediaLifecycle.collectLinkedMediaUris,
      async releaseUnreferencedReadPermissions(uris) { events.push(['release', ...uris]); },
      async retryPendingReadPermissionReleases() {},
    },
    '@/services/media-import': { async pickLinkedVideos() { return null; } },
    '@/services/project-transcription': {
      async generateProjectCaptions(project, model, progress, save, session) {
        await options.generate?.(session); return project;
      },
    },
    '@/services/caption-generation-session': generationSession,
    'caption-media': { async cancelAudioExtraction() { events.push(['cancelExtraction']); } },
  };
  function load(name) {
    const module = { exports: {} };
    runInNewContext(compiled[name], {
      module, exports: module.exports, console: { warn: (message) => warnings.push(message) },
      require(id) {
        assert.ok(Object.hasOwn(modules, id), `Unexpected import: ${id}`);
        return modules[id];
      },
    });
    return module.exports;
  }
  const journal = load('editor-draft-journal');
  modules['@/services/editor-draft-journal'] = journal;
  const workflows = load('project-workflows');
  async function seed(projectId = 'project-1') {
    for (const kind of kinds) await journal.writeEditorDraftJournal(projectId, kind, 'base', { text: kind });
  }
  return { files, directories, events, warnings, journal, workflows, seed, get stored() { return stored; } };
}

const destructiveCases = [
  ['saved discard', 'save', (h) => h.workflows.discardEditorSession(fixture(), { ...fixture(), name: 'Unsaved edit' })],
  ['draft discard', 'deleteRecord', (h) => h.workflows.discardEditorSession(fixture('draft'), fixture('draft'), {
    owned: { uris: [] }, linked: { uris: ['content://video/new'] },
  })],
  ['delete project', 'deleteRecord', (h) => h.workflows.deleteProjectCompletely('project-1')],
  ['delete unreadable project', 'deleteUnreadableRecord', (h) => h.workflows.deleteUnreadableProjectCompletely('project-1')],
];

for (const [name, transaction, action] of destructiveCases) {
  test(`${name} removes every recovery kind only after the database transaction succeeds`, async () => {
    const h = harness(); await h.seed(); await h.seed('project-10');
    const otherFiles = [...h.files].filter(([uri]) => uri.includes('project-10-'));
    await action(h);
    assert.deepEqual([...h.files], otherFiles);
    const transactionIndex = h.events.findIndex(([event]) => event === transaction);
    assert.ok(transactionIndex >= 0);
    assert.ok(h.events.findIndex(([event]) => event === 'deleteJournal') > transactionIndex);
    assert.equal(h.stored?.name ?? null, name === 'saved discard' ? 'Test project' : null);
    if (name === 'draft discard') assert.ok(h.events.some(([event, uri]) => event === 'release' && uri === 'content://video/new'));
    for (const kind of kinds) assert.equal(await h.journal.readEditorDraftJournal('project-1', kind), null);
  });

  test(`${name} preserves journals when the database transaction fails`, async () => {
    const h = harness({ fail: transaction }); await h.seed(); const before = [...h.files];
    await assert.rejects(action(h), /failed/);
    assert.deepEqual([...h.files], before);
    assert.ok(!h.events.some(([event]) => event === 'deleteJournal' || event === 'deleteMedia' || event === 'deleteOwnedMedia'));
  });

  test(`${name} still cleans other journals and media if one journal cannot be deleted`, async () => {
    const retainedUri = `${directory}project-1-caption-script.json`;
    const h = harness({ failDelete: retainedUri }); await h.seed();
    await action(h);
    assert.deepEqual([...h.files.keys()], [retainedUri]);
    assert.equal(h.warnings.length, 1);
    assert.ok(h.events.some(([event]) => event === 'deleteMedia' || event === 'deleteOwnedMedia'));
    assert.ok(h.events.some(([event]) => event === 'release'));
  });
}

for (const [name, action] of [
  ['save', (h) => h.workflows.saveEditorDraft(fixture())],
  ['checkpoint', (h) => h.workflows.checkpointEditorProject(fixture())],
  ['reopen', (h) => h.workflows.loadProjectForEditing('project-1')],
  ['library load', (h) => h.workflows.loadProjectLibrary()],
  ['thumbnail refresh', (h) => h.workflows.ensureLibraryProjectThumbnail(fixture())],
  ['cancel without generation', (h) => h.workflows.cancelProjectCaptionGeneration()],
  ['cancel import', (h) => h.workflows.importVideoProject()],
]) {
  test(`ordinary ${name} preserves recovery journals byte for byte`, async () => {
    const h = harness(); await h.seed(); const before = [...h.files];
    await action(h);
    assert.deepEqual([...h.files], before);
    assert.ok(!h.events.some(([event]) => event === 'deleteJournal'));
    for (const kind of kinds) assert.deepEqual(plain((await h.journal.readEditorDraftJournal('project-1', kind)).payload), { text: kind });
  });
}

test('cancelling active caption generation preserves recovery journals', async () => {
  const started = deferred(); const finish = deferred();
  const h = harness({ generate: async () => { started.resolve(); await finish.promise; } });
  await h.seed(); const before = [...h.files];
  const generating = h.workflows.generateAndSaveProjectCaptions(fixture(), 'balanced');
  const rejected = assert.rejects(generating, /Caption generation cancelled/);
  await started.promise;
  assert.equal(await h.workflows.cancelProjectCaptionGeneration(), true);
  finish.resolve(); await rejected;
  assert.deepEqual([...h.files], before);
});

test('project cleanup waits for pending writes across journal kinds and preserves other project concurrency', async () => {
  const started = deferred(); const finish = deferred();
  const h = harness({ beforeWrite: async (uri) => {
    if (uri.endsWith('project-1-caption-script.json.writing')) { started.resolve(); await finish.promise; }
  } });
  const scriptWrite = h.journal.writeEditorDraftJournal('project-1', 'caption-script', 'base', 'script');
  await started.promise;
  const dualWrite = h.journal.writeEditorDraftJournal('project-1', 'dual-captions-fr', 'base', 'dual');
  const cleanup = h.workflows.deleteProjectCompletely('project-1');
  await h.journal.writeEditorDraftJournal('project-2', 'caption-script', 'base', 'keep');
  assert.ok(!h.events.some(([event]) => event === 'list'));
  finish.resolve(); await Promise.all([scriptWrite, dualWrite, cleanup]);
  assert.deepEqual([...h.files.keys()], [`${directory}project-2-caption-script.json`]);
});

test('cleanup removes failed-write staging files, malformed journals, and does not poison later sessions', async () => {
  const options = { fail: 'move' }; const h = harness(options);
  const writing = h.journal.writeEditorDraftJournal('project-1', 'dual-captions-fr', 'base', 'draft');
  const rejected = assert.rejects(writing, /move failed/);
  const cleanup = h.journal.clearProjectEditorDraftJournals('project-1');
  await Promise.all([rejected, cleanup]);
  assert.equal(h.files.size, 0);
  h.files.set(`${directory}project-1-caption-script.json`, '{broken');
  h.files.set(`${directory}project-1-caption-script.json.writing`, '{partial');
  await h.journal.clearProjectEditorDraftJournals('project-1');
  assert.equal(h.files.size, 0);
  options.fail = undefined; await h.seed();
  assert.equal((await h.journal.readEditorDraftJournal('project-1', 'caption-script')).baseRevision, 'base');
});

test('cleanup scopes known kinds and preserves overlapping project names and unrelated files/directories', async () => {
  const h = harness(); await h.seed();
  await h.seed('project-1-extra'); await h.seed('project-1-dual-captions-other');
  h.files.set(`${directory}project-1-notes.json`, 'keep');
  h.files.set(`${directory}project-1-caption-script.json.backup`, 'keep');
  h.directories.add(`${directory}project-1-dual-captions-folder.json`);
  const before = [...h.files].filter(([uri]) => !kinds.some((kind) => uri === `${directory}project-1-${kind}.json`));
  await h.journal.clearProjectEditorDraftJournals('project-1');
  assert.deepEqual([...h.files], before);
  assert.ok(!h.events.some(([event, uri]) => event === 'deleteJournal' && h.directories.has(uri)));
});

test('sanitized project IDs use the existing filenames without deleting another journal owner', async () => {
  const h = harness(); await h.seed('project/a');
  await h.journal.clearProjectEditorDraftJournals('project/a');
  assert.equal(h.files.size, 0);
  await h.seed('project/a'); const before = [...h.files];
  await h.journal.clearProjectEditorDraftJournals('project?a');
  assert.deepEqual([...h.files], before);
});

test('per-kind clearing remains scoped to the requested editor journal', async () => {
  const h = harness(); await h.seed();
  await h.journal.clearEditorDraftJournal('project-1', 'caption-script');
  assert.equal(await h.journal.readEditorDraftJournal('project-1', 'caption-script'), null);
  assert.equal(h.files.size, 2);
});

test('cleanup is idempotent for missing directories, missing records, and already deleted journals', async () => {
  const h = harness();
  await h.journal.clearProjectEditorDraftJournals('project-1');
  assert.equal(h.events.length, 0);
  await h.workflows.deleteProjectCompletely('project-1');
  await h.seed(); await h.workflows.deleteProjectCompletely('project-1');
  await h.workflows.deleteProjectCompletely('project-1');
  assert.equal(h.files.size, 0); assert.equal(h.warnings.length, 0);
});

test('unavailable storage makes cleanup a no-op while writes still report recovery failure', async () => {
  const h = harness({ unavailable: true });
  await h.journal.clearProjectEditorDraftJournals('project-1');
  await h.workflows.deleteProjectCompletely('project-1');
  assert.equal(h.warnings.length, 0);
  await assert.rejects(h.journal.writeEditorDraftJournal('project-1', 'caption-script', 'base', 'draft'), /storage is unavailable/);
});

for (const failure of ['list', 'read', 'media']) {
  test(`${failure} cleanup failure does not block the completed lifecycle transaction`, async () => {
    const h = harness({ fail: failure }); await h.seed();
    await h.workflows.deleteProjectCompletely('project-1');
    assert.equal(h.stored, null); assert.equal(h.warnings.length, 1);
    assert.equal(h.files.size, failure === 'media' ? 0 : kinds.length);
    assert.ok(h.events.some(([event]) => event === 'release'));
  });
}
