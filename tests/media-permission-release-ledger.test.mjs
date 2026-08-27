import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMediaPermissionReleaseLedger,
  decodeMediaPermissionReleaseLedger,
  mergeMediaPermissionReleaseLedger,
  settleMediaPermissionReleaseAttempts,
} from '../src/lib/media-permission-release-ledger.ts';

test('release ledger preserves exact URI identity and rejects invalid values', () => {
  assert.deepEqual(createMediaPermissionReleaseLedger([
    'content://provider/item/A',
    'content://provider/item/A',
    'content://provider/item/a',
    'CONTENT://provider/item/B',
    'file:///private/video.mp4',
    null,
  ]), {
    version: 1,
    uris: ['content://provider/item/A', 'content://provider/item/a'],
  });
});

test('release ledger rejects malformed or unknown persisted schemas', () => {
  assert.deepEqual(decodeMediaPermissionReleaseLedger(null), { version: 1, uris: [] });
  assert.deepEqual(
    decodeMediaPermissionReleaseLedger({ version: 2, uris: ['content://provider/item/1'] }),
    { version: 1, uris: [] },
  );
  assert.deepEqual(
    decodeMediaPermissionReleaseLedger({ version: 1, uris: 'content://provider/item/1' }),
    { version: 1, uris: [] },
  );
});

test('release ledger merges durable and newly abandoned permissions without normalization', () => {
  const stored = createMediaPermissionReleaseLedger(['content://provider/item/A']);
  assert.deepEqual(mergeMediaPermissionReleaseLedger(stored, [
    'content://provider/item/a',
    'content://provider/item/A',
  ]), {
    version: 1,
    uris: ['content://provider/item/A', 'content://provider/item/a'],
  });
});

test('only an affirmative native release removes a queued permission', () => {
  const pending = createMediaPermissionReleaseLedger([
    'content://provider/released',
    'content://provider/false-result',
    'content://provider/rejected',
    'content://provider/still-referenced',
  ]);
  assert.deepEqual(settleMediaPermissionReleaseAttempts(pending, [
    { uri: 'content://provider/released', released: true },
    { uri: 'content://provider/false-result', released: false },
    { uri: 'content://provider/rejected', released: false },
  ]), {
    version: 1,
    uris: [
      'content://provider/false-result',
      'content://provider/rejected',
      'content://provider/still-referenced',
    ],
  });
});
