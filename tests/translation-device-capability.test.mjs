import assert from 'node:assert/strict';
import test from 'node:test';

import { canOpenDualCaptions } from '../src/lib/translation-device-capability.ts';

test('dual subtitles stay disabled until native translation capability is confirmed', () => {
  assert.equal(canOpenDualCaptions(undefined), false);
  assert.equal(canOpenDualCaptions(false), false);
  assert.equal(canOpenDualCaptions(true), true);
});
