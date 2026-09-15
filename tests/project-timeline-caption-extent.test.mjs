import assert from 'node:assert/strict';
import test from 'node:test';

import { projectTimelineDuration, projectTimelineSegmentAt } from '../src/lib/project-timeline.ts';

test('visible primary and independent translation intervals extend editable canvas', () => {
  const project = {
    clips: [], audioClips: [], layers: [],
    captions: [{ id: 'primary', startMs: 1000, endMs: 2000, timelineVisible: true }],
    captionTracks: { translations: [{ cues: [{ sourceCaptionId: 'primary', startMs: 3000, endMs: 4500, timelineVisible: true }] }] },
  };
  assert.equal(projectTimelineDuration(project), 4500);
  assert.deepEqual(projectTimelineSegmentAt(project, 4000), { kind: 'gap', startMs: 0, endMs: 4500 });
});

test('source-hidden or cue-hidden translations do not retain deleted footage duration', () => {
  const project = {
    clips: [], audioClips: [], layers: [],
    captions: [{ id: 'primary', startMs: 1000, endMs: 2000, timelineVisible: false }],
    captionTracks: { translations: [{ cues: [{ sourceCaptionId: 'primary', startMs: 3000, endMs: 4500, timelineVisible: true }] }] },
  };
  assert.equal(projectTimelineDuration(project), 0);
  project.captions[0].timelineVisible = true;
  project.captionTracks.translations[0].cues[0].timelineVisible = false;
  assert.equal(projectTimelineDuration(project), 2000);
});
