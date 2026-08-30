import assert from 'node:assert/strict';
import test from 'node:test';

import { groupWordsIntoCaptions, groupingOptionsForLanguage, joinWords } from '../src/lib/caption-grouping.ts';
import { mergeCaptionScriptBlock, splitCaptionScriptBlock } from '../src/lib/caption-script.ts';
import { splitVideoClip } from '../src/lib/project-editor.ts';
import { serializeAss } from '../src/lib/subtitle-export.ts';
import { remapCaptionsToTimeline } from '../src/lib/video-timeline.ts';
import { coalesceWhisperWords } from '../src/lib/whisper-words.ts';
import { DEFAULT_CAPTION_STYLE } from '../src/types/project.ts';

test('Simplified Chinese Whisper pieces keep character timing and attach punctuation without Latin spaces', () => {
  const words = coalesceWhisperWords([
    { text: ' 你', t0: 100, t1: 110 },
    { text: '好', t0: 110, t1: 120 },
    { text: '，', t0: 120, t1: 125 },
    { text: ' 世界', t0: 130, t1: 150 },
    { text: '！', t0: 150, t1: 155 },
  ]);

  assert.deepEqual(words.map((word) => word.text), ['你', '好，', '世', '界！']);
  assert.deepEqual(words.map(({ startMs, endMs }) => [startMs, endMs]), [
    [1_000, 1_100],
    [1_100, 1_250],
    [1_300, 1_400],
    [1_400, 1_550],
  ]);
  assert.equal(joinWords(words), '你好，世界！');
});

test('Traditional Chinese and Latin Whisper pieces preserve natural mixed-script boundaries', () => {
  const words = coalesceWhisperWords([
    { text: ' 我愛', t0: 0, t1: 30 },
    { text: ' Caption', t0: 30, t1: 45 },
    { text: ' Studio', t0: 45, t1: 60 },
    { text: '，', t0: 60, t1: 65 },
    { text: '真的', t0: 65, t1: 85 },
    { text: '！', t0: 85, t1: 90 },
  ]);

  assert.deepEqual(words.map((word) => word.text), ['我', '愛', 'Caption', 'Studio，', '真', '的！']);
  assert.equal(joinWords(words), '我愛Caption Studio，真的！');
});

test('Chinese caption grouping uses readable CJK limits and sentence punctuation', () => {
  const text = [...'今天天氣很好。我們一起出去散步吧！'];
  const words = text.map((character, index) => ({
    id: `word-${index}`,
    text: character,
    startMs: index * 100,
    endMs: index * 100 + 90,
  }));
  const captions = groupWordsIntoCaptions(words, groupingOptionsForLanguage('zh-Hant'));

  assert.deepEqual(captions.map((caption) => caption.text), ['今天天氣很好。', '我們一起出去散步吧！']);
  assert.ok(captions.every((caption) => !caption.text.includes(' ')));
});

test('Chinese captions without punctuation still split on the CJK character budget', () => {
  const words = [...'今天天氣很好我們一起出去散步吧真的'].map((character, index) => ({
    id: `word-${index}`,
    text: character,
    startMs: index * 100,
    endMs: index * 100 + 90,
  }));
  const captions = groupWordsIntoCaptions(words, groupingOptionsForLanguage('zh-Hans'));
  assert.equal(captions.length, 2);
  assert.ok(captions.every((caption) => [...caption.text].length <= 16));
});

test('Chinese script captions split and merge at character boundaries without manufactured spaces', () => {
  const words = [
    { id: 'word-1', text: '你', startMs: 0, endMs: 300 },
    { id: 'word-2', text: '好，', startMs: 300, endMs: 700 },
    { id: 'word-3', text: '世', startMs: 700, endMs: 1_000 },
    { id: 'word-4', text: '界！', startMs: 1_000, endMs: 1_400 },
  ];
  const captions = [{
    id: 'caption',
    text: '你好，世界！',
    textMode: 'automatic',
    startMs: 0,
    endMs: 1_400,
    wordIds: words.map((word) => word.id),
    timelineVisible: true,
    sourceAnchor: {
      clipId: 'clip',
      sourceStartMs: 0,
      sourceEndMs: 1_400,
      wordIds: words.map((word) => word.id),
    },
  }];

  const split = splitCaptionScriptBlock(captions, 'caption', '你好，'.length, words, 'caption-right');
  assert.ok(split);
  assert.deepEqual(split.captions.map((caption) => ({ text: caption.text, wordIds: caption.wordIds })), [
    { text: '你好，', wordIds: ['word-1', 'word-2'] },
    { text: '世界！', wordIds: ['word-3', 'word-4'] },
  ]);
  const merged = mergeCaptionScriptBlock(split.captions, 'caption-right');
  assert.ok(merged && !('blockedByVideoCut' in merged));
  assert.equal(merged.captions[0].text, '你好，世界！');
});

