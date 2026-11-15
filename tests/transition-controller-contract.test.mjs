import assert from 'node:assert/strict';
import test from 'node:test';
import { harness } from './transition-controller-host.mjs';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const clip = (id, rate = 1) => ({ id, sourceId: id === 'out' ? 'source' : 'other', sourceStartMs: 1000, sourceEndMs: 5000,
  availableSourceStartMs: 0, availableSourceEndMs: 8000, gapBeforeMs: 0, gapAfterMs: 0,
  playbackRate: rate, muted: false, volume: .8, fadeInMs: 0, fadeOutMs: 0,
  transform: { position: { x: .5, y: .5 }, scale: 1, rotation: 0, fit: 'fit' }, transitionAfter: { type: 'none', durationMs: 0 } });

for (const type of ['fade-dark', 'dip-black', 'dip-white', 'flash', 'shutter', 'color-wash-cyan', 'color-wash-magenta']) test(`cover ${type} preserves original source clock and half-window audio`, async () => {
  const clips = [clip('out', 2), clip('in', .5)];
  clips[0].transitionAfter = { type, durationMs: 1000 };
  const h = harness({ clips, sourceDurationMs: 8000 });
  try {
    await h.complete(); h.transport.seek(1625); await h.complete(); h.transport.play(); await h.complete();
    const out = h.transport.activeSlot;
    near(h.players[out].playbackRate, 2);
    near(h.players[out].currentTime, 4.25);
    near(h.players[out].volume, .8 * Math.cos(Math.PI / 8));
    assert.equal(h.players[1 - out].muted, true, 'no incoming preecho');
    h.players[out].currentTime = 4.75; await h.positionAck(out);
    near(h.players[out].volume, .8 * Math.cos(3 * Math.PI / 8));
    h.transport.seek(2000); await h.complete();
    near(h.transport.player.currentTime, 1);
    near(h.transport.player.playbackRate, .5);
    near(h.transport.player.volume, 0);
    h.transport.player.currentTime = 1.0625; await h.positionAck(h.transport.activeSlot);
    near(h.transport.player.volume, .8 * Math.sin(Math.PI / 8));
    await h.app('background'); assert.ok(h.players.every(p => p.muted && !p.playing));
  } finally { h.unmount(); }
});

for (const muted of [false, true]) test(`composite handoff keeps both gains and retires safely, incoming muted=${muted}`, async () => {
  const clips = [clip('out'), clip('in')]; clips[0].transitionAfter = { type: 'crossfade', durationMs: 1000 }; clips[1].muted = muted;
  const h = harness({ clips, sourceDurationMs: 8000 });
  try {
    await h.complete(); h.transport.seek(3750); await h.complete(); h.transport.play(); await h.complete();
    const out = h.transport.activeSlot, incoming = 1 - out;
    near(h.players[out].volume, .8 * Math.cos(Math.PI / 8));
    near(h.players[incoming].volume, muted ? 0 : .8 * Math.sin(Math.PI / 8));
    h.players[out].currentTime = 5.25; await h.positionAck(out);
    assert.equal(h.transport.activeSlot, incoming);
    assert.equal(h.players[out].muted, false);
    near(h.players[out].volume, .8 * Math.cos(3 * Math.PI / 8));
    near(h.players[incoming].volume, muted ? 0 : .8 * Math.sin(3 * Math.PI / 8));
    h.players[incoming].currentTime = 1.5; await h.positionAck(incoming);
    assert.equal(h.players[out].muted, true); assert.equal(h.players[out].playing, false);
    near(h.players[incoming].volume, muted ? 0 : .8);
    await h.app('background'); assert.ok(h.players.every(p => p.muted && !p.playing));
  } finally { h.unmount(); }
});

