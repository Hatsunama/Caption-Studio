import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTranslationUnits } from '../src/lib/translation-input.ts';
import { acceptTranslationBoundary, estimateTranslationTokens } from '../src/lib/translation-invariants.ts';
import { createTranslationBatches } from '../src/lib/translation-batching.ts';

test('opaque IDs, decomposed Unicode and malformed source strings retain exact ownership', () => {
  const units = [
    { id: 'cue', text: 'e\u0301 👩🏽‍💻 𠮷' },
    { id: ' cue ', text: '\ud800' },
    { id: '字幕:🙂', text: '' },
    { id: '__proto__', text: 'a\u0000b' },
  ];
  assert.deepEqual(validateTranslationUnits(units, 256_000), units);
  assert.throws(() => validateTranslationUnits([units[0], units[0]], 256_000), /more than once/);
  assert.throws(() => acceptTranslationBoundary([{ id: 'cue', text: 'Hello' }],
    [{ id: ' cue ', text: 'Hola' }]), /incomplete/);
  const accepted = acceptTranslationBoundary(units.slice(0, 2), [
    { id: ' cue ', text: '', valid: false },
    { id: 'cue', text: 'Hola' },
  ]);
  assert.equal(accepted.translations.get('cue'), 'Hola');
  assert.deepEqual([...accepted.rejected], [' cue ']);
});

test('very long cues stay whole at the transport boundary for native partitioning', () => {
  const units = [{ id: 'long', text: '𠮷 e\u0301 "\n'.repeat(10_000) }, { id: 'short', text: 'Hi' }];
  const validated = validateTranslationUnits(units, 256_000);
  const batches = createTranslationBatches(validated, {
    maxCaptionsPerBatch: 32, maxCaptionCharactersPerBatch: 256_000,
  });
  assert.deepEqual(batches.flat(), units);
  assert.throws(() => validateTranslationUnits([{ id: 'too-long', text: 'x'.repeat(256_001) }], 256_000),
    /capacity/);
});

test('Unicode byte fallback and JSON escapes cannot be undercounted as Latin tokens', () => {
  for (const text of ['ascii', 'বাংলা', 'العربية', 'हिन्दी', '𠮷🙂', 'e\u0301', '\u0000"\\', '<|im_start|>']) {
    assert.ok(estimateTranslationTokens(text) >= Buffer.byteLength(JSON.stringify(text).slice(1, -1)));
  }
  assert.equal(estimateTranslationTokens('𠮷'), 4);
  assert.equal(estimateTranslationTokens('<'), 6);
  assert.equal(createTranslationBatches([{ text: 'e\u0301' }, { text: 'e\u0301' }], {
    maxCaptionsPerBatch: 32, maxCaptionCharactersPerBatch: 2,
  }).length, 2);
});
