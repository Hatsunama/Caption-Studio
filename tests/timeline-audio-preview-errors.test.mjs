import assert from 'node:assert/strict';
import test from 'node:test';

import * as playback from '../src/services/timeline-audio-playback.ts';

const { TimelineAudioPlaybackController } = playback;
const sourcePath = 'file:///private/user/recordings/voice.m4a';

function target() {
  return {
    clipId: 'clip',
    sourceId: 'source',
    uri: sourcePath,
    targetSeconds: 1,
    volume: 1,
    muted: false,
    playing: true,
  };
}

function player(failingPhase) {
  return {
    muted: false,
    volume: 1,
    seekTo: () => failingPhase === 'seek' ? Promise.reject(new Error(sourcePath)) : Promise.resolve(),
    play: () => { if (failingPhase === 'play') throw new Error(sourcePath); },
    pause: () => {},
    remove: () => {},
  };
}

test('preview failures retain their owning playback phase and produce safe messages', async () => {
  const expected = {
    create: 'Timeline audio preview could not load this audio source.',
    seek: 'Timeline audio preview could not seek this audio source.',
    prepare: 'Timeline audio preview could not configure playback.',
    play: 'Timeline audio preview could not play this audio source.',
  };

  for (const phase of Object.keys(expected)) {
    const errors = [];
    const controller = new TimelineAudioPlaybackController({
      createPlayer: () => {
        if (phase === 'create') throw new Error(sourcePath);
        return player(phase);
      },
      preparePlayback: () => phase === 'prepare'
        ? Promise.reject(new Error(sourcePath))
        : Promise.resolve(),
      onError: (error) => errors.push(error),
    });

    controller.synchronize([target()]);
    await controller.whenIdle();
    assert.equal(errors.length, 1, phase);
    assert.equal(errors[0].phase, phase);
    assert.equal(typeof playback.timelineAudioErrorMessage, 'function');
    const message = playback.timelineAudioErrorMessage(errors[0]);
    assert.equal(message, expected[phase]);
    assert.doesNotMatch(message, /file:|private|recordings|export/i);
    controller.dispose();
  }
});