for (const muted of [false, true]) for (const side of ['outgoing', 'incoming']) test(`unavailable composite restores the ordinary ${side} clock and remains navigable, muted=${muted}`, async () => {
  const clips = [clip('out'), clip('in')];
  for (const c of clips) Object.assign(c, { sourceStartMs: 0, sourceEndMs: 4000, availableSourceEndMs: 4000 });
  clips[0].transitionAfter = { type: 'crossfade', durationMs: 1000 };
  clips.forEach(c => { c.muted = muted; });
  const h = harness({ clips, sourceDurationMs: 4000 });
  try {
    await h.complete(); h.transport.seek(3750); await h.complete(); h.transport.play(); await h.complete();
    const out = h.transport.activeSlot;
    if (side === 'incoming') { h.players[out].currentTime = 3.875; await h.positionAck(out); }
    const active = h.transport.activeSlot, standby = 1 - active;
    const expectedMs = side === 'outgoing' ? 3750 : 4250;
    near(h.transport.currentMs, expectedMs);
    h.players[standby].play = () => { throw new Error('synthetic transition renderer unavailable'); };
    h.players[standby].playing = false;
    await h.rotate();
    assert.equal(h.transport.isPlaying, true, 'unavailable notice retains ordinary playback intent');
    assert.equal(h.players[active].playing, true, 'ordinary owner keeps advancing under the existing unavailable notice');
    assert.ok(h.players.every(p => p.muted), 'no unauthorized composite audio');
    near(h.players[active].playbackRate, 1);
    near(h.players[active].currentTime, side === 'outgoing' ? 3.75 : .25);
    h.players[active].emit('timeUpdate', { currentTime: side === 'outgoing' ? 3.625 : .125 });
    await h.settle();
    near(h.transport.currentMs, expectedMs);
    h.transport.pause(); await h.complete();
    assert.ok(h.players.every(p => p.muted && !p.playing));
    near(h.transport.currentMs, expectedMs);
    h.transport.play(); await h.complete();
    assert.equal(h.players[active].playing, true);
    assert.equal(h.players[standby].playing, false);
    near(h.players[active].playbackRate, 1);
    near(h.players[active].currentTime, side === 'outgoing' ? 3.75 : .25);
    assert.ok(h.players.every(p => p.muted && p.volume === 0));
    const nextSource = side === 'outgoing' ? 3.9 : .6;
    h.players[active].currentTime = nextSource; await h.positionAck(active);
    near(h.transport.currentMs, side === 'outgoing' ? 3900 : 4600);
    if (side === 'incoming') { near(h.players[active].volume, muted ? 0 : .8); assert.equal(h.players[active].muted, muted); }
    await h.app('background'); assert.ok(h.players.every(p => p.muted && !p.playing));
    await h.app('active'); await h.complete();
    near(h.transport.currentMs, side === 'outgoing' ? 3900 : 4600);
    assert.equal(h.transport.isPlaying, false, 'resuming does not invent play intent');
  } finally { h.unmount(); }
});

test('waiting on initial standby uses ordinary source events and crosses the cut without a logical lurch', async () => {
  const clips = [clip('out'), clip('in')];
  clips[0].transitionAfter = { type: 'crossfade', durationMs: 1000 };
  const h = harness({ clips, sourceDurationMs: 8000 });
  try {
    h.players[1].holdWindow = true;
    await h.complete();
    const out = h.transport.activeSlot, standby = 1 - out;
    h.transport.seek(3750); await h.settle(); h.transport.play(); await h.settle();
    assert.equal(h.transport.phase, 'ready');
    assert.equal(h.transport.slots[standby].firstFrameReady, false);
    assert.equal(h.players[out].playing, true);
    assert.ok(h.players.every(p => p.muted && p.volume === 0));
    assert.equal(h.players[standby].playing, false);
    near(h.players[out].playbackRate, 1);
    h.players[out].currentTime = 4.9; await h.positionAck(out);
    near(h.transport.currentMs, 3900);
    h.players[standby].holdWindow = false;
    h.players[standby].finishWindow(); await h.complete();
    h.players[out].currentTime = 5.1; await h.positionAck(out);
    near(h.transport.currentMs, 4100);
    assert.equal(h.transport.activeSlot, standby);
    await h.app('background'); assert.ok(h.players.every(p => p.muted && !p.playing));
  } finally { h.unmount(); }
});

test('actual active decoder error keeps actionable source recovery and paused explicit retry', async () => {
  const clips = [clip('out'), clip('in')]; clips[0].transitionAfter = { type: 'crossfade', durationMs: 1000 };
  const h = harness({ clips, sourceDurationMs: 8000 });
  try {
    await h.complete(); h.transport.seek(3750); await h.complete(); h.transport.play(); await h.complete();
    const active = h.transport.activeSlot;
    h.players[active].status = 'error';
    h.players[active].emit('statusChange', { status: 'error', error: new Error('decoder failed') }); await h.settle();
    assert.equal(h.transport.phase, 'error');
    assert.match(h.transport.sourceFailure.detail, /decoder failed/);
    assert.equal(h.transport.isPlaying, false);
    assert.ok(h.players.every(p => p.muted && !p.playing));
    h.transport.retrySource(); await h.complete();
    assert.equal(h.transport.phase, 'ready'); assert.equal(h.transport.sourceFailure, undefined);
    assert.equal(h.transport.isPlaying, false);
    near(h.transport.currentMs, 3750);
    assert.ok(h.players.every(p => p.muted && !p.playing));
  } finally { h.unmount(); }
});

