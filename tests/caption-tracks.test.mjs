import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHINESE_SIMPLIFIED_TRACK_ID,
  CHINESE_TRADITIONAL_TRACK_ID,
  ENGLISH_TRACK_ID,
  createEnglishChineseCaptionTrack,
  createTranslationCaptionTrack,
  projectEnglishChineseCaptionLanguage,
  projectPrimaryCaptionLanguage,
  resolveCaptionPairs,
  setTranslationCueStyle,
  setTranslationStackGap,
  setTranslationTrackStyle,
  setTranslationTrackProvider,
  setTranslationTrackVisibility,
  synchronizeCaptionTracks,
  synchronizeCaptionTracksAfterTranscription,
  updatePairedCaptionText,
  updatePairedCaptionTexts,
  DEFAULT_TRANSLATION_STACK_GAP,
} from '../src/lib/caption-tracks.ts';
import { deleteCaptionBlock, setCaptionTexts, splitVideoClip } from '../src/lib/project-editor.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { decodeVersionTwoProject } from '../src/lib/project-schema.ts';
import { setClipPlaybackRate } from '../src/lib/video-timeline.ts';

test('new projects expose a backward-compatible versioned caption-track collection', () => {
  const project = projectFixture();
  assert.deepEqual(project.captionTracks, {
    schemaVersion: 1,
    primaryTrackId: 'captions',
    translations: [],
  });
  assert.equal(project.captions.length, 2);
});

test('English and Chinese cues pair by stable caption identity without duplicating timing', () => {
  const project = projectFixture();
  const bilingual = createEnglishChineseCaptionTrack(project, { c1: '你好，世界' });
  const track = bilingual.captionTracks.translations[0];

  assert.equal(track.id, CHINESE_SIMPLIFIED_TRACK_ID);
  assert.equal(track.languageTag, 'zh-Hans');
  assert.deepEqual(track.styleOverride.font, {
    id: 'system-sans',
    family: 'sans-serif',
    source: 'system',
  });
  assert.equal(track.styleOverride.fontSize, 34);
  assert.equal(track.styleOverride.textColor, '#FFFFFF');
  assert.equal(track.styleOverride.position, undefined);
  assert.deepEqual(track.cues.map((cue) => [cue.sourceCaptionId, cue.text, cue.status]), [
    ['c1', '你好，世界', 'translated'],
    ['c2', '', 'pending'],
  ]);
  assert.equal(Object.hasOwn(track.cues[0], 'startMs'), false);
  assert.equal(Object.hasOwn(track.cues[0], 'endMs'), false);
  assert.equal(project.captionTracks.translations.length, 0);

  const retimed = {
    ...bilingual,
    captions: bilingual.captions.map((caption) => caption.id === 'c1'
      ? { ...caption, startMs: 700, endMs: 2_400 }
      : caption),
  };
  const pair = resolveCaptionPairs(retimed, track.id)[0];
  assert.equal(pair.startMs, 700);
  assert.equal(pair.endMs, 2_400);
  assert.equal(pair.translation.text, '你好，世界');
  assert.ok(pair.style.position.y > bilingual.projectStyle.position.y);
  assert.ok(pair.style.position.y + pair.style.box.height / 2 <= 1);

  const moved = {
    ...bilingual,
    projectStyle: { ...bilingual.projectStyle, position: { x: 0.32, y: 0.44 } },
  };
  const movedPair = resolveCaptionPairs(moved, track.id)[0];
  assert.equal(movedPair.style.position.x, 0.32);
  assert.ok(movedPair.style.position.y > 0.44);
  assert.ok(
    movedPair.style.position.y - movedPair.style.box.height / 2
    >= 0.44 + moved.projectStyle.box.height / 2 - 0.001,
  );
});

