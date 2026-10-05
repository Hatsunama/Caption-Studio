import assert from 'node:assert/strict';
import test from 'node:test';
import { preservesTranslationContent } from '../src/lib/translation-preservation.ts';
import { acceptTranslationBoundary } from '../src/lib/translation-invariants.ts';
import { usableAutomaticTranslation } from '../src/lib/caption-translation-commit.ts';

const cases = [
  ['emoji', 'Hello \u{1f600}', 'Bonjour \u{1f600}\u{1f600}'],
  ['repeated emoji', 'Hello \u{1f600}\u{1f600}', 'Bonjour \u{1f600}\u{1f600}\u{1f600}'],
  ['URL', 'Read https://example.test/a', 'Lisez https://example.test/a https://example.test/a'],
  ['code', 'Run \u0060x=42\u0060', 'Ex\u00e9cutez \u0060x=42\u0060 \u0060x=42\u0060'],
];
for (const [name, source, output] of cases) {
  test(name + ' duplication fails exact protected-content counts', () => {
    assert.equal(preservesTranslationContent(source, output), false);
  });
  test(name + ' duplication cannot reach automatic persistence', () => {
    const result = acceptTranslationBoundary([{ id: 'cue', text: source }], [{ id: 'cue', text: output }]);
    assert.equal(result.rejected.has('cue'), true);
    assert.equal(result.translations.get('cue'), '');
    assert.equal(usableAutomaticTranslation(source, output, false, 'fr'), undefined);
  });
}
test('matching repeated protected content remains usable', () => {
  const source = 'Hello \u{1f600}\u{1f600}';
  const output = 'Bonjour \u{1f600}\u{1f600}';
  assert.equal(preservesTranslationContent(source, output), true);
  assert.equal(usableAutomaticTranslation(source, output, false, 'fr'), output);
});