test('retirement rejects stale clock authority and cannot overwrite a newer ordinary source position', async () => {
  const clips = [clip('out'), clip('in')]; clips[0].transitionAfter = { type: 'crossfade', durationMs: 1000 };
  const h = harness({ clips, sourceDurationMs: 8000 });
  try {
    await h.complete(); h.transport.seek(4700); await h.complete(); h.transport.play(); await h.complete();
    const active = h.transport.activeSlot;
    h.transport.setCompositeClock({ key: 'retired-window', slot: active, prepareToken: h.transport.slots[active].prepareToken - 1 });
    h.players[active].currentTime = 1.75;
    const seeks = h.calls.filter(c => c[0] === 'seek').length;
    h.transport.retireComposite();
    near(h.players[active].currentTime, 1.75);
    assert.equal(h.calls.filter(c => c[0] === 'seek').length, seeks, 'retired token has no source-position authority');
    near(h.transport.currentMs, 4700);
  } finally { h.unmount(); }
});

test('composite callback churn does not reseek and cleanup preserves a newer seek owner', async () => {
  const clips = [clip('out'), clip('in')];
  for (const c of clips) Object.assign(c, { sourceStartMs: 0, sourceEndMs: 4000, availableSourceEndMs: 4000 });
  clips[0].transitionAfter = { type: 'crossfade', durationMs: 1000 };
  const h = harness({ clips, sourceDurationMs: 4000 });
  try {
    await h.complete(); h.transport.seek(3750); await h.complete(); h.transport.play(); await h.complete();
    const seeks = h.calls.filter(c => c[0] === 'seek').length;
    await h.rotate(); await h.rotate();
    assert.equal(h.calls.filter(c => c[0] === 'seek').length, seeks);
    near(h.transport.player.playbackRate, .5);
    h.transport.seek(4700); await h.complete();
    near(h.transport.currentMs, 4700); near(h.transport.player.currentTime, .7);
    near(h.transport.player.playbackRate, 1);
    assert.equal(h.transport.player.playing, true);
    near(h.transport.player.volume, .8);
    const standby = 1 - h.transport.activeSlot;
    assert.equal(h.players[standby].muted, true); assert.equal(h.players[standby].playing, false);
    h.transport.seek(1500); await h.complete();
    near(h.transport.currentMs, 1500); near(h.transport.player.currentTime, 1.5);
    h.transport.player.currentTime = 1.7; await h.positionAck(h.transport.activeSlot);
    near(h.transport.currentMs, 1700);
    assert.equal(h.transport.isPlaying, true);
  } finally { h.unmount(); }
});

test('pending fallback retirement never touches players after unmount', async () => {
  const clips = [clip('out'), clip('in')]; clips[0].transitionAfter = { type: 'crossfade', durationMs: 1000 };
  const h = harness({ clips, sourceDurationMs: 8000 });
  try {
    await h.complete(); h.transport.seek(3750); await h.complete(); h.transport.play(); await h.complete();
    const standby = 1 - h.transport.activeSlot;
    h.players[standby].play = () => { throw new Error('synthetic transition renderer unavailable'); };
    h.players[standby].playing = false;
    await h.rotate();
    h.transport.pause(); await h.complete();
    h.transport.play(); h.render();
    h.unmount();
    const mutations = () => h.calls.filter(call => ['play', 'pause', 'seek'].includes(call[0]));
    const before = mutations().length;
    await h.settle();
    assert.equal(mutations().length, before, 'completed target must not access disposed players');
  } finally { h.unmount(); }
});

test('ordinary fallback play failure enters actionable source recovery without an uncaught exception', async () => {
  const clips = [clip('out'), clip('in')]; clips[0].transitionAfter = { type: 'crossfade', durationMs: 1000 };
  const h = harness({ clips, sourceDurationMs: 8000 });
  try {
    await h.complete(); h.transport.seek(3750); await h.complete(); h.transport.play(); await h.complete();
    const active = h.transport.activeSlot;
    h.players[active].playing = false;
    h.players[active].play = () => { throw new Error('synthetic active decoder play failure'); };
    assert.doesNotThrow(() => h.transport.retireComposite());
    await h.settle();
    assert.equal(h.transport.phase, 'error');
    assert.equal(h.transport.isPlaying, false);
    assert.match(h.transport.sourceFailure.detail, /active decoder play failure/);
    assert.ok(h.players.every(player => player.muted && !player.playing));
  } finally { h.unmount(); }
});
