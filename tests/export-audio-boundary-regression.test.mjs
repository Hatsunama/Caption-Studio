import assert from 'node:assert/strict';
import test from 'node:test';

import { constrainAudioClips } from '../src/lib/audio-timeline.ts';
import { createEnglishChineseCaptionTrack } from '../src/lib/caption-tracks.ts';
import { exportCaptionPairs } from '../src/lib/export-caption-pairs.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';

test('translated cue with positive fractional duration survives millisecond export', () => {
  const project = createCaptionProject({
    id: 'fractional-caption',
    name: 'Fractional caption',
    sources: [{
      id: 'video',
      uri: 'file:///video.mp4',
      storageMode: 'copied',
      displayName: 'video.mp4',
      durationMs: 10_000,
      width: 1920,
      height: 1080,
      rotation: 0,
      frameRate: 30,
    }],
  });
  project.captions = [{
    id: 'cue',
    text: 'Hello',
    startMs: 1000.1,
    endMs: 1000.4,
    wordIds: [],
    textMode: 'manual',
    timelineVisible: true,
  }];
  const translated = createEnglishChineseCaptionTrack(project, { cue: '你好' });

  const pairs = exportCaptionPairs(translated);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].startMs, 1000);
  assert.equal(pairs[0].endMs, 1001);
});

test('render constraint retains an audible tail shorter than the editing minimum', () => {
  const clip = {
    id: 'voice',
    sourceId: 'voice-source',
    anchor: 'timeline',
    startMs: 9950,
    sourceStartMs: 0,
    sourceEndMs: 100,
    volume: 1,
    muted: false,
    fadeInMs: 0,
    fadeOutMs: 0,
  };

  const constrained = constrainAudioClips([clip], 10_000);
  assert.equal(constrained.length, 1);
  assert.equal(constrained[0].sourceEndMs, 50);
});