test('English-Chinese pairing supports Traditional Chinese and Chinese-primary English tracks', () => {
  const english = projectFixture();
  const traditional = createEnglishChineseCaptionTrack(english, { c1: '你好，世界' }, {
    languageTag: 'zh-Hant',
  });
  assert.equal(traditional.captionTracks.translations[0].id, CHINESE_TRADITIONAL_TRACK_ID);
  assert.equal(traditional.captionTracks.translations[0].displayName, 'Chinese (Traditional)');

  const bothChineseScripts = createEnglishChineseCaptionTrack(traditional, { c1: '你好，世界' });
  assert.deepEqual(
    bothChineseScripts.captionTracks.translations.map((track) => track.languageTag),
    ['zh-Hant', 'zh-Hans'],
  );

  const chineseBase = projectFixture();
  const chinese = {
    ...chineseBase,
    transcription: { ...chineseBase.transcription, language: 'zh-Hans' },
    captions: [caption('c1', '你好，世界', 500, 1_900), caption('c2', '再见', 2_000, 3_500)],
  };
  const englishTranslation = createEnglishChineseCaptionTrack(chinese, { c1: 'Hello world' });
  const track = englishTranslation.captionTracks.translations[0];
  assert.equal(track.id, ENGLISH_TRACK_ID);
  assert.equal(track.languageTag, 'en');
  assert.equal(track.displayName, 'English');
  assert.equal(track.styleOverride.font.id, 'system-sans');
  assert.equal(track.styleOverride.position, undefined);
  assert.notEqual(
    resolveCaptionPairs(englishTranslation, ENGLISH_TRACK_ID)[0].style.position.y,
    englishTranslation.projectStyle.position.y,
  );
  assert.deepEqual(resolveCaptionPairs(englishTranslation, ENGLISH_TRACK_ID).map((pair) => [pair.startMs, pair.endMs]), [
    [500, 1_900],
    [2_000, 3_500],
  ]);

  assert.throws(
    () => createEnglishChineseCaptionTrack(english, {}, { languageTag: 'en' }),
    /Simplified or Traditional Chinese/,
  );
  assert.throws(
    () => createEnglishChineseCaptionTrack(chinese, {}, { languageTag: 'zh-Hant' }),
    /pair with English/,
  );
});

test('Cantonese Whisper tags pair as Traditional Chinese and survive project reload', () => {
  const cantonese = {
    ...projectFixture(),
    transcription: { ...projectFixture().transcription, language: 'yue' },
  };
  assert.equal(projectPrimaryCaptionLanguage(cantonese), 'zh-Hant');
  assert.equal(projectEnglishChineseCaptionLanguage(cantonese), 'zh-Hant');
  const bilingual = createEnglishChineseCaptionTrack(cantonese, { c1: 'Hello world' });
  assert.equal(bilingual.captionTracks.translations[0].id, ENGLISH_TRACK_ID);
  assert.equal(bilingual.captionTracks.translations[0].languageTag, 'en');
  assert.equal(bilingual.captionTracks.translations[0].sourceLanguageTag, 'zh-Hant');
  const decoded = decodeVersionTwoProject(serializedProject(bilingual));
  assert.equal(decoded.captionTracks.translations[0].sourceLanguageTag, 'zh-Hant');
  assert.equal(decoded.captionTracks.translations[0].languageTag, 'en');
});

test('completed sourceResults win over a stale same-family project language', () => {
  const base = projectFixture();
  const stale = {
    ...base,
    transcription: {
      ...base.transcription,
      language: 'zh-Hans',
      sourceResults: {
        [base.clips[0].sourceId]: {
          language: 'yue',
          modelId: 'balanced',
          generatedAt: '2026-08-27T12:00:00.000Z',
          words: [],
        },
      },
    },
  };
  assert.equal(projectPrimaryCaptionLanguage(stale), 'zh-Hant');
  assert.equal(projectEnglishChineseCaptionLanguage(stale), 'zh-Hant');
});

