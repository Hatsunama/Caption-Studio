import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createCaptionProject, createVideoClip } from '../src/lib/project-factory.ts';
import { deleteVideoClip, setCanvasPreset, splitVideoClip, reorderVideoClip } from '../src/lib/project-editor.ts';
import { decodeVersionTwoProject, serializeProjectSnapshot } from '../src/lib/project-schema.ts';
import { decodePersistedProject } from '../src/lib/project-codec.ts';
import { buildTimelineRenderPlan } from '../src/lib/export-render-plan.ts';
import { recoverProjectVideoAccess } from '../src/services/project-media-recovery.ts';
import { collectProjectOwnedUris, collectLinkedMediaUris } from '../src/lib/media-lifecycle.ts';
import { createEditorSession } from '../src/services/editor-session.ts';

const source = (id, width, height, rotation = 0) => ({ id, uri: `content://video/${id}`,
  storageMode: 'linked', displayName: `${id}.mp4`, durationMs: 4000, width, height, rotation,
  thumbnailUri: `file:///private/${id}.jpg`, previewUri: `file:///private/${id}.mp4` });
const wide = source('retired', 1280, 720);
const tall = source('active', 1080, 1920);
const fixture = () => createCaptionProject({ id: 'replacement', name: 'Keep title', sources: [wide, tall] });
const size = (project) => [project.canvas.aspectWidth, project.canvas.aspectHeight];

test('last original clip removal atomically changes only source-derived framing and keeps retained assets', () => {
  const original = fixture();
  const next = deleteVideoClip(original, original.clips[0].id).project;
  assert.deepEqual(size(next), [1080, 1920]);
  assert.deepEqual(size(original), [1280, 720]);
  assert.equal(next.sources, original.sources);
  assert.equal(next.clips[0].transform, original.clips[1].transform);
  assert.deepEqual(collectProjectOwnedUris(next), collectProjectOwnedUris(original));
  assert.deepEqual(collectLinkedMediaUris(next), collectLinkedMediaUris(original));
  const restored = decodePersistedProject(serializeProjectSnapshot(next));
  assert.deepEqual(size(restored), [1080, 1920]);
  const plan = buildTimelineRenderPlan(restored);
  assert.deepEqual([plan.width, plan.height], [1080, 1920]);
});

test('Original reset uses active footage, not a retained retired source', () => {
  const project = fixture();
  project.clips.shift();
  assert.deepEqual(size(setCanvasPreset(project, 'source')), [1080, 1920]);
});

test('a split original still anchors the frame and reordering mixed clips does not change it', () => {
  const project = fixture();
  const split = splitVideoClip(project, project.clips[0].id, 2000, 'left', 'right').project;
  const afterOne = deleteVideoClip(split, 'left').project;
  assert.deepEqual(size(afterOne), [1280, 720]);
  assert.deepEqual(size(reorderVideoClip(afterOne, 'right', 1).project), [1280, 720]);
  assert.deepEqual(size(deleteVideoClip(afterOne, 'right').project), [1080, 1920]);
});

test('fixed frame presets and authored transforms survive replacement and reopen', () => {
  for (const preset of ['9:16', '16:9', '1:1', '4:5']) {
    const project = setCanvasPreset(fixture(), preset);
    project.clips[1].transform = { ...project.clips[1].transform, scale: 1.25, rotation: 12 };
    const next = deleteVideoClip(project, project.clips[0].id).project;
    assert.deepEqual(next.canvas, project.canvas);
    assert.deepEqual(decodePersistedProject(serializeProjectSnapshot(next)).canvas, project.canvas);
    assert.equal(next.clips[0].transform, project.clips[1].transform);
  }
});

test('editor commit owns clip and frame together, rejects failed writes, and restores both on undo', async () => {
  const original = fixture();
  let durable = original;
  let fail = true;
  const history = [];
  const session = createEditorSession(original, () => {}, async (next) => {
    if (fail) throw new Error('disk full');
    durable = decodePersistedProject(serializeProjectSnapshot(next));
    return next;
  }, (before) => history.push(before));
  const remove = (project) => deleteVideoClip(project, project.clips[0].id).project;
  await assert.rejects(session.commit(remove), /disk full/);
  assert.equal(session.current(), original);
  assert.equal(durable, original);
  assert.equal(history.length, 0);
  fail = false;
  await session.commit(remove);
  assert.deepEqual(size(session.current()), [1080, 1920]);
  assert.deepEqual(size(durable), [1080, 1920]);
  await session.commit(() => history.pop(), false, false);
  assert.deepEqual(size(session.current()), [1280, 720]);
  assert.equal(durable.clips.length, 2);
});

