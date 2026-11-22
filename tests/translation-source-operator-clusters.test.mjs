import assert from 'node:assert/strict';
import test from 'node:test';
import {
  preservesTranslationContent as preserves,
  isInvariantCompositionTranslation as invariant,
  normalizeTranslationContent as normalize,
  translationProse,
} from '../src/lib/translation-preservation.ts';
import { acceptTranslationBoundary, isInvariantTranslation } from '../src/lib/translation-invariants.ts';

const symbols = '🙂 🚀 👨‍👩‍👧‍👦 ❤️‍🔥 + ++ = ±';
const source = 'Ready + ++ = ± now 🙂';
const translated = '现在 + ++ = ± 已就绪 🙂';

for (const value of [symbols, '+ ++', '+ +++', '= ==', '± ±±']) {
  test('legitimate selected clusters preserve identity: ' + value, () => {
    assert.equal(preserves(value, value), true);
    assert.equal(invariant(value, value), true);
    assert.equal(isInvariantTranslation(value, value, 'pl'), true);
  });
}

test('mixed prose preserves existing clusters without exempting echoed prose', () => {
  assert.equal(preserves(source, translated), true);
  assert.equal(preserves(translated, source), true);
  assert.equal(invariant(source, source), false);
  assert.equal(isInvariantTranslation(source, source, 'zh-Hans'), false);
});

test('selected source clusters use the same unspaced target inventory', () => {
  assert.equal(preserves('Ready + ++ now', '现在+已++就绪'), true);
});

test('symbol passthrough and translated prose reach the real JS boundary', () => {
  const result = acceptTranslationBoundary(
    [{ id: 'symbols', text: symbols }, { id: 'prose', text: source }],
    [{ id: 'symbols', text: symbols }, { id: 'prose', text: translated }],
  );
  assert.equal(result.rejected.size, 0);
  assert.equal(result.translations.get('symbols'), symbols);
  assert.equal(result.translations.get('prose'), translated);
});

for (const [label, output] of [
  ['added isolated plus', translated + ' +'],
  ['added cluster', translated + ' ++'],
  ['expanded cluster', translated.replace('++', '+++')],
  ['dropped cluster', translated.replace(' ++', '')],
  ['shrunk cluster', translated.replace('++', '+')],
  ['mutated cluster', translated.replace('++', '+=')],
  ['dropped isolated plus', translated.replace(' + ', ' ')],
  ['dropped equals', translated.replace(' =', '')],
  ['dropped emoji', translated.replace(' 🙂', '')],
  ['duplicated emoji', translated + ' 🙂'],
]) {
  test(label + ' fails preservation and boundary acceptance', () => {
    assert.equal(preserves(source, output), false);
    const result = acceptTranslationBoundary([{ id: 'cue', text: source }], [{ id: 'cue', text: output }]);
    assert.equal(result.rejected.has('cue'), true);
    assert.equal(result.translations.get('cue'), '');
  });
}

for (const output of ['现在++就绪', '现在+已++就绪', '现在+已+就绪']) {
  test('isolated plus cannot acquire extra selected characters: ' + output, () => {
    assert.equal(preserves('Ready + now', output), false);
  });
}

test('attached ASCII identifiers and numbers remain excluded', () => {
  for (const data of ['C++', 'x+y', 'foo++', '++bar', '_++', '++_', '+42', '42++', '++٤٢']) {
    assert.equal(preserves('Ready + ++ now', '现在 + ++ ' + data), true, data);
    assert.equal(preserves('Ready + now', '现在 ' + data), false, 'cannot supply missing +: ' + data);
  }
  assert.equal(translationProse('C++ x+y +42'), 'C++ x+y +42');
});

test('clusters without an isolated selector retain the release policy', () => {
  assert.equal(preserves('Ready ++ now', '现在就绪'), true);
  assert.equal(translationProse('++'), '++');
  assert.equal(invariant('++', '++'), false);
});

const url = 'https://example.test/cafe\u0301?x=++';
const code = '`cafe\u0301_id++`';
const protectedSource = 'Ready + ++ ' + url + ' ' + code + ' 🙂🙂';
const protectedTarget = '现在 + ++ ' + url + ' ' + code + ' 🙂🙂';
test('URL/code operators stay shielded and prose NFC leaves literal interiors raw', () => {
  assert.equal(preserves(protectedSource, protectedTarget), true);
  assert.equal(normalize('  cafe\u0301 + ++ ' + url + ' ' + code + '  '), 'café + ++ ' + url + ' ' + code);
});
for (const [label, output] of [
  ['URL duplicated', protectedTarget + ' ' + url],
  ['code duplicated', protectedTarget + ' ' + code],
  ['emoji duplicated', protectedTarget + '🙂'],
  ['URL mutated', protectedTarget.replace('?x=++', '?x=+')],
  ['code normalized', protectedTarget.replace(code, code.normalize('NFC'))],
  ['shielded operators cannot replace free operators', protectedTarget.replace(' + ++ ', ' ')],
]) test(label, () => assert.equal(preserves(protectedSource, output), false));

test('symbol identity permits break normalization and horizontal trim', () => {
  const before = '  + ++\r\n\r\n🙂 = ±  ';
  const after = '+ ++\n\n🙂 = ±';
  assert.equal(preserves(before, after), true);
  assert.equal(invariant(before, after), true);
  assert.equal(preserves(before, '+ ++\n🙂 = ±'), false);
});

test('native invalid flag remains authoritative for symbol passthrough', () => {
  const result = acceptTranslationBoundary([{ id: 'cue', text: symbols }], [{ id: 'cue', text: symbols, valid: false }]);
  assert.equal(result.rejected.has('cue'), true);
});
