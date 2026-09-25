import assert from 'node:assert/strict';
import test from 'node:test';

import { assertCaptionAudioAvailable } from '../src/lib/media-validation.ts';
import { TOP_SPOKEN_CAPTION_LANGUAGES } from '../src/lib/caption-languages.ts';
import { requireDetectedCaptionLanguage } from '../src/lib/transcription-language.ts';

test('caption generation rejects a video without an audio track in plain language', () => {
  assert.throws(
    () => assertCaptionAudioAvailable({ hasAudio: false }),
    /This video has no audio track\. Choose a video with spoken audio, or add an audio track before generating captions\./,
  );
  assert.doesNotThrow(() => assertCaptionAudioAvailable({ hasAudio: true }));
});

test('ASR refuses missing or unknown detected language instead of recording successful captions', () => {
  for (const language of [undefined, null, '', '  ', 'unknown', 'xx']) {
    assert.throws(() => requireDetectedCaptionLanguage(language), /detect.*language|unknown.*language/i);
  }
});

test('ASR retains every listed source language and Whisper Chinese aliases', () => {
  for (const { tag } of TOP_SPOKEN_CAPTION_LANGUAGES) {
    assert.equal(requireDetectedCaptionLanguage(tag), tag);
  }
  assert.equal(requireDetectedCaptionLanguage('zh'), 'zh');
  assert.equal(requireDetectedCaptionLanguage('yue'), 'yue');
});
