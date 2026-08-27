import assert from 'node:assert/strict';
import test from 'node:test';

import { TimelineAudioPlaybackController } from '../src/services/timeline-audio-playback.ts';

test('rapid audio seeks are serialized and only the latest target can start playback', async () => {
  const player = new ControlledPlayer();
  const controller = new TimelineAudioPlaybackController(() => player);
  controller.synchronize([target({ targetSeconds: 1, playing: true })]);
  controller.synchronize([target({ targetSeconds: 5, playing: true })]);
  assert.deepEqual(player.seekTargets, [1]);
  assert.deepEqual(player.playPositions, []);

  player.resolveNextSeek();
  await nextTurn();
  assert.deepEqual(player.seekTargets, [1, 5]);
  assert.deepEqual(player.playPositions, []);

  player.resolveNextSeek();
  await controller.whenIdle();
  assert.deepEqual(player.playPositions, [5]);
  assert.equal(player.playing, true);
  controller.dispose();
});

test('paused scrubbing coalesces to the latest exact position without playing', async () => {
  const player = new ControlledPlayer();
  const controller = new TimelineAudioPlaybackController(() => player);
  controller.synchronize([target({ targetSeconds: 2, playing: false })]);
  controller.synchronize([target({ targetSeconds: 7.25, playing: false })]);
  player.resolveNextSeek();
  await nextTurn();
  player.resolveNextSeek();
  await controller.whenIdle();
  assert.deepEqual(player.seekTargets, [2, 7.25]);
  assert.equal(player.currentTime, 7.25);
  assert.deepEqual(player.playPositions, []);
  controller.dispose();
});

test('a removed audio clip cannot resume after its pending seek completes', async () => {
  const player = new ControlledPlayer();
  const controller = new TimelineAudioPlaybackController(() => player);
  controller.synchronize([target({ targetSeconds: 3, playing: true })]);
  controller.synchronize([]);
  assert.equal(player.removed, 1);
  player.resolveNextSeek();
  await controller.whenIdle();
  assert.deepEqual(player.playPositions, []);
  assert.equal(player.playing, false);
  controller.dispose();
});

test('normal playback tolerates small clock drift but resynchronizes larger drift', async () => {
  const player = new ControlledPlayer(true);
  const controller = new TimelineAudioPlaybackController(() => player);
  controller.synchronize([target({ targetSeconds: 1, playing: true })]);
  await controller.whenIdle();
  player.currentTime = 1.1;
  controller.synchronize([target({ targetSeconds: 1.2, playing: true })]);
  await controller.whenIdle();
  assert.deepEqual(player.seekTargets, [1]);

  controller.synchronize([target({ targetSeconds: 2, playing: true })]);
  await controller.whenIdle();
  assert.deepEqual(player.seekTargets, [1, 2]);
  assert.deepEqual(player.playPositions, [1, 2]);
  controller.dispose();
});

test('relinking a source URI replaces the native player even when the stable source id is retained', async () => {
  const players = [];
  const controller = new TimelineAudioPlaybackController((uri) => {
    const player = new ControlledPlayer(true);
    player.uri = uri;
    players.push(player);
    return player;
  });
  controller.synchronize([target({ uri: 'file:///first.m4a', playing: false })]);
  await controller.whenIdle();
  controller.synchronize([target({ uri: 'file:///replacement.m4a', playing: false })]);
  await controller.whenIdle();
  assert.deepEqual(players.map((player) => player.uri), ['file:///first.m4a', 'file:///replacement.m4a']);
  assert.equal(players[0].removed, 1);
  controller.dispose();
});

class ControlledPlayer {
  currentTime = 0;
  muted = false;
  volume = 1;
  playing = false;
  removed = 0;
  seekTargets = [];
  playPositions = [];
  pendingSeeks = [];

  constructor(resolveImmediately = false) {
    this.resolveImmediately = resolveImmediately;
  }

  seekTo(seconds) {
    this.seekTargets.push(seconds);
    if (this.resolveImmediately) {
      this.currentTime = seconds;
      return Promise.resolve();
    }
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    this.pendingSeeks.push({ seconds, resolve });
    return promise.then(() => { this.currentTime = seconds; });
  }

  resolveNextSeek() {
    const pending = this.pendingSeeks.shift();
    assert.ok(pending, 'Expected a pending seek');
    pending.resolve();
  }

  play() {
    this.playing = true;
    this.playPositions.push(this.currentTime);
  }

  pause() {
    this.playing = false;
  }

  remove() {
    this.removed += 1;
    this.playing = false;
  }
}

function target(overrides = {}) {
  return {
    clipId: 'clip',
    sourceId: 'source',
    uri: 'file:///audio.m4a',
    targetSeconds: 0,
    volume: 1,
    muted: false,
    playing: false,
    ...overrides,
  };
}

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
