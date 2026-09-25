import assert from 'node:assert/strict';
import test from 'node:test';

import { assertDualCaptionEditsStillCurrent } from '../src/lib/dual-caption-save-merge.ts';

test('manual translation cannot commit against a source caption changed while saving', () => {
  const baseline = {
    captions: [{ id: 'cue-1', text: 'Hello' }],
    captionTracks: { translations: [{ id: 'fr', languageTag: 'fr', sourceLanguageTag: 'en',
      cues: [{ sourceCaptionId: 'cue-1', text: 'Bonjour' }] }] },
  };
  const latest = { ...baseline, captions: [{ id: 'cue-1', text: 'Goodbye' }] };
  const edits = [{ sourceCaptionId: 'cue-1', primaryChanged: false, translatedChanged: true }];
  assert.throws(() => assertDualCaptionEditsStillCurrent(baseline, latest, 'fr', edits),
    /changed.*save again/i);
});
