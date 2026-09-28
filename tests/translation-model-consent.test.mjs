import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { translationModelConsentMessage } from '../src/lib/translation-model-consent.ts';
import { TRANSLATION_RELEASE_CONTRACT } from '../modules/caption-translation/src/TranslationReleaseContract.generated.ts';

test('model download consent discloses source, size, mobile data, and offline use', () => {
  const message = translationModelConsentMessage(TRANSLATION_RELEASE_CONTRACT);
  assert.match(message, /1\.60 GB/);
  assert.match(message, /Hugging Face/);
  assert.match(message, /mobile data/i);
  assert.match(message, /offline/i);
  const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
  assert.match(editor, /naturalTranslationDownloadConsentMessage\(\)/);
});
