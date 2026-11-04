import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/services/media-import.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;

function harness(options = {}) {
  const events = [];
  const info = { durationMs: 10_000, width: 720, height: 1280, rotation: 0, frameRate: 30, hasAudio: true, hasVideo: true, hasVideoTrack: true };
  const asset = { uri: 'content://video/one', name: 'one.mp4', size: 10_000, mimeType: 'video/mp4' };
  const dependencies = {
    'caption-media': {
      pickVideoDocuments: async (multiple) => { events.push(['pick', multiple]); return { canceled: false, assets: [asset] }; },
      getMediaInfo: async () => info,
      extractAudioTrack: async (uri, output) => { events.push(['extract', uri, output]); return { durationMs: 10_000, mimeType: 'audio/mp4' }; },
    },
    '@/lib/media-validation': { assertSupportedVideo: () => {} },
    '@/lib/video-timeline': { MINIMUM_CLIP_TIMELINE_MS: 80 },
    '@/services/project-media': {
      MAX_STORED_OVERLAY_VIDEO_BYTES: 512 * 1024 * 1024,
      storeProjectOverlayVideo: async () => { events.push(['copy']); return 'file:///project/overlay.mp4'; },
      prepareExtractedAudioUri: async () => 'file:///project/audio.m4a',
      deleteProjectOwnedFiles: async (id, uris) => { events.push(['delete', ...uris]); },
    },
    '@/services/media-permissions': { releaseReadPermissions: async (uris) => { events.push(['release', ...uris]); } },
    '@/services/storage-policy': { requireFreeSpace: async () => {} },
    '@/services/database': { getProject: async () => null },
    ...options.dependencies,
  };
  const exports = {};
  runInNewContext(compiled, { exports, require: (name) => dependencies[name] ?? {} });
  return { api: exports, events, info, asset };
}

test('overlay import owns one selected video and exposes audio availability before insertion', async () => {
  const { api, events } = harness();
  const selected = await api.pickOverlayVideo('project-1', 'layer-1', () => events.push(['preparing']));
  assert.equal(selected.uri, 'file:///project/overlay.mp4');
  assert.equal(selected.name, 'one.mp4');
  assert.equal(selected.durationMs, 10_000);
  assert.equal(selected.hasAudio, true);
  assert.deepEqual(events.filter(([kind]) => kind === 'pick'), [['pick', false]]);
  assert.ok(events.findIndex(([kind]) => kind === 'pick') < events.findIndex(([kind]) => kind === 'preparing'));
  assert.ok(events.findIndex(([kind]) => kind === 'preparing') < events.findIndex(([kind]) => kind === 'copy'));
  assert.equal(events.some(([kind]) => kind === 'extract'), false);
  assert.equal(events.filter(([kind]) => kind === 'release').length, 1);
  await selected.cleanup();
  await selected.cleanup();
  assert.ok(events.some(([kind, ...uris]) => kind === 'delete' && uris.includes(selected.uri)));
  assert.equal(events.filter(([kind]) => kind === 'delete').length, 1);
  assert.equal(events.some(([kind]) => kind === 'extract'), false);
});

test('failed save cleans an unused overlay but preserves a video referenced by the saved draft', async () => {
  const { api, events } = harness({ dependencies: { '@/services/database': {
    getProject: async () => ({ layers: [{ kind: 'video', uri: 'file:///project/overlay.mp4' }] }),
  } } });
  const selected = await api.pickOverlayVideo('project-1', 'layer-1');
  await api.cleanupUncommittedOverlayVideo('project-1', selected, true);
  assert.equal(events.some(([kind]) => kind === 'delete'), false);
  await api.cleanupUncommittedOverlayVideo('project-1', selected, false);
  assert.equal(events.filter(([kind]) => kind === 'delete').length, 1);
});

test('a completed database read with no draft permits cleanup after an attempted save', async () => {
  const { api, events } = harness();
  const selected = await api.pickOverlayVideo('project-1', 'layer-1');
  await api.cleanupUncommittedOverlayVideo('project-1', selected, true);
  assert.equal(events.filter(([kind]) => kind === 'delete').length, 1);
});

test('oversize overlay is rejected before copy and releases picker access', async () => {
  const { api, asset, events } = harness();
  asset.size = 513 * 1024 * 1024;
  await assert.rejects(api.pickOverlayVideo('project-1', 'layer-1'), /512 MB/);
  assert.equal(events.some(([kind]) => kind === 'copy'), false);
  assert.equal(events.filter(([kind]) => kind === 'release').length, 1);
});

test('failed overlay copy releases picker access', async () => {
  const { api, events } = harness({ dependencies: { '@/services/project-media': {
    storeProjectOverlayVideo: async () => { throw new Error('copy failed'); },
  } } });
  await assert.rejects(api.pickOverlayVideo('project-1', 'layer-1'), /copy failed/);
  assert.equal(events.filter(([kind]) => kind === 'release').length, 1);
});

test('owned overlay copy validates staging and removes it after a failed probe', async () => {
  const projectMedia = readFileSync(new URL('../src/services/project-media.ts', import.meta.url), 'utf8');
  const module = ts.transpileModule(projectMedia, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const events = [];
  const fileSystem = {
    documentDirectory: 'file:///documents/',
    makeDirectoryAsync: async () => {},
    copyAsync: async () => { events.push('copy'); },
    getInfoAsync: async (uri) => uri.includes('.staging-')
      ? { exists: true, isDirectory: false, size: 1000 }
      : { exists: false },
    moveAsync: async () => { events.push('move'); },
    deleteAsync: async (uri) => { events.push(['delete', uri]); },
  };
  const exports = {};
  runInNewContext(module, { exports, require(name) {
    if (name === 'expo-file-system/legacy') return fileSystem;
    if (name === 'caption-media') return { getMediaInfo: async () => ({}) };
    if (name === '@/lib/media-validation') return { assertSupportedVideo: () => { throw new Error('invalid video'); } };
    if (name === '@/services/storage-policy') return { requireFreeSpace: async (bytes) => { events.push(['space', bytes]); } };
    return {};
  } });
  await assert.rejects(exports.storeProjectOverlayVideo({
    projectId: 'project-1', layerId: 'layer-1', sourceUri: 'content://video/one', fileName: 'one.mp4', sizeBytes: 1000,
  }), /invalid video/);
  assert.equal(events[0][0], 'space');
  assert.equal(events[1], 'copy');
  assert.equal(events.includes('move'), false);
  assert.equal(events.filter((event) => Array.isArray(event) && event[0] === 'delete').length, 2);
});
