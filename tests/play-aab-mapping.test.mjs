import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPlayBundleMapping } from '../scripts/verify-play-aab.mjs';

const entry = 'BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map';
const mapping = Buffer.from('com.example.Source -> a:\n');

test('Play bundle requires the generated R8 mapping embedded unchanged', () => {
  assert.match(assertPlayBundleMapping([entry], mapping, mapping), /^[0-9a-f]{64}$/);
  assert.throws(() => assertPlayBundleMapping([], mapping, mapping), /mapping/i);
  assert.throws(() => assertPlayBundleMapping([entry], mapping, Buffer.from('wrong')), /mapping/i);
  assert.throws(() => assertPlayBundleMapping([entry], Buffer.alloc(0), Buffer.alloc(0)), /mapping/i);
});
