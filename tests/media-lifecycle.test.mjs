import assert from 'node:assert/strict';
import test from 'node:test';

import {
  abandonedLedgerAssets,
  abandonedLinkedMediaPermissions,
  abandonedProjectOwnedUris,
  collectLinkedMediaUris,
  collectProjectOwnedUris,
  createLinkedMediaPermissionLedger,
  createProjectOwnedAssetLedger,
  trackLinkedMediaPermissions,
  trackProjectOwnedAssets,
  unreferencedLinkedMediaUris,
} from '../src/lib/media-lifecycle.ts';

test('linked URI collection includes only externally owned video media and removes duplicates', () => {
  const sharedUri = 'content://media/external/video/7';
  const project = projectFixture({
    sources: [
      source({ id: 'linked', uri: sharedUri, storageMode: 'linked' }),
      source({ id: 'duplicate', uri: sharedUri, storageMode: 'linked' }),
      source({ id: 'copied', uri: 'file:///documents/projects/project/source.mp4', storageMode: 'copied' }),
    ],
    backgroundReplacement: background({
      source: {
        kind: 'video',
        uri: 'content://media/external/video/background',
        storageMode: 'linked',
        displayName: 'Background',
      },
    }),
  });

  assert.deepEqual(collectLinkedMediaUris(project), [
    sharedUri,
    'content://media/external/video/background',
  ]);
});

test('project-owned collection covers copied sources, thumbnails, audio, image layers, and copied backgrounds', () => {
  const duplicateOwnedUri = 'file:///documents/projects/project/shared.png';
  const project = projectFixture({
    sources: [
      source({
        id: 'linked',
        uri: 'content://media/external/video/1',
        storageMode: 'linked',
        thumbnailUri: 'file:///documents/projects/project/thumb.jpg',
      }),
      source({
        id: 'copied',
        uri: 'file:///documents/projects/project/source.mp4',
        storageMode: 'copied',
      }),
    ],
    audioSources: [{
      id: 'audio',
      uri: 'file:///documents/projects/project/audio.m4a',
      storageMode: 'copied',
      displayName: 'Audio',
      durationMs: 1_000,
      origin: 'audio-file',
    }],
    layers: [
      { id: 'captions', kind: 'captions', name: 'Captions', visible: true },
      {
        id: 'image',
        kind: 'image',
        name: 'Sticker',
        visible: true,
        uri: duplicateOwnedUri,
        startMs: 0,
        endMs: 1_000,
        position: { x: 0.5, y: 0.5 },
        box: { width: 0.25, height: 0.25 },
        rotation: 0,
        opacity: 1,
      },
    ],
    backgroundReplacement: background({
      source: {
        kind: 'image',
        uri: duplicateOwnedUri,
        storageMode: 'copied',
        displayName: 'Background',
      },
    }),
  });

  assert.deepEqual(collectProjectOwnedUris(project), [
    'file:///documents/projects/project/thumb.jpg',
    'file:///documents/projects/project/source.mp4',
    'file:///documents/projects/project/audio.m4a',
    duplicateOwnedUri,
  ]);
  assert.doesNotMatch(collectProjectOwnedUris(project).join('\n'), /content:/);
});

test('owned cleanup releases replaced backgrounds and removed image layers without deleting retained shared assets', () => {
  const retainedSharedUri = 'file:///documents/projects/project/shared.png';
  const removedImageUri = 'file:///documents/projects/project/removed-sticker.png';
  const replacedBackgroundUri = 'file:///documents/projects/project/old-background.png';
  const retained = projectFixture({
    layers: [
      { id: 'captions', kind: 'captions', name: 'Captions', visible: true },
      imageLayer('shared', retainedSharedUri),
    ],
    backgroundReplacement: background({
      source: {
        kind: 'image',
        uri: 'file:///documents/projects/project/new-background.png',
        storageMode: 'copied',
        displayName: 'New background',
      },
    }),
  });
  const before = projectFixture({
    layers: [
      { id: 'captions', kind: 'captions', name: 'Captions', visible: true },
      imageLayer('shared', retainedSharedUri),
      imageLayer('removed', removedImageUri),
    ],
    backgroundReplacement: background({
      source: {
        kind: 'image',
        uri: replacedBackgroundUri,
        storageMode: 'copied',
        displayName: 'Old background',
      },
    }),
  });

  assert.deepEqual(abandonedProjectOwnedUris(before, retained), [
    removedImageUri,
    replacedBackgroundUri,
  ]);
  assert.deepEqual(abandonedProjectOwnedUris(retained, before), [
    'file:///documents/projects/project/new-background.png',
  ]);
});

