import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldTranscribeAudibleTimeline } from '../src/lib/caption-audio-route.ts';

test('one unchanged clip reuses source transcription', () => {
  assert.equal(shouldTranscribeAudibleTimeline({ clips: [{ muted: false, volume: 1 }], audioClips: [] }), false);
});

test('muted or volume-adjusted video transcribes the audible timeline', () => {
  assert.equal(shouldTranscribeAudibleTimeline({ clips: [{ muted: true, volume: 1 }], audioClips: [] }), true);
  assert.equal(shouldTranscribeAudibleTimeline({ clips: [{ muted: false, volume: 0 }], audioClips: [] }), true);
  assert.equal(shouldTranscribeAudibleTimeline({ clips: [{ muted: false, volume: 0.5 }], audioClips: [] }), true);
});

test('multiple clips and audible added audio use the timeline render', () => {
  assert.equal(shouldTranscribeAudibleTimeline({ clips: [{ muted: false, volume: 1 }, { muted: false, volume: 1 }], audioClips: [] }), true);
  assert.equal(shouldTranscribeAudibleTimeline({ clips: [{ muted: false, volume: 1 }], audioClips: [{ muted: false, volume: 1 }] }), true);
});
