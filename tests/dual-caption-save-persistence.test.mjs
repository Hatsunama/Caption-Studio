import assert from 'node:assert/strict';
import test from 'node:test';

import { assertDualCaptionEditsStillCurrent } from '../src/lib/dual-caption-save-merge.ts';

const baseline = {
  captions: [{ id: 'cue-1', text: 'Hello' }],
  captionTracks: { translations: [{ id: 'fr', cues: [{ sourceCaptionId: 'cue-1', text: 'Bonjour' }] }] },
};
const edits = [{ sourceCaptionId: 'cue-1', primaryText: 'Hello', translatedText: 'Salut', primaryChanged: false, translatedChanged: true }];

test('dual-caption save accepts a queued unrelated project update', () => {
  const latest = { ...baseline, name: 'New project name' };
  assert.doesNotThrow(() => assertDualCaptionEditsStillCurrent(baseline, latest, 'fr', edits));
});

test('dual-caption save rejects a conflicting edit to the same translated cue', () => {
  const latest = { ...baseline, captionTracks: { translations: [{ id: 'fr', cues: [{ sourceCaptionId: 'cue-1', text: 'Changed elsewhere' }] }] } };
  assert.throws(() => assertDualCaptionEditsStillCurrent(baseline, latest, 'fr', edits), /changed.*save again/i);
});
