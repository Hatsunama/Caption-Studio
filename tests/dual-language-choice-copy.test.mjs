import assert from 'node:assert/strict';
import test from 'node:test';

import { dualLanguageChoiceCopy } from '../src/components/editor/dual-language-choice-copy.ts';

test('manual second languages are described as editable rather than unavailable', () => {
  assert.deepEqual(dualLanguageChoiceCopy(false, 'German', 'English', 'Qwen'), {
    badge: 'Manual entry',
    detail: 'Add German as a second subtitle track and type its text yourself.',
  });
  assert.equal(dualLanguageChoiceCopy(true, 'German', 'English', 'Qwen').badge, 'On this phone');
});
