import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  createRetryableAsyncInitializer,
  decodeEveryPersistedRow,
  extractPersistedContentUris,
} from '../src/lib/persistence-boundaries.ts';
import { classifyPickedMedia } from '../src/lib/picked-media-kind.ts';
import { decodeVersionTwoProject } from '../src/lib/project-schema.ts';

test('database-style initialization is shared while pending and cached after success', async () => {
  let calls = 0;
  const resource = { ready: true };
  const initialize = createRetryableAsyncInitializer(async () => {
    calls += 1;
    await Promise.resolve();
    return resource;
  });

  const [first, second] = await Promise.all([initialize(), initialize()]);
  assert.equal(first, resource);
  assert.equal(second, resource);
  assert.equal(await initialize(), resource);
  assert.equal(calls, 1);
});

test('a failed initialization is discarded so a later database open can recover', async () => {
  let calls = 0;
  const initialize = createRetryableAsyncInitializer(async () => {
    calls += 1;
    if (calls === 1) throw new Error('schema migration failed');
    return 'ready';
  });

  await assert.rejects(initialize(), /schema migration failed/);
  assert.equal(await initialize(), 'ready');
  assert.equal(calls, 2);
});

test('strict persisted-row decoding fails closed instead of omitting corrupt records', () => {
  const rows = [{ value: 'valid' }, { value: 'corrupt' }, { value: 'unreachable' }];
  const decoded = [];
  assert.throws(() => decodeEveryPersistedRow(rows, (row) => {
    if (row.value === 'corrupt') throw new Error('corrupt project');
    decoded.push(row.value);
    return row.value;
  }), /corrupt project/);
  assert.deepEqual(decoded, ['valid']);
});

test('unreadable project cleanup recovers only bounded persisted content grants', () => {
  assert.deepEqual(extractPersistedContentUris(JSON.stringify({
    source: 'content://media/video/1',
    duplicate: 'content://media/video/1',
    local: 'file:///private/project.mp4',
    nested: ['content://provider/document/2'],
  })), ['content://provider/document/2', 'content://media/video/1']);
  assert.deepEqual(extractPersistedContentUris('{broken'), []);
  assert.deepEqual(extractPersistedContentUris(null), []);
});

test('mixed media classification handles absent and generic provider MIME without assuming image', () => {
  assert.equal(classifyPickedMedia(undefined, 'Background.MP4'), 'video');
  assert.equal(classifyPickedMedia('application/octet-stream', 'portrait.heic'), 'image');
  assert.equal(classifyPickedMedia(null, 'provider-item'), 'unknown');
  assert.equal(classifyPickedMedia('video/quicktime', 'misleading.jpg'), 'video');
  assert.equal(classifyPickedMedia('image/png', 'misleading.mp4'), 'image');
});

test('project deletion and URI release use record-first and fail-closed service boundaries', () => {
  const database = readFileSync(new URL('../src/services/database.ts', import.meta.url), 'utf8');
  const permissions = readFileSync(new URL('../src/services/media-permissions.ts', import.meta.url), 'utf8');
  const workflows = readFileSync(new URL('../src/services/project-workflows.ts', import.meta.url), 'utf8');

  assert.match(database, /createRetryableAsyncInitializer\(initializeDatabase\)/);
  assert.match(database, /listProjectsStrict/);
  assert.match(database, /listProjectRecords/);
  assert.match(database, /kind: 'unreadable'/);
  assert.match(permissions, /await listProjectsStrict\(\)/);
  assert.match(workflows, /const deletedProject = await deleteProjectRecord\(projectId\);[\s\S]*deleteProjectFiles\(projectId\)/);
  assert.match(workflows, /deleteUnreadableProjectRecord[\s\S]*releaseUnreferencedReadPermissions/);
  assert.match(workflows, /reconcileOrphanedProjectDirectories\(projectRecordIds\)/);
});

