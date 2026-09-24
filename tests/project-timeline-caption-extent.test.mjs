import assert from 'node:assert/strict';
import test from 'node:test';

import { projectTimelineDuration, projectTimelineSegmentAt } from '../src/lib/project-timeline.ts';

test('visible primary and independent translation intervals extend editable canvas', () => {
  const project = {
    clips: [], audioClips: [], layers: [{ kind: 'captions', visible: true }], export: { burnCaptions: true },
    captions: [{ id: 'primary', text: 'Hello', startMs: 1000, endMs: 2000, timelineVisible: true }],
    captionTracks: { translations: [{ visible: true, cues: [{ sourceCaptionId: 'primary', text: '你好', startMs: 3000, endMs: 4500, timelineVisible: true }] }] },
  };
  assert.equal(projectTimelineDuration(project), 4500);
  assert.deepEqual(projectTimelineSegmentAt(project, 4000), { kind: 'gap', startMs: 0, endMs: 4500 });
});

test('saved hidden captions and cues remain reachable in the canvas editor', () => {
  const project = {
    clips: [], audioClips: [], layers: [{ kind: 'captions', visible: true }], export: { burnCaptions: true },
    captions: [{ id: 'primary', text: 'Hello', startMs: 1000, endMs: 2000, timelineVisible: false }],
    captionTracks: { translations: [{ visible: true, cues: [{ sourceCaptionId: 'primary', text: '你好', startMs: 3000, endMs: 4500, timelineVisible: true }] }] },
  };
  assert.equal(projectTimelineDuration(project), 4500);
  project.captionTracks.translations[0].visible = false;
  assert.equal(projectTimelineDuration(project), 4500);
  project.captionTracks.translations[0].visible = true;
  project.captions[0].timelineVisible = true;
  project.captionTracks.translations[0].cues[0].timelineVisible = false;
  assert.equal(projectTimelineDuration(project), 4500);
});

test('invalid draft endpoints cannot poison the shared project duration', () => {
  const project = {
    clips: [], audioClips: [], layers: [{ kind: 'captions', visible: true }, { kind: 'text', text: 'Invalid', visible: true, timelineVisible: true, startMs: 0, endMs: Number.NaN }], export: { burnCaptions: true },
    captions: [{ id: 'valid', text: 'Valid', startMs: 0, endMs: 2000, timelineVisible: true }, { id: 'invalid', text: 'Invalid', startMs: 0, endMs: Infinity, timelineVisible: true }],
    captionTracks: { translations: [{ visible: true, cues: [{ sourceCaptionId: 'valid', text: '你好', endMs: Number.NaN, timelineVisible: true }] }] },
  };
  assert.equal(projectTimelineDuration(project), 2000);
});
