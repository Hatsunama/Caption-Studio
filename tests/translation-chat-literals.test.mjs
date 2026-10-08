import test from 'node:test';
import assert from 'node:assert/strict';
import {
  preservesTranslationContent,
  isInvariantCompositionTranslation,
  translationProse,
} from '../src/lib/translation-preservation.ts';

test('source-supplied chat marker literals retain counts in translated prose', () => {
  for (const marker of ['<|im_start|>', '<|im_end|>', '<|future_token|>', '<|unfinished', '<|']) {
    const source = 'Keep ' + marker + ' literal.';
    assert.equal(preservesTranslationContent(source, 'Conserva ' + marker + ' literal.'), true);
    assert.equal(preservesTranslationContent(source, 'Conserva literal.'), false);
    assert.equal(preservesTranslationContent(source, 'Conserva ' + marker + ' ' + marker + ' literal.'), false);
    assert.equal(preservesTranslationContent(source, 'Conserva <|other|> literal.'), false);
  }
});

test('standalone chat markers are literal data rather than untranslated prose', () => {
  const source = '<|im_start|>';
  assert.equal(translationProse(source).trim(), '');
  assert.equal(isInvariantCompositionTranslation(source, source), true);
});

test('chat markers inside backtick code retain the whole existing code contract', () => {
  const source = 'Keep \u0060<|im_start|>\u0060 literal.';
  assert.equal(preservesTranslationContent(source, 'Conserva \u0060<|im_start|>\u0060 literal.'), true);
  assert.equal(preservesTranslationContent(source, 'Conserva \u0060<|im_end|>\u0060 literal.'), false);
});

test('ordinary comparisons and HTML remain prose, not chat marker literals', () => {
  const source = 'q < 2 and q > 1 <b>bold</b>';
  assert.equal(translationProse(source).includes('bold'), true);
  assert.equal(isInvariantCompositionTranslation(source, source), false);
});
