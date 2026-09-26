import assert from 'node:assert/strict';
import test from 'node:test';

import * as persistence from '../src/lib/persistence-boundaries.ts';
import { unreferencedLinkedMediaUris } from '../src/lib/media-lifecycle.ts';

const retained = 'content://provider/video/retained';
const corruptRetained = 'content://provider/video/corrupt-retained';
const orphan = 'content://provider/video/orphan';

function decode(row) {
  const value = JSON.parse(row.project_json);
  if (!value.valid) throw new Error('Unreadable project');
  return value.project;
}

function releasable(rows) {
  const inspected = persistence.inspectProjectRowsForMediaPermissionRelease(rows, decode);
  return {
    complete: inspected.complete,
    uris: inspected.complete
      ? unreferencedLinkedMediaUris(
          [retained, corruptRetained, orphan],
          inspected.projects,
          inspected.protectedUris,
        )
      : [],
  };
}

test('release filter excludes URIs protected by unreadable projects', () => {
  assert.deepEqual(
    unreferencedLinkedMediaUris([corruptRetained, orphan], [], [corruptRetained]),
    [orphan],
  );
});

test('a parseable unreadable project protects its URI without blocking unrelated releases', () => {
  const rows = [
    { project_json: JSON.stringify({ valid: true, project: {
      sources: [{ uri: retained, storageMode: 'linked' }],
      backgroundReplacement: {},
    } }) },
    { project_json: JSON.stringify({ valid: false, nested: { uri: corruptRetained } }) },
  ];
  assert.deepEqual(releasable(rows), { complete: true, uris: [orphan] });
});

test('escaped URIs inside an unreadable project remain protected', () => {
  const escaped = corruptRetained.replace('content', '\\u0063ontent');
  assert.deepEqual(releasable([
    { project_json: `{ "valid": false, "source": "${escaped}" }` },
  ]), { complete: true, uris: [retained, orphan] });
});

test('unparseable project data prevents every release', () => {
  assert.deepEqual(releasable([
    { project_json: '{"source":"content://provider/video/unknown"' },
  ]), { complete: false, uris: [] });
});