test('translation visibility changes preserve reviewed text, manual source state, and cue identity', () => {
  const bilingual = createEnglishChineseCaptionTrack(projectFixture());
  const reviewed = updatePairedCaptionText(bilingual, {
    trackId: CHINESE_SIMPLIFIED_TRACK_ID,
    sourceCaptionId: 'c1',
    primaryText: 'Manually edited English',
    translatedText: '人工审核的中文',
    translationStatus: 'reviewed',
  });
  const before = reviewed.captionTracks.translations[0].cues[0];
  const hidden = setTranslationTrackVisibility(reviewed, CHINESE_SIMPLIFIED_TRACK_ID, false);
  const after = hidden.captionTracks.translations[0].cues[0];
  assert.equal(hidden.captionTracks.translations[0].visible, false);
  assert.equal(hidden.captions[0].textMode, 'manual');
  assert.deepEqual(after, before);
  assert.equal(after.status, 'reviewed');
  assert.equal(after.reviewed, true);
  assert.equal(after.id, before.id);
  assert.equal(hidden.captions[0].startMs, bilingual.captions[0].startMs);
  assert.equal(hidden.captions[0].endMs, bilingual.captions[0].endMs);
  assert.throws(
    () => setTranslationTrackVisibility(hidden, CHINESE_SIMPLIFIED_TRACK_ID, 'yes'),
    /visibility is invalid/,
  );
});

test('freshness and human review survive source edits, reverts, and primary-language changes', () => {
  const reviewed = updatePairedCaptionText(createEnglishChineseCaptionTrack(projectFixture()), {
    trackId: CHINESE_SIMPLIFIED_TRACK_ID,
    sourceCaptionId: 'c1',
    translatedText: '人工审核',
    translationStatus: 'reviewed',
  });
  assert.equal(reviewed.captionTracks.translations[0].sourceLanguageTag, 'en');
  const changedCaptions = reviewed.captions.map((caption) => caption.id === 'c1'
    ? { ...caption, text: 'Changed source' }
    : caption);
  const stale = synchronizeCaptionTracks(reviewed, changedCaptions);
  assert.equal(stale.translations[0].cues[0].status, 'stale');
  assert.equal(stale.translations[0].cues[0].reviewed, true);
  const reverted = synchronizeCaptionTracks({
    ...reviewed,
    captionTracks: stale,
  }, reviewed.captions);
  assert.equal(reverted.translations[0].cues[0].status, 'reviewed');
  assert.equal(reverted.translations[0].cues[0].reviewed, true);

  const changedLanguage = synchronizeCaptionTracks({
    ...reviewed,
    transcription: { ...reviewed.transcription, language: 'zh-Hans' },
  });
  assert.equal(changedLanguage.translations[0].cues[0].status, 'stale');
});

test('dual subtitles fail closed for mixed-language clips and reset after a source-family change', () => {
  const english = projectFixture();
  assert.equal(projectEnglishChineseCaptionLanguage(english), 'en');
  const bilingual = createEnglishChineseCaptionTrack(english, { c1: '你好世界', c2: '现在再见' });
  const mixed = multiSourceProject(['en', 'zh-Hans']);
  assert.throws(
    () => projectEnglishChineseCaptionLanguage(mixed),
    /every video clip to use the same source language/,
  );
  const generated = {
    ...mixed,
    captionTracks: bilingual.captionTracks,
  };
  assert.deepEqual(synchronizeCaptionTracksAfterTranscription(bilingual, generated), {
    schemaVersion: 1,
    primaryTrackId: 'captions',
    translations: [],
  });
});

test('non-English primary captions keep a typed second-language track after the same-language regenerate', () => {
  const base = projectFixture();
  const spanish = {
    ...base,
    transcription: { ...base.transcription, language: 'es' },
  };
  assert.equal(projectPrimaryCaptionLanguage(spanish), 'es');
  assert.throws(() => projectEnglishChineseCaptionLanguage(spanish), /English and Chinese/);
  const dual = createTranslationCaptionTrack(spanish, {
    id: 'translation-en',
    sourceLanguageTag: 'es',
    languageTag: 'en',
    displayName: 'English',
    translations: { c1: 'Hello world' },
  });
  const regenerated = {
    ...dual,
    transcription: { ...dual.transcription, language: 'es' },
    captions: dual.captions.map((caption) => ({ ...caption, text: `${caption.text}!` })),
  };
  const synchronized = synchronizeCaptionTracksAfterTranscription(dual, regenerated);
  assert.equal(synchronized.translations.length, 1);
  assert.equal(synchronized.translations[0].languageTag, 'en');
  assert.equal(synchronized.translations[0].cues[0].status, 'stale');
});

