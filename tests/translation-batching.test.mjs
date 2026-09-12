import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createTranslationBatches } from '../src/lib/translation-batching.ts';

const repositoryRoot = new URL('../', import.meta.url);

test('translation batching splits arbitrary selections at the native caption boundary', () => {
  const captions = Array.from({ length: 70 }, (_, index) => ({
    id: `caption-${index + 1}`,
    text: 'Okay',
  }));
  const batches = createTranslationBatches(captions, {
    maxCaptionsPerBatch: 32,
    maxCaptionCharactersPerBatch: 8_000,
  });

  assert.deepEqual(batches.map((batch) => batch.length), [32, 32, 6]);
  assert.deepEqual(batches.flat().map((caption) => caption.id), captions.map((caption) => caption.id));
  assert.equal(new Set(batches.flat()).size, captions.length);
});

test('translation batching enforces character and token capacity without dropping order', () => {
  const characterBound = createTranslationBatches([
    { id: 'a', text: '1234' },
    { id: 'b', text: '5678' },
    { id: 'c', text: '90' },
  ], {
    maxCaptionsPerBatch: 32,
    maxCaptionCharactersPerBatch: 8,
  });
  assert.deepEqual(characterBound.map((batch) => batch.map((caption) => caption.id)), [['a', 'b'], ['c']]);

  const tokenBound = createTranslationBatches(
    Array.from({ length: 8 }, (_, index) => ({ id: `${index}`, text: 'word '.repeat(500) })),
    { maxCaptionsPerBatch: 32, maxCaptionCharactersPerBatch: 100_000 },
  );
  assert.equal(tokenBound.length > 1, true);
  assert.deepEqual(tokenBound.flat().map((caption) => caption.id), ['0', '1', '2', '3', '4', '5', '6', '7']);
});

test('translation batching rejects an invalid runtime capacity contract', () => {
  assert.throws(
    () => createTranslationBatches([{ id: 'a', text: 'Okay' }], {
      maxCaptionsPerBatch: 0,
      maxCaptionCharactersPerBatch: 8_000,
    }),
    /invalid capacity contract/,
  );
});

test('the native module owns translation capacity and the service consumes it', async () => {
  const [translator, module, bridge, service] = await Promise.all([
    readFile(new URL('modules/caption-translation/android/src/main/java/app/captionstudio/translation/NaturalCaptionTranslator.java', repositoryRoot), 'utf8'),
    readFile(new URL('modules/caption-translation/android/src/main/java/app/captionstudio/translation/CaptionTranslationModule.kt', repositoryRoot), 'utf8'),
    readFile(new URL('modules/caption-translation/src/CaptionTranslationModule.ts', repositoryRoot), 'utf8'),
    readFile(new URL('src/services/caption-translation.ts', repositoryRoot), 'utf8'),
  ]);

  assert.match(translator, /static final int MAX_CAPTIONS = 32/);
  assert.match(module, /"maxCaptionsPerBatch" to NaturalCaptionTranslator\.MAX_CAPTIONS/);
  assert.match(bridge, /readonly limits: NaturalCaptionTranslationLimits/);
  assert.match(service, /createTranslationBatches\(captions, limits\)/);
  assert.match(service, /requireNaturalCaptionTranslationLimits\(CaptionTranslation\.limits\)/);
  assert.doesNotMatch(service, /maxCaptionsPerBatch:\s*32/);
});