test('reopening old replacement drafts repairs source framing even after catalog pruning', () => {
  for (const prune of [false, true]) {
    const project = fixture();
    project.clips.shift();
    if (prune) project.sources.shift();
    assert.deepEqual(size(decodePersistedProject(JSON.stringify(project))), [1080, 1920]);
  }
});

test('missing canvas recovery and version-one migration respect all quarter-turn rotations', () => {
  for (const rotation of [0, 90, 180, 270, -90]) {
    const project = createCaptionProject({ id: 'rotation', name: 'Rotated', sources: [source('rotated', 1920, 1080, rotation)] });
    const expected = size(project);
    delete project.canvas;
    assert.deepEqual(size(decodeVersionTwoProject(project)), expected);
    assert.deepEqual(size(decodePersistedProject(JSON.stringify(project))), expected);
    const legacy = { ...project, schemaVersion: 1, source: project.sources[0] };
    assert.deepEqual(size(decodePersistedProject(JSON.stringify(legacy))), expected);
  }
});

test('retired sources do not block current playback access, but an enabled background remains required', async () => {
  const project = fixture();
  project.clips.shift();
  const checked = [];
  const ports = { check: async (uri) => { checked.push(uri); return { status: uri === wide.uri ? 'unavailable' : 'ready' }; },
    choose: async () => null, probe: async () => assert.fail('no relink'), confirm: async () => false,
    persist: async () => assert.fail('no write needed') };
  assert.equal(await recoverProjectVideoAccess(project, ports), project);
  assert.deepEqual(checked, [tall.uri]);
  project.backgroundReplacement = { ...project.backgroundReplacement, enabled: true,
    source: { kind: 'video', uri: wide.uri, storageMode: 'linked', displayName: wide.displayName } };
  await assert.rejects(recoverProjectVideoAccess(project, ports), /Video access is still needed/);
});

async function workflow(ports) {
  const sourceText = readFileSync(new URL('../src/services/project-workflows.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(sourceText, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const policy = await import('../src/lib/project-source-frame.ts').catch((error) => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return {};
  });
  const dependencies = {
    '@/lib/project-source-frame': policy,
    '@/lib/project-factory': { createCaptionProject, createVideoClip },
    '@/lib/media-lifecycle': { collectProjectOwnedUris },
    '@/services/caption-generation-session': { createCaptionGenerationSession: () => ({}) },
    '@/services/database': ports,
    '@/services/project-media': ports,
    '@/services/media-import': ports,
    '@/services/project-media-access': ports,
    '@/services/media-permissions': ports,
  };
  const exports = {};
  runInNewContext(outputText, { exports, Date, console, require: (name) => dependencies[name] ?? {} });
  return exports;
}

test('editor loading never prepares retired proxies and keeps the catalog and asset ownership', async () => {
  const project = fixture(); project.clips.shift();
  const events = [];
  const service = await workflow({ getProject: async () => project, ensureProjectVideoAccess: async (value) => value,
    reconcileProjectOwnedFiles: async (_id, uris) => assert.ok(uris.includes(wide.previewUri)),
    ensureProjectThumbnail: async ({ sourceId }) => { events.push(`poster:${sourceId}`); return tall.thumbnailUri; },
    ensureProjectVideoPreview: async ({ source }) => { events.push(`preview:${source.id}`); if (source.id === wide.id) throw new Error('retired proxy failed'); return tall.previewUri; },
    saveProject: async () => assert.fail('unchanged caches need no save') });
  const result = await service.loadProjectForEditing(project.id, {});
  assert.deepEqual(events, ['poster:active', 'preview:active']);
  assert.equal(result.sources[0], project.sources[0]);
});

test('append after deleting all clips reanchors Original and a save failure cannot mutate the input', async () => {
  const project = fixture(); project.sources.pop(); project.clips = [];
  let saved;
  const ports = { pickLinkedVideos: async () => [tall], saveProject: async (value) => { saved = value; },
    deleteProjectOwnedFiles: async () => {}, releaseReadPermissions: async () => {} };
  const service = await workflow(ports);
  assert.deepEqual(size(await service.appendVideosToProject(project)), [1080, 1920]);
  assert.equal(saved.sources.length, 2);
  const failing = await workflow({ ...ports, saveProject: async () => { throw new Error('disk full'); } });
  await assert.rejects(failing.appendVideosToProject(project), /disk full/);
  assert.deepEqual(size(project), [1280, 720]);
  assert.equal(project.clips.length, 0);
});