test('automatic translation provenance is complete and cannot be manufactured by project code', () => {
  const bilingual = createEnglishChineseCaptionTrack(projectFixture());
  assert.throws(
    () => setTranslationTrackProvider(bilingual, CHINESE_SIMPLIFIED_TRACK_ID, { id: 'litertlm' }),
    /provenance is incomplete/,
  );
  const generated = setTranslationTrackProvider(bilingual, CHINESE_SIMPLIFIED_TRACK_ID, {
    id: 'litertlm',
    modelId: 'qwen2.5-1.5b-q8',
    modelRevision: 'pinned-revision',
    promptVersion: 1,
  }, 'en', '2026-08-27T14:00:00.000Z');
  assert.deepEqual(generated.captionTracks.translations[0].provider, {
    id: 'litertlm',
    modelId: 'qwen2.5-1.5b-q8',
    modelRevision: 'pinned-revision',
    promptVersion: 1,
  });
  assert.equal(generated.captionTracks.translations[0].origin, 'automatic');
});

test('paired text updates are atomic, preserve timing, and stale other translations', () => {
  const initial = createTranslationCaptionTrack(
    createEnglishChineseCaptionTrack(projectFixture(), { c1: '旧中文' }),
    {
      id: 'translation-es',
      languageTag: 'es',
      displayName: 'Spanish',
      translations: { c1: 'Hola mundo' },
    },
  );
  const before = initial.captions[0];
  const updated = updatePairedCaptionText(initial, {
    trackId: CHINESE_SIMPLIFIED_TRACK_ID,
    sourceCaptionId: 'c1',
    primaryText: 'Hello brave world',
    translatedText: '你好，勇敢的世界',
    translationStatus: 'reviewed',
    updatedAt: '2026-08-27T12:00:00.000Z',
  });

  const primary = updated.captions[0];
  assert.equal(primary.text, 'Hello brave world');
  assert.equal(primary.textMode, 'manual');
  assert.equal(primary.startMs, before.startMs);
  assert.equal(primary.endMs, before.endMs);
  assert.deepEqual(primary.sourceAnchor, before.sourceAnchor);
  const chinese = updated.captionTracks.translations[0].cues[0];
  assert.equal(chinese.text, '你好，勇敢的世界');
  assert.equal(chinese.sourceTextSnapshot, 'Hello brave world');
  assert.equal(chinese.status, 'reviewed');
  assert.equal(updated.captionTracks.translations[1].cues[0].status, 'stale');
  assert.equal(updated.updatedAt, '2026-08-27T12:00:00.000Z');
});

test('batch paired edits reject ambiguity and update multiple script rows deterministically', () => {
  const bilingual = createEnglishChineseCaptionTrack(projectFixture());
  const updated = updatePairedCaptionTexts(bilingual, [
    { trackId: CHINESE_SIMPLIFIED_TRACK_ID, sourceCaptionId: 'c1', translatedText: '第一句' },
    { trackId: CHINESE_SIMPLIFIED_TRACK_ID, sourceCaptionId: 'c2', primaryText: 'Second edited', translatedText: '第二句' },
  ], '2026-08-27T12:10:00.000Z');
  assert.deepEqual(updated.captionTracks.translations[0].cues.map((cue) => cue.text), ['第一句', '第二句']);
  assert.equal(updated.captions[1].text, 'Second edited');
  assert.equal(updated.updatedAt, '2026-08-27T12:10:00.000Z');
  assert.throws(() => updatePairedCaptionTexts(bilingual, [
    { trackId: CHINESE_SIMPLIFIED_TRACK_ID, sourceCaptionId: 'c1', translatedText: '一' },
    { trackId: CHINESE_SIMPLIFIED_TRACK_ID, sourceCaptionId: 'c1', translatedText: '二' },
  ]), /more than one update for track/);
});

