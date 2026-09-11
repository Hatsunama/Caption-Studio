import assert from 'node:assert/strict';
import test from 'node:test';

import {
  adoptCommittedDualCaptionDrafts,
  committedDualCaptionText,
  dualCaptionDraftsFromPairs,
  dualCaptionDraftsMatch,
  mergeRecoveredDualCaptionDrafts,
  shouldRestoreDualCaptionJournal,
} from '../src/lib/dual-caption-drafts.ts';
import {
  assertAutomaticTranslationWroteText,
  automaticTranslationCueWrites,
  translatedSliceReviewFlags,
  usableAutomaticTranslation,
} from '../src/lib/caption-translation-commit.ts';
import {
  acceptTranslationBoundary,
  isPlausibleCueTranslation,
} from '../src/lib/translation-invariants.ts';
import { TOP_SPOKEN_CAPTION_LANGUAGES } from '../src/lib/caption-languages.ts';

test('unedited dual-subtitle drafts adopt committed Chinese immediately', () => {
  const previous = dualCaptionDraftsFromPairs([
    { source: { id: 'c1', text: 'Hello world' }, translation: { text: '' } },
  ]);
  const committed = dualCaptionDraftsFromPairs([
    { source: { id: 'c1', text: 'Hello world' }, translation: { text: '你好，世界' } },
  ]);
  const drafts = { c1: { primaryText: 'Hello world', translatedText: '' } };
  assert.deepEqual(adoptCommittedDualCaptionDrafts(previous, committed, drafts), {
    c1: { primaryText: 'Hello world', translatedText: '你好，世界' },
  });
  assert.equal(committedDualCaptionText('', '你好，世界'), '你好，世界');
  assert.equal(
    dualCaptionDraftsMatch(
      adoptCommittedDualCaptionDrafts(previous, committed, drafts),
      committed,
    ),
    true,
  );
});

test('typed dual-subtitle drafts are not overwritten by a later committed translation', () => {
  const previous = dualCaptionDraftsFromPairs([
    { source: { id: 'c1', text: 'Hello world' }, translation: { text: '' } },
  ]);
  const committed = dualCaptionDraftsFromPairs([
    { source: { id: 'c1', text: 'Hello world' }, translation: { text: '你好，世界' } },
  ]);
  const drafts = { c1: { primaryText: 'Hello world', translatedText: '人工翻译' } };
  assert.deepEqual(adoptCommittedDualCaptionDrafts(previous, committed, drafts), {
    c1: { primaryText: 'Hello world', translatedText: '人工翻译' },
  });
});

test('empty dual-subtitle recovery does not replace committed Chinese with English or a blank', () => {
  const committed = {
    c1: { primaryText: 'Hello world', translatedText: '你好，世界' },
  };
  const recovered = {
    c1: { primaryText: 'Hello world', translatedText: '' },
  };
  assert.deepEqual(mergeRecoveredDualCaptionDrafts(recovered, committed), committed);
  assert.equal(shouldRestoreDualCaptionJournal(recovered, committed), false);
  assert.equal(
    shouldRestoreDualCaptionJournal({ c1: { primaryText: 'Hello world', translatedText: 'Hello world' } }, committed),
    false,
  );
  assert.equal(
    shouldRestoreDualCaptionJournal({ c1: { primaryText: 'Hello world', translatedText: '人工翻译' } }, committed),
    true,
  );
  assert.equal(
    shouldRestoreDualCaptionJournal({ c1: { primaryText: 'Hello edited', translatedText: '' } }, committed),
    true,
  );
});

test('usable Chinese slices are kept even when the parent document was flagged for review', () => {
  const slices = new Map([['c1', '你好，世界'], ['c2', 'Hello world']]);
  const sources = new Map([['c1', 'Hello world'], ['c2', 'Hello world']]);
  const flags = translatedSliceReviewFlags(slices, sources);
  assert.equal(flags.has('c1'), false);
  assert.equal(flags.has('c2'), true);
  assert.equal(usableAutomaticTranslation('Hello world', '你好，世界'), '你好，世界');
  assert.equal(usableAutomaticTranslation('Hello world', 'Hello world'), undefined);
  assert.equal(usableAutomaticTranslation('Hello world', ''), undefined);
});