test('script splitting never cuts an astral Han character at a UTF-16 half-offset', () => {
  const words = [
    { id: 'word-1', text: '𠮷', startMs: 0, endMs: 400 },
    { id: 'word-2', text: '好', startMs: 400, endMs: 800 },
  ];
  const captions = [{
    id: 'caption',
    text: '𠮷好',
    startMs: 0,
    endMs: 800,
    wordIds: words.map((word) => word.id),
    sourceAnchor: { clipId: 'clip', sourceStartMs: 0, sourceEndMs: 800, wordIds: words.map((word) => word.id) },
  }];

  assert.equal(splitCaptionScriptBlock(captions, 'caption', 1, words, 'unsafe'), null);
  const safe = splitCaptionScriptBlock(captions, 'caption', 2, words, 'safe');
  assert.ok(safe);
  assert.deepEqual(safe.captions.map((caption) => caption.text), ['𠮷', '好']);
});

test('video timeline remapping rebuilds automatic Chinese captions without spaces', () => {
  const words = [
    { id: 'clip-word-1', text: '你', startMs: 100, endMs: 300 },
    { id: 'clip-word-2', text: '好，', startMs: 300, endMs: 500 },
    { id: 'clip-word-3', text: '世', startMs: 500, endMs: 700 },
    { id: 'clip-word-4', text: '界！', startMs: 700, endMs: 900 },
  ];
  const [caption] = remapCaptionsToTimeline([{
    id: 'caption',
    text: 'stale text',
    textMode: 'automatic',
    startMs: 100,
    endMs: 900,
    wordIds: words.map((word) => word.id),
    sourceAnchor: {
      clipId: 'clip',
      sourceStartMs: 100,
      sourceEndMs: 900,
      wordIds: words.map((word) => word.id),
    },
  }], [videoClip()], words);

  assert.equal(caption.text, '你好，世界！');
});

test('splitting video under a manual Chinese caption produces clean left and right text', () => {
  const project = projectFixture({
    captions: [{
      id: 'caption',
      text: '你好，世界！',
      textMode: 'manual',
      startMs: 0,
      endMs: 1_000,
      wordIds: [],
      sourceAnchor: { clipId: 'clip', sourceStartMs: 0, sourceEndMs: 1_000, wordIds: [] },
    }],
  });
  const result = splitVideoClip(project, 'clip', 500, 'left', 'right');
  assert.ok(result);
  assert.deepEqual(result.project.captions.map((caption) => caption.text), ['你好，', '世界！']);
});

test('ASS per-word styling preserves compact Chinese spacing', () => {
  const project = projectFixture({
    transcription: {
      language: 'zh-Hans',
      modelId: 'fast',
      sourceResults: {},
      words: [
        { id: 'word-1', text: '你', startMs: 0, endMs: 500 },
        { id: 'word-2', text: '好！', startMs: 500, endMs: 1_000, styleOverride: { textColor: '#00FF00' } },
      ],
    },
    captions: [{ id: 'caption', text: '你好！', startMs: 0, endMs: 1_000, wordIds: ['word-1', 'word-2'] }],
  });
  const ass = serializeAss(project);
  assert.match(ass, /你\{/u);
  assert.doesNotMatch(ass, /你\s+\{/u);
  assert.match(ass, /&H0000FF00&/u);
});

function videoClip(overrides = {}) {
  return {
    id: 'clip',
    sourceId: 'source',
    sourceStartMs: 0,
    sourceEndMs: 1_000,
    availableSourceStartMs: 0,
    availableSourceEndMs: 1_000,
    gapBeforeMs: 0,
    gapAfterMs: 0,
    playbackRate: 1,
    volume: 1,
    muted: false,
    fadeInMs: 0,
    fadeOutMs: 0,
    transitionAfter: { type: 'none', durationMs: 0 },
    ...overrides,
  };
}

function projectFixture(overrides = {}) {
  return {
    schemaVersion: 2,
    id: 'project',
    name: 'Project',
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    lifecycle: { status: 'draft' },
    sources: [{
      id: 'source',
      uri: 'content://video',
      storageMode: 'linked',
      displayName: 'Video',
      durationMs: 1_000,
      width: 1080,
      height: 1920,
      rotation: 0,
    }],
    clips: [videoClip()],
    audioSources: [],
    audioClips: [],
    transcription: { language: 'zh-Hans', modelId: 'fast', words: [], sourceResults: {} },
    captions: [],
    captionTracks: { schemaVersion: 1, translations: [] },
    projectStyle: DEFAULT_CAPTION_STYLE,
    layers: [{ id: 'captions', kind: 'captions', name: 'Captions', visible: true }],
    canvas: { preset: 'source', aspectWidth: 9, aspectHeight: 16, backgroundColor: '#000000' },
    videoTransform: { fit: 'fit', position: { x: 0.5, y: 0.5 }, scale: 1, rotation: 0 },
    backgroundReplacement: {
      enabled: false,
      mask: { qualityPreset: 'stable', threshold: 0.5, softness: 0.18, temporalStability: 0.72, edgeFeather: 0.35 },
      personTransform: { position: { x: 0.5, y: 0.5 }, scale: 1, rotation: 0 },
      keyframes: [],
    },
    export: { resolution: '1080p', format: 'mp4', burnCaptions: true },
    ...overrides,
  };
}