test('track synchronization adds split captions, removes deleted captions, and marks changed source text stale', () => {
  const bilingual = createEnglishChineseCaptionTrack(projectFixture(), { c1: '第一句', c2: '第二句' });
  const splitCaption = {
    ...bilingual.captions[1],
    id: 'c3',
    text: 'New split caption',
    startMs: 3_100,
    endMs: 3_900,
  };
  const captions = [
    { ...bilingual.captions[0], text: 'Changed English' },
    splitCaption,
  ];
  const synchronized = synchronizeCaptionTracks(bilingual, captions);
  assert.deepEqual(synchronized.translations[0].cues.map((cue) => [cue.sourceCaptionId, cue.status]), [
    ['c1', 'stale'],
    ['c3', 'pending'],
  ]);
  assert.equal(synchronized.translations[0].cues[0].sourceTextSnapshot, 'Hello world');
  assert.equal(synchronized.translations[0].cues.some((cue) => cue.sourceCaptionId === 'c2'), false);

  const pending = createEnglishChineseCaptionTrack(projectFixture());
  const changedPending = synchronizeCaptionTracks(pending, [
    { ...pending.captions[0], text: 'Changed while pending' },
    pending.captions[1],
  ]);
  assert.equal(changedPending.translations[0].cues[0].status, 'pending');
  assert.equal(changedPending.translations[0].cues[0].sourceTextSnapshot, 'Changed while pending');
});

test('translation style inheritance is project then source caption then track then cue', () => {
  let project = projectFixture();
  project = {
    ...project,
    projectStyle: { ...project.projectStyle, textColor: '#FFFFFF', fontSize: 40 },
    captions: project.captions.map((caption) => caption.id === 'c1'
      ? { ...caption, styleOverride: { textColor: '#FF0000', fontSize: 52 } }
      : caption),
  };
  project = createEnglishChineseCaptionTrack(project, { c1: '你好，世界' });
  project = setTranslationTrackStyle(project, CHINESE_SIMPLIFIED_TRACK_ID, {
    position: { y: 0.9 },
    textColor: '#00AAFF',
  });
  project = setTranslationCueStyle(project, CHINESE_SIMPLIFIED_TRACK_ID, 'c1', {
    textColor: '#00FF00',
  });
  const style = resolveCaptionPairs(project, CHINESE_SIMPLIFIED_TRACK_ID)[0].style;
  assert.equal(style.fontSize, 34);
  assert.equal(style.font.id, 'system-sans');
  assert.equal(style.font.source, 'system');
  assert.equal(style.position.y, 0.9);
  assert.equal(style.textColor, '#00FF00');
});

test('second-language captions stay below the original and keep independent type color', () => {
  const bilingual = createEnglishChineseCaptionTrack(projectFixture(), { c1: '你好，世界' });
  const pair = resolveCaptionPairs(bilingual, CHINESE_SIMPLIFIED_TRACK_ID)[0];
  const primaryBottom = bilingual.projectStyle.position.y + bilingual.projectStyle.box.height / 2;
  const translationTop = pair.style.position.y - pair.style.box.height / 2;
  assert.ok(pair.style.position.y > bilingual.projectStyle.position.y);
  assert.ok(translationTop >= primaryBottom - 0.0001, `secondary top ${translationTop} should sit below primary bottom ${primaryBottom}`);
  assert.equal(pair.style.fontSize, 34);
  const recolored = {
    ...bilingual,
    projectStyle: { ...bilingual.projectStyle, textColor: '#FF4FD8', fontSize: 64 },
  };
  const recoloredPair = resolveCaptionPairs(recolored, CHINESE_SIMPLIFIED_TRACK_ID)[0];
  assert.equal(recoloredPair.style.textColor, '#FFFFFF');
  assert.equal(recoloredPair.style.fontSize, 34);
  const farther = setTranslationStackGap(bilingual, CHINESE_SIMPLIFIED_TRACK_ID, DEFAULT_TRANSLATION_STACK_GAP + 0.06);
  const fartherPair = resolveCaptionPairs(farther, CHINESE_SIMPLIFIED_TRACK_ID)[0];
  assert.ok(fartherPair.style.position.y >= pair.style.position.y);
  assert.equal(farther.captionTracks.translations[0].stackGap, DEFAULT_TRANSLATION_STACK_GAP + 0.06);
  const sized = setTranslationTrackStyle(bilingual, CHINESE_SIMPLIFIED_TRACK_ID, { fontSize: 22, textColor: '#64D2FF' });
  const sizedPair = resolveCaptionPairs(sized, CHINESE_SIMPLIFIED_TRACK_ID)[0];
  assert.equal(sizedPair.style.fontSize, 22);
  assert.equal(sizedPair.style.textColor, '#64D2FF');
  assert.equal(sized.projectStyle.fontSize, bilingual.projectStyle.fontSize);
});