test('refresh writes committed Chinese and fails closed when nothing usable is returned', () => {
  const captions = [
    { id: 'c1', text: 'Hello world' },
    { id: 'c2', text: 'See you later' },
  ];
  const writes = automaticTranslationCueWrites({
    captions,
    translatedById: new Map([['c1', '你好，世界'], ['c2', '回头见']]),
    previousById: new Map(),
  });
  assert.deepEqual(writes, [
    { sourceCaptionId: 'c1', translatedText: '你好，世界', translationStatus: 'translated' },
    { sourceCaptionId: 'c2', translatedText: '回头见', translationStatus: 'translated' },
  ]);
  assertAutomaticTranslationWroteText(captions, new Map(), writes);

  const rejected = automaticTranslationCueWrites({
    captions,
    translatedById: new Map([['c1', 'Hello world'], ['c2', '']]),
    previousById: new Map(),
  });
  assert.deepEqual(rejected, []);
  assert.throws(
    () => assertAutomaticTranslationWroteText(captions, new Map(), rejected),
    /second language is still empty/,
  );

  const keptPrevious = automaticTranslationCueWrites({
    captions: [captions[0]],
    translatedById: new Map([['c1', 'Hello world']]),
    previousById: new Map([['c1', '你好，世界']]),
  });
  assert.deepEqual(keptPrevious, [{
    sourceCaptionId: 'c1',
    translatedText: '你好，世界',
    translationStatus: 'stale',
  }]);
  assertAutomaticTranslationWroteText([captions[0]], new Map([['c1', '你好，世界']]), keptPrevious);
});

const LINE8_SOURCE = 'positive response on these';
const LINE8_BLEED = '对该请求给出积极回应。请在 GitHub 查看源代码，在 Play Store 下载应用，通过 CuCoin 完成支付，并核对工资单、税务表格以及前后多条字幕里提到的发布说明、安装步骤、账户恢复流程与客服回复内容，确保所有条目都已翻译完整且没有遗漏。';

test('line-8 multi-cue bleed never persists for any supported language', () => {
  assert.equal(LINE8_BLEED.length < 500, true);
  assert.equal(isPlausibleCueTranslation(LINE8_SOURCE, LINE8_BLEED), false);
  assert.equal(usableAutomaticTranslation(LINE8_SOURCE, LINE8_BLEED, false, 'zh-Hans'), undefined);

  for (const language of TOP_SPOKEN_CAPTION_LANGUAGES) {
    const writes = automaticTranslationCueWrites({
      captions: [{ id: 'c8', text: LINE8_SOURCE }],
      translatedById: new Map([['c8', LINE8_BLEED]]),
      previousById: new Map(),
      targetLanguage: language.tag,
    });
    assert.deepEqual(writes, [], language.tag);
  }

  const keptPrevious = automaticTranslationCueWrites({
    captions: [{ id: 'c8', text: LINE8_SOURCE }],
    translatedById: new Map([['c8', LINE8_BLEED]]),
    previousById: new Map([['c8', '积极回应']]),
    targetLanguage: 'zh-Hans',
  });
  assert.deepEqual(keptPrevious, [{
    sourceCaptionId: 'c8',
    translatedText: '积极回应',
    translationStatus: 'stale',
  }]);
});

test('translation boundary rejects duplicates, partial maps, and source fallback', () => {
  const expected = [
    { id: 'c8', text: LINE8_SOURCE },
    { id: 'c9', text: 'Next cue' },
  ];
  assert.throws(
    () => acceptTranslationBoundary(expected, [{ id: 'c8', text: '积极回应' }]),
    /incomplete translation/,
  );
  assert.throws(
    () => acceptTranslationBoundary(expected, [
      { id: 'c8', text: '积极回应' },
      { id: 'c8', text: '又一次' },
    ]),
    /incomplete translation/,
  );
  const rejected = acceptTranslationBoundary(expected, [
    { id: 'c8', text: LINE8_BLEED },
    { id: 'c9', text: '下一句' },
  ]);
  assert.equal(rejected.translations.get('c8'), '');
  assert.equal(rejected.rejected.has('c8'), true);
  assert.equal(rejected.translations.get('c9'), '下一句');
});