test('the editor asset ledger captures transient copied assets across repeated replacement', () => {
  const initialBackground = 'file:///documents/projects/project/initial-background.png';
  const transientBackground = 'file:///documents/projects/project/transient-background.png';
  const finalBackground = 'file:///documents/projects/project/final-background.png';
  const removedSticker = 'file:///documents/projects/project/removed-sticker.png';
  const initial = projectFixture({
    backgroundReplacement: background({
      source: {
        kind: 'image',
        uri: initialBackground,
        storageMode: 'copied',
        displayName: 'Initial background',
      },
    }),
  });
  const saved = projectFixture({
    backgroundReplacement: background({
      source: {
        kind: 'image',
        uri: finalBackground,
        storageMode: 'copied',
        displayName: 'Final background',
      },
    }),
  });

  const ledger = trackProjectOwnedAssets(
    trackProjectOwnedAssets(createProjectOwnedAssetLedger(initial), [transientBackground]),
    [finalBackground, removedSticker, transientBackground, undefined],
  );

  assert.deepEqual(ledger.uris, [
    initialBackground,
    transientBackground,
    finalBackground,
    removedSticker,
  ]);
  assert.deepEqual(abandonedLedgerAssets(ledger, saved), [
    initialBackground,
    transientBackground,
    removedSticker,
  ]);
  assert.deepEqual(abandonedLedgerAssets(ledger, initial), [
    transientBackground,
    finalBackground,
    removedSticker,
  ]);
});

test('the permission ledger captures transient linked backgrounds across repeated replacement', () => {
  const initialUri = 'content://provider/initial-background';
  const transientUri = 'content://provider/transient-background';
  const finalUri = 'content://provider/final-background';
  const initial = projectFixture({
    backgroundReplacement: background({
      source: {
        kind: 'video',
        uri: initialUri,
        storageMode: 'linked',
        displayName: 'Initial background',
      },
    }),
  });
  const saved = projectFixture({
    backgroundReplacement: background({
      source: {
        kind: 'video',
        uri: finalUri,
        storageMode: 'linked',
        displayName: 'Final background',
      },
    }),
  });
  const ledger = trackLinkedMediaPermissions(
    trackLinkedMediaPermissions(createLinkedMediaPermissionLedger(initial), [transientUri]),
    [finalUri, transientUri, 'file:///documents/local-background.mp4', undefined],
  );

  assert.deepEqual(ledger.uris, [initialUri, transientUri, finalUri]);
  assert.deepEqual(abandonedLinkedMediaPermissions(ledger, saved), [initialUri, transientUri]);
  assert.deepEqual(abandonedLinkedMediaPermissions(ledger, initial), [transientUri, finalUri]);
});

test('release policy retains grants referenced by any saved project and releases only unique content URIs', () => {
  const shared = 'content://media/external/video/shared';
  const backgroundUri = 'content://media/external/video/background';
  const retainedProjects = [
    projectFixture({ sources: [source({ uri: shared })] }),
    projectFixture({
      id: 'other-project',
      sources: [],
      backgroundReplacement: background({
        source: {
          kind: 'video',
          uri: backgroundUri,
          storageMode: 'linked',
          displayName: 'Background',
        },
      }),
    }),
  ];

  assert.deepEqual(unreferencedLinkedMediaUris([
    shared,
    'content://media/external/video/orphan',
    'content://media/external/video/orphan',
    backgroundUri,
    'file:///documents/projects/project/local.mp4',
  ], retainedProjects), ['content://media/external/video/orphan']);
});

test('release policy is exact for URI identity and matches the native Android content scheme contract', () => {
  const referenced = 'content://provider/item/A';
  const project = projectFixture({ sources: [source({ uri: referenced })] });

  assert.deepEqual(unreferencedLinkedMediaUris([
    referenced,
    'content://provider/item/a',
    'CONTENT://provider/item/B',
  ], [project]), [
    'content://provider/item/a',
  ]);
});

function projectFixture(overrides = {}) {
  return {
    schemaVersion: 2,
    id: 'project',
    name: 'Project',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lifecycle: { status: 'saved' },
    sources: [],
    transcription: { language: 'en', modelId: 'fast', words: [], sourceResults: {} },
    captions: [],
    projectStyle: {},
    layers: [{ id: 'captions', kind: 'captions', name: 'Captions', visible: true }],
    clips: [],
    audioSources: [],
    audioClips: [],
    canvas: { preset: 'source', aspectWidth: 9, aspectHeight: 16, backgroundColor: '#000000' },
    videoTransform: { fit: 'fit', position: { x: 0.5, y: 0.5 }, scale: 1, rotation: 0 },
    backgroundReplacement: background(),
    export: { resolution: '1080p', format: 'mp4', burnCaptions: true },
    ...overrides,
  };
}

function source(overrides = {}) {
  return {
    id: 'source',
    uri: 'content://media/external/video/1',
    storageMode: 'linked',
    displayName: 'Video',
    durationMs: 1_000,
    width: 1080,
    height: 1920,
    rotation: 0,
    ...overrides,
  };
}

function background(overrides = {}) {
  return {
    enabled: false,
    mask: {
      qualityPreset: 'stable',
      threshold: 0.46,
      softness: 0.14,
      temporalStability: 0.78,
      edgeFeather: 0.45,
    },
    personTransform: { position: { x: 0.5, y: 0.5 }, scale: 1, rotation: 0 },
    keyframes: [],
    ...overrides,
  };
}

function imageLayer(id, uri) {
  return {
    id,
    kind: 'image',
    name: id,
    visible: true,
    uri,
    startMs: 0,
    endMs: 1_000,
    position: { x: 0.5, y: 0.5 },
    box: { width: 0.25, height: 0.25 },
    rotation: 0,
    opacity: 1,
  };
}