test('existing primary-caption editor operations keep translated cues synchronized', () => {
  const bilingual = createEnglishChineseCaptionTrack(projectFixture(), { c1: '你好', c2: '再见' });
  const edited = setCaptionTexts(bilingual, { c1: 'Hello changed' });
  assert.equal(edited.captionTracks.translations[0].cues[0].status, 'stale');
  const deleted = deleteCaptionBlock(edited, 'c2');
  assert.deepEqual(deleted.captionTracks.translations[0].cues.map((cue) => cue.sourceCaptionId), ['c1']);
});

test('splitting a video preserves both halves of an existing translation cue', () => {
  const bilingual = createEnglishChineseCaptionTrack(projectFixture(), { c1: '你好世界', c2: '再见' });
  const result = splitVideoClip(bilingual, 'clip-source-1-0', 1_500, 'left', 'right');
  assert.ok(result);
  const sourceCaptionIds = result.project.captionTracks.translations[0].cues.map((cue) => cue.sourceCaptionId);
  assert.deepEqual(sourceCaptionIds, ['c1', 'c1-right', 'c2']);
  const [leftCue, rightCue] = result.project.captionTracks.translations[0].cues;
  assert.equal(`${leftCue.text}${rightCue.text}`, '你好世界');
  assert.deepEqual([leftCue.status, rightCue.status], ['translated', 'translated']);
  const captionById = new Map(result.project.captions.map((caption) => [caption.id, caption]));
  assert.equal(leftCue.sourceTextSnapshot, captionById.get('c1').text);
  assert.equal(rightCue.sourceTextSnapshot, captionById.get('c1-right').text);
});

test('timeline speed changes preserve cue linkage and resolve translated timing from the primary track', () => {
  const bilingual = createEnglishChineseCaptionTrack(projectFixture(), { c1: '你好', c2: '再见' });
  const changed = setClipPlaybackRate(bilingual, 'clip-source-1-0', 2);
  const pairs = resolveCaptionPairs(changed, CHINESE_SIMPLIFIED_TRACK_ID);
  assert.deepEqual(pairs.map((pair) => [pair.startMs, pair.endMs]), changed.captions.map((caption) => [caption.startMs, caption.endMs]));
  assert.deepEqual(pairs.map((pair) => pair.translation.id), bilingual.captionTracks.translations[0].cues.map((cue) => cue.id));
  assert.deepEqual(pairs.map((pair) => pair.translation.status), ['translated', 'translated']);
});

