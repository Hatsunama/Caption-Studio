import assert from 'node:assert/strict';
import test from 'node:test';

import { applyProjectSourceThumbnail, projectLibraryProject } from '../src/lib/project-library.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';

function fixture() {
  return createCaptionProject({
    id: 'project-1',
    name: 'Latest edit',
    sources: [{
      id: 'source-1',
      uri: 'content://video/latest',
      storageMode: 'linked',
      displayName: 'latest.mp4',
      durationMs: 4000,
      width: 1080,
      height: 1920,
      rotation: 0,
    }],
  });
}

test('library metadata contains list fields without retaining the project body', () => {
  const summary = projectLibraryProject(fixture());
  assert.equal(summary.name, 'Latest edit');
  assert.equal(summary.sourceUri, 'content://video/latest');
  assert.equal(summary.clipCount, 1);
  assert.equal(summary.durationMs, 4000);
  assert.equal('sources' in summary, false);
  assert.equal('captions' in summary, false);
});

test('thumbnail completion applies to the latest project without replacing newer edits', () => {
  const latest = { ...fixture(), name: 'Newer title' };
  const prepared = applyProjectSourceThumbnail(
    latest,
    'source-1',
    'content://video/latest',
    'file:///poster.jpg',
  );
  assert.equal(prepared?.name, 'Newer title');
  assert.equal(prepared?.sources[0]?.thumbnailUri, 'file:///poster.jpg');
});

test('thumbnail completion is rejected after the source has been replaced', () => {
  const project = fixture();
  assert.equal(applyProjectSourceThumbnail(
    project,
    'source-1',
    'content://video/obsolete',
    'file:///poster.jpg',
  ), null);
});