test('the version-two decoder normalizes historical omissions and rejects unsafe nested values', () => {
  const fixture = projectFixture();
  delete fixture.lifecycle;
  delete fixture.audioSources;
  delete fixture.audioClips;
  delete fixture.layers;
  delete fixture.canvas;
  delete fixture.videoTransform;
  delete fixture.backgroundReplacement;
  delete fixture.export;

  const decoded = decodeVersionTwoProject(fixture);
  assert.equal(decoded.lifecycle.status, 'saved');
  assert.equal(decoded.layers[0].kind, 'captions');
  assert.equal(decoded.canvas.preset, 'source');
  assert.equal(decoded.export.resolution, '1080p');

  const legacySystemFont = projectFixture();
  legacySystemFont.projectStyle.font = { id: 'inter-bold', family: 'sans-serif', source: 'built-in' };
  assert.equal(decodeVersionTwoProject(legacySystemFont).projectStyle.font.source, 'system');

  assert.throws(
    () => decodeVersionTwoProject(projectFixture({ canvas: { preset: '9:16', aspectWidth: 0, aspectHeight: 16, backgroundColor: '#000000' } })),
    /canvas width is invalid/,
  );
  assert.throws(
    () => decodeVersionTwoProject(projectFixture({ layers: [{ id: 'effect', kind: 'shader', name: 'Unknown', visible: true }] })),
    /visual layer 1 kind is invalid/,
  );
  assert.throws(
    () => decodeVersionTwoProject(projectFixture({ projectStyle: { ...projectFixture().projectStyle, animation: { id: 'not-real', intensity: 1, durationMs: 100 } } })),
    /animation identifier is invalid/,
  );
  assert.throws(
    () => decodeVersionTwoProject(projectFixture({ backgroundReplacement: { ...projectFixture().backgroundReplacement, source: { kind: 'video', uri: 'file:\/\/\/external.mp4', storageMode: 'linked', displayName: 'Broken' } } })),
    /linked background has an invalid URI/,
  );
  assert.throws(
    () => decodeVersionTwoProject(projectFixture({ projectStyle: { ...projectFixture().projectStyle, font: { id: 'custom', family: 'Custom', source: 'imported' } } })),
    /missing its imported file URI/,
  );
});

function projectFixture(overrides = {}) {
  return {
    schemaVersion: 2,
    id: 'project-1',
    name: 'Project',
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    lifecycle: { status: 'saved' },
    sources: [{
      id: 'source-1',
      uri: 'content://media/video/1',
      storageMode: 'linked',
      displayName: 'Video.mp4',
      durationMs: 4_000,
      width: 1080,
      height: 1920,
      rotation: 0,
    }],
    transcription: { language: 'en', modelId: 'balanced', words: [], sourceResults: {} },
    captions: [],
    projectStyle: {
      font: { id: 'inter-bold', family: 'sans-serif', source: 'built-in' },
      fontSize: 48,
      fontWeight: '800',
      italic: false,
      textColor: '#FFFFFF',
      secondaryTextColor: '#FF4FD8',
      textTreatment: 'solid',
      activeWordColor: '#DFFF35',
      stroke: { color: '#111111', width: 3 },
      shadow: { color: '#000000', opacity: 0.45, blur: 4, offsetX: 0, offsetY: 3 },
      background: { color: '#000000', opacity: 0, radius: 12, paddingX: 14, paddingY: 8 },
      alignment: 'center',
      letterSpacing: 0,
      lineHeight: 1.05,
      textTransform: 'none',
      position: { x: 0.5, y: 0.78 },
      box: { width: 0.86, height: 0.2 },
      rotation: 0,
      maxLines: 2,
      animation: { id: 'active-word', intensity: 0.12, durationMs: 140 },
    },
    layers: [{ id: 'captions', kind: 'captions', name: 'Captions', visible: true }],
    clips: [{
      id: 'clip-1',
      sourceId: 'source-1',
      availableSourceStartMs: 0,
      availableSourceEndMs: 4_000,
      sourceStartMs: 0,
      sourceEndMs: 4_000,
      gapBeforeMs: 0,
      gapAfterMs: 0,
      playbackRate: 1,
      volume: 1,
      muted: false,
      fadeInMs: 0,
      fadeOutMs: 0,
      transitionAfter: { type: 'none', durationMs: 0 },
    }],
    audioSources: [],
    audioClips: [],
    canvas: { preset: 'source', aspectWidth: 1080, aspectHeight: 1920, backgroundColor: '#000000' },
    videoTransform: { fit: 'fit', position: { x: 0.5, y: 0.5 }, scale: 1, rotation: 0 },
    backgroundReplacement: {
      enabled: false,
      mask: { qualityPreset: 'stable', threshold: 0.46, softness: 0.14, temporalStability: 0.78, edgeFeather: 0.45 },
      personTransform: { position: { x: 0.5, y: 0.5 }, scale: 1, rotation: 0 },
      keyframes: [],
    },
    export: { resolution: '1080p', format: 'mp4', burnCaptions: true },
    ...overrides,
  };
}