test('project decoding migrates legacy projects and validates nested translation-track data', () => {
  const legacy = serializedProject(projectFixture());
  delete legacy.captionTracks;
  assert.deepEqual(decodeVersionTwoProject(legacy).captionTracks, {
    schemaVersion: 1,
    primaryTrackId: 'captions',
    translations: [],
  });

  const bilingual = createEnglishChineseCaptionTrack(projectFixture(), { c1: '你好' });
  const missingCue = serializedProject(bilingual);
  missingCue.captionTracks.translations[0].cues = missingCue.captionTracks.translations[0].cues.slice(0, 1);
  const hydrated = decodeVersionTwoProject(missingCue);
  assert.deepEqual(hydrated.captionTracks.translations[0].cues.map((cue) => cue.status), ['translated', 'pending']);

  const stale = serializedProject(bilingual);
  stale.captions[0].text = 'Changed outside the translation editor';
  assert.equal(decodeVersionTwoProject(stale).captionTracks.translations[0].cues[0].status, 'stale');

  const invalidLanguage = serializedProject(bilingual);
  invalidLanguage.captionTracks.translations[0].languageTag = 'not a language tag';
  assert.throws(() => decodeVersionTwoProject(invalidLanguage), /language is invalid/);

  const mismatchedSource = serializedProject(bilingual);
  mismatchedSource.captionTracks.translations[0].sourceLanguageTag = 'zh-Hans';
  assert.throws(() => decodeVersionTwoProject(mismatchedSource), /no longer matches the primary caption language/);

  const falseProvider = serializedProject(bilingual);
  falseProvider.captionTracks.translations[0].origin = 'automatic';
  falseProvider.captionTracks.translations[0].provider = { id: 'litertlm' };
  assert.throws(() => decodeVersionTwoProject(falseProvider), /incomplete local-model provenance/);

  const inconsistentReview = serializedProject(bilingual);
  inconsistentReview.captionTracks.translations[0].cues[0].reviewed = true;
  assert.throws(() => decodeVersionTwoProject(inconsistentReview), /inconsistent review state/);

  const duplicateLink = serializedProject(bilingual);
  duplicateLink.captionTracks.translations[0].cues.push({
    ...duplicateLink.captionTracks.translations[0].cues[0],
    id: 'duplicate-cue',
  });
  assert.throws(() => decodeVersionTwoProject(duplicateLink), /duplicate source-caption links/);

  const invalidStatus = serializedProject(bilingual);
  invalidStatus.captionTracks.translations[0].cues[0].status = 'approved-by-magic';
  assert.throws(() => decodeVersionTwoProject(invalidStatus), /status is invalid/);

  const unknownSource = serializedProject(bilingual);
  unknownSource.captionTracks.translations[0].cues[0].sourceCaptionId = 'missing-caption';
  assert.throws(() => decodeVersionTwoProject(unknownSource), /unknown primary caption/);
});

function projectFixture() {
  const project = createCaptionProject({
    id: 'project-bilingual',
    name: 'Bilingual Project',
    sources: [{
      id: 'source-1',
      uri: 'content://media/video/1',
      storageMode: 'linked',
      displayName: 'speaker.mp4',
      durationMs: 4_000,
      width: 1080,
      height: 1920,
      rotation: 0,
    }],
  });
  return {
    ...project,
    transcription: { ...project.transcription, language: 'en' },
    captions: [
      caption('c1', 'Hello world', 500, 1_900),
      caption('c2', 'Goodbye now', 2_000, 3_500),
    ],
  };
}

function multiSourceProject(languages) {
  const sources = languages.map((language, index) => ({
    id: `source-${index + 1}`,
    uri: `content://media/video/${index + 1}`,
    storageMode: 'linked',
    displayName: `${language}-${index + 1}.mp4`,
    durationMs: 4_000,
    width: 1080,
    height: 1920,
    rotation: 0,
  }));
  const project = createCaptionProject({ id: 'project-mixed', name: 'Mixed Project', sources });
  return {
    ...project,
    transcription: {
      ...project.transcription,
      language: languages[0],
      sourceResults: Object.fromEntries(sources.map((source, index) => [source.id, {
        language: languages[index],
        modelId: 'balanced',
        generatedAt: '2026-08-27T12:00:00.000Z',
        words: [],
      }])),
    },
    captions: [caption('c1', 'Hello world', 500, 1_900)],
  };
}

function caption(id, text, startMs, endMs) {
  return {
    id,
    text,
    startMs,
    endMs,
    wordIds: [],
    textMode: 'automatic',
    timelineVisible: true,
    sourceAnchor: {
      clipId: 'clip-source-1-0',
      sourceStartMs: startMs,
      sourceEndMs: endMs,
      wordIds: [],
    },
  };
}

function serializedProject(project) {
  return JSON.parse(JSON.stringify(project));
}
