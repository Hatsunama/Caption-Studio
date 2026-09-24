import assert from 'node:assert/strict';
import test from 'node:test';

import { assertCaptionAudioAvailable } from '../src/lib/media-validation.ts';

test('caption generation rejects a video without an audio track in plain language', () => {
  assert.throws(
    () => assertCaptionAudioAvailable({ hasAudio: false }),
    /This video has no audio track\. Choose a video with spoken audio, or add an audio track before generating captions\./,
  );
  assert.doesNotThrow(() => assertCaptionAudioAvailable({ hasAudio: true }));
});
