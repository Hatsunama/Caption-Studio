import assert from 'node:assert/strict';
import test from 'node:test';
import { fontChoicePatch } from '../src/lib/font-style-choice.ts';
import { mergeStyle } from '../src/lib/style-resolver.ts';
import { DEFAULT_CAPTION_STYLE } from '../src/types/project.ts';

const dual = {
  font: { id: 'dual', family: 'Dual', source: 'built-in' },
  treatment: 'duotone-offset',
  colors: { primary: '#DFFF35', secondary: '#6A35FF' },
};
const solid = {
  font: { id: 'solid', family: 'Solid', source: 'built-in' },
  treatment: 'solid',
};

test('switching from a two-color font to a single-color font clears the inherited palette', () => {
  const afterDual = mergeStyle(DEFAULT_CAPTION_STYLE, fontChoicePatch(dual));
  const afterSolid = mergeStyle(afterDual, fontChoicePatch(solid));
  assert.equal(afterSolid.textTreatment, 'solid');
  assert.equal(afterSolid.textColor, '#FFFFFF');
  assert.equal(afterSolid.secondaryTextColor, '#FFFFFF');
});

test('chosen two-color values remain independent in the committed style', () => {
  const next = mergeStyle(DEFAULT_CAPTION_STYLE, fontChoicePatch(dual, {
    primary: '#123456', secondary: '#ABCDEF',
  }));
  assert.equal(next.textColor, '#123456');
  assert.equal(next.secondaryTextColor, '#ABCDEF');
});
