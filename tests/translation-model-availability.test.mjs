import assert from 'node:assert/strict';
import test from 'node:test';

import { needsTranslationModelDownloadConsent } from '../src/lib/translation-model-availability.ts';

test('partial downloads still require a user decision before resuming', () => {
  assert.equal(needsTranslationModelDownloadConsent([]), true);
  assert.equal(needsTranslationModelDownloadConsent([{ status: 'incomplete' }]), true);
  assert.equal(needsTranslationModelDownloadConsent([{ status: 'ready' }]), false);
});
