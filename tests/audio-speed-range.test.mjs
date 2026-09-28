import assert from 'node:assert/strict';
import test from 'node:test';

import { createCaptionProject } from '../src/lib/project-factory.ts';
import { decodeVersionTwoProject, serializeProjectSnapshot } from '../src/lib/project-schema.ts';

function projectAtRate(rate) {
  const project = createCaptionProject({
    id: 'speed-range', name: 'Speed range', sources: [{
      id: 'video', uri: 'file:///video.mp4', storageMode: 'copied', displayName: 'Video',
      durationMs: 10_000, width: 1920, height: 1080, rotation: 0, frameRate: 30,
    }],
  });
  project.clips[0].playbackRate = rate;
  project.audioSources = [{
    id: 'audio', uri: 'file:///audio.m4a', storageMode: 'copied', displayName: 'Audio',
    durationMs: 10_000, origin: 'video-audio',
  }];
  project.audioClips = [{
    id: 'attached', sourceId: 'audio', anchor: 'video', videoClipId: project.clips[0].id,
    requestedSourceStartMs: 0, requestedSourceEndMs: 800,
    startMs: 0, sourceStartMs: 0, sourceEndMs: 800, playbackRate: rate,
    volume: 1, muted: false, fadeInMs: 0, fadeOutMs: 0,
  }];
  return project;
}

test('attached audio and video preserve endpoint speeds through save and reopen', () => {
  for (const rate of [0.1, 8]) {
    const project = projectAtRate(rate);
    const reopened = decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(project)));
    assert.equal(reopened.clips[0].playbackRate, rate);
    assert.equal(reopened.audioClips[0].playbackRate, rate);
  }
});

test('audio and video reject invalid and nonfinite speeds', () => {
  for (const rate of [0, 0.09, 8.01, Infinity, -Infinity, NaN]) {
    for (const kind of ['clips', 'audioClips']) {
      const project = projectAtRate(1);
      project[kind][0].playbackRate = rate;
      assert.throws(() => decodeVersionTwoProject(project), /playback rate/);
      assert.throws(() => serializeProjectSnapshot(project), /playback rate/);
    }
  }
});
