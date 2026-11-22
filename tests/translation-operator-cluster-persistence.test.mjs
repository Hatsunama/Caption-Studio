import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptTranslationBoundary } from '../src/lib/translation-invariants.ts';
import { isLikelyUntranslatedCaption, automaticTranslationTargetTags } from '../src/lib/caption-languages.ts';
import { usableAutomaticTranslation, automaticTranslationCueWrites } from '../src/lib/caption-translation-commit.ts';

const symbols = '🙂 🚀 👨‍👩‍👧‍👦 ❤️‍🔥 + ++ = ±';

test('device symbol passthrough reaches accepted automatic writes for every supported target', () => {
  const accepted = acceptTranslationBoundary([{id:'cue',text:symbols}], [{id:'cue',text:symbols}]);
  assert.equal(accepted.rejected.size, 0);
  for (const target of automaticTranslationTargetTags('en')) {
    assert.equal(isLikelyUntranslatedCaption(symbols, symbols, target), false, target);
    assert.equal(usableAutomaticTranslation(symbols, symbols, false, target), symbols, target);
    const writes = automaticTranslationCueWrites({captions:[{id:'cue',text:symbols}],translatedById:accepted.translations,previousById:new Map([['cue','previous accepted text']]),targetLanguage:target});
    assert.deepEqual(writes,[{sourceCaptionId:'cue',translatedText:symbols,translationStatus:'translated'}],target);
  }
});

test('added cluster is rejected without losing previously accepted text', () => {
  const actual = symbols + ' ++';
  assert.equal(usableAutomaticTranslation(symbols, actual, false, 'ja'), undefined);
  const writes = automaticTranslationCueWrites({captions:[{id:'cue',text:symbols}],translatedById:new Map([['cue',actual]]),previousById:new Map([['cue','previous accepted text']]),targetLanguage:'ja'});
  assert.deepEqual(writes,[{sourceCaptionId:'cue',translatedText:'previous accepted text',translationStatus:'stale'}]);
});

test('explicit native rejection still prevents automatic writes', () => {
  const accepted = acceptTranslationBoundary([{id:'cue',text:symbols}],[{id:'cue',text:symbols,valid:false}]);
  assert.equal(accepted.rejected.has('cue'),true);
  assert.equal(usableAutomaticTranslation(symbols,symbols,true,'ja'),undefined);
});

test('ordinary echoed speech remains rejected and translated prose with existing clusters remains usable', () => {
  assert.equal(usableAutomaticTranslation('Keep the scene moving','Keep the scene moving',false,'ja'),undefined);
  assert.equal(usableAutomaticTranslation('Use + ++ now','Utilisez + ++ maintenant',false,'fr'),'Utilisez + ++ maintenant');
});
