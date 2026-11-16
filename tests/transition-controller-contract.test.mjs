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

// At a normal Cross exit, preserve native progress and restore the ordinary
// clock/rate, including when no hidden handles slowed the composite to rate .5.
// A real prefix clip primes outgoing slot 1 through normal transport preparation.
for (const sample of [
  { outgoingSlot: 0, eventLateMs: 20, nativeLateMs: 20 },
  { outgoingSlot: 1, eventLateMs: 50, nativeLateMs: 50 },
  { outgoingSlot: 0, eventLateMs: 150, nativeLateMs: 150 },
  { outgoingSlot: 1, eventLateMs: 50, nativeLateMs: 100 },
  { outgoingSlot: 0, eventLateMs: 0, nativeLateMs: 0 },
  { outgoingSlot: 1, eventLateMs: 0, nativeLateMs: 0 },
  { outgoingSlot: 0, eventLateMs: 50, nativeLateMs: 50, noHandles: true },
  { outgoingSlot: 1, eventLateMs: 50, nativeLateMs: 100, noHandles: true },
  { outgoingSlot: 0, eventLateMs: 0, nativeLateMs: 0, noHandles: true },
]) test(`unchanged-clock Cross exit: outgoing slot ${sample.outgoingSlot}, event +${sample.eventLateMs}ms, native +${sample.nativeLateMs}ms, source ${sample.noHandles ? 'no handles' : 'handles'}`, async () => {
  const { outgoingSlot, eventLateMs, nativeLateMs, noHandles = false } = sample;
  const shiftMs = outgoingSlot === 1 ? 4000 : 0;
  const ordinaryClip = (id) => noHandles ? { ...clip(id), sourceStartMs: 0, sourceEndMs: 4000,
    availableSourceStartMs: 0, availableSourceEndMs: 4000 } : clip(id);
  const clips = [ordinaryClip('out'), ordinaryClip('in')];
  const incomingEntry = { clip: clips[1], startMs: shiftMs + 4000 };
  const endpointSourceMs = incomingEntry.clip.sourceStartMs + 500;
  clips[0].transitionAfter = { type: 'crossfade', durationMs: 1000 };
  if (shiftMs) clips.unshift(ordinaryClip('prefix'));
  const h = harness({ clips, sourceDurationMs: noHandles ? 4000 : 8000, nativeClock: true });
  // Float getter rounding is bounded independently of the event's lateness.
  const withinNativeMs = (actual, expected) => Math.abs(actual - expected) < .01;
  try {
    // Start no-handle playback at the shared ordinary/composite window edge.
    // Starting at 3750 lets play's ordinary activation retain source 3750:
    // its 125ms drift from composite 3625 is below the 160ms sync threshold.
    await h.complete(); h.transport.seek(shiftMs + (noHandles ? 3500 : 3750)); await h.complete();
    h.transport.play(); await h.complete();
    const out = h.transport.activeSlot, incoming = 1 - out;
    if (noHandles) {
      // The fake players do not tick. Advance both native legs at rate .5
      // before acknowledging the outgoing clock's 250ms timeline progress.
      h.players[out].currentTime = 3.625;
      h.players[incoming].currentTime = .125;
      await h.positionAck(out);
      near(h.transport.currentMs, shiftMs + 3750);
    }
    assert.equal(out, outgoingSlot, 'normal preparation must establish the requested physical assignment');
    assert.equal(h.transport.slots[out].preparedClipId, 'out');
    assert.equal(h.transport.slots[incoming].preparedClipId, 'in');
    near(h.players[out].playbackRate, noHandles ? .5 : 1);
    near(h.players[incoming].playbackRate, noHandles ? .5 : 1);
    if (noHandles) {
      assert.ok(withinNativeMs(h.players[out].currentTime * 1000, 3625),
        `no-handle outgoing setup: ${h.players[out].currentTime * 1000}ms, expected 3625ms`);
      assert.ok(withinNativeMs(h.players[incoming].currentTime * 1000, 125),
        `no-handle incoming setup: ${h.players[incoming].currentTime * 1000}ms, expected 125ms`);
    }
    if (noHandles) h.players[incoming].currentTime = .375;
    h.players[out].currentTime = noHandles ? 3.875 : 5.25; await h.positionAck(out);
    assert.equal(h.transport.activeSlot, incoming);
    near(h.transport.currentMs, shiftMs + 4250);
    assert.equal(h.players[incoming].playing, true);
    near(h.players[incoming].volume, .8 * Math.sin(3 * Math.PI / 8));
    if (noHandles) assert.ok(withinNativeMs(h.players[incoming].currentTime * 1000, 375),
      `no-handle handoff: ${h.players[incoming].currentTime * 1000}ms, expected 375ms`);

    // Native progress is a fixture input, not a controller seek. Delivery can
    // lag native currentTime: preserve the live player and bound logical progress.
    h.players[incoming].currentTime = (endpointSourceMs + nativeLateMs) / 1000;
    const liveSourceMs = h.players[incoming].currentTime * 1000;
    assert.ok(withinNativeMs(liveSourceMs, endpointSourceMs + nativeLateMs));
    const payloadSeconds = eventLateMs === nativeLateMs
      ? h.players[incoming].currentTime : Math.fround((endpointSourceMs + eventLateMs) / 1000);
    // Independently derive the ordinary clock from the declared clip and entry.
    const ordinaryTimelineMs = (sourceMs) => incomingEntry.startMs
      + (sourceMs - incomingEntry.clip.sourceStartMs) / incomingEntry.clip.playbackRate;
    const payloadTimelineMs = ordinaryTimelineMs(payloadSeconds * 1000);
    const liveTimelineMs = ordinaryTimelineMs(liveSourceMs);
    // The deferred interval represents asynchronous sampling, not Float error.
    // Immediate delivery collapses it to one position within the 0.01ms bound.
    const callStart = h.calls.length;
    const snapshot = (exitTimelineMs) => ({
      backwardSeeks: h.calls.slice(callStart).filter(c => c[0] === 'seek'
        && c[1] === incoming && c[2] * 1000 < liveSourceMs - .01),
      nativePositionPreserved: h.players[incoming].currentTime * 1000 === liveSourceMs,
      timelineWithinObservedInterval: h.transport.currentMs >= payloadTimelineMs - .01
        && h.transport.currentMs <= liveTimelineMs + .01,
      staleTimelinePreserved: exitTimelineMs === undefined
        || withinNativeMs(h.transport.currentMs, exitTimelineMs),
      activeSlot: h.transport.activeSlot,
      rate: h.players[incoming].playbackRate,
      gain: h.players[incoming].volume,
      muted: h.players[incoming].muted,
      playing: h.players[incoming].playing,
      playIntent: h.transport.isPlaying,
      outgoingRetired: h.players[out].muted && !h.players[out].playing,
    });
    const expected = { backwardSeeks: [], nativePositionPreserved: true, timelineWithinObservedInterval: true, staleTimelinePreserved: true,
      activeSlot: incoming, rate: 1, gain: .8, muted: false, playing: true, playIntent: true, outgoingRetired: true };
    h.players[incoming].emit('timeUpdate', { currentTime: payloadSeconds }); await h.settle();
    const afterExit = snapshot();
    const observedExit = { nativeMs: h.players[incoming].currentTime * 1000, timelineMs: h.transport.currentMs };
    // Old outgoing-source delivery has no authority after incoming ownership.
    h.players[out].emit('timeUpdate', { currentTime: noHandles ? 3.8 : 5.1 }); await h.settle();
    const afterStaleOutgoing = snapshot(observedExit.timelineMs);
    // Also reject a queued older incoming sample after ordinary-clock retirement.
    h.players[incoming].emit('timeUpdate', { currentTime: Math.fround(incomingEntry.clip.sourceStartMs / 1000 + .4) }); await h.settle();
    assert.deepEqual({ afterExit, afterStaleOutgoing, afterStaleIncoming: snapshot(observedExit.timelineMs) },
      { afterExit: expected, afterStaleOutgoing: expected, afterStaleIncoming: expected },
      JSON.stringify({ liveSourceMs, payloadTimelineMs, liveTimelineMs, observedExit }));

    if (eventLateMs === 0) {
      h.transport.pause(); await h.complete();
      assert.ok(h.players.every(p => p.muted && !p.playing));
      const pausedSeekCalls = h.calls.length;
      h.transport.seek(shiftMs + 4700); await h.complete();
      near(h.transport.currentMs, shiftMs + 4700);
      assert.ok(withinNativeMs(h.transport.player.currentTime * 1000, incomingEntry.clip.sourceStartMs + 700));
      assert.equal(h.transport.isPlaying, false);
      assert.ok(h.players.every(p => !p.playing), 'a paused seek must finish without playback');
      assert.deepEqual(h.calls.slice(pausedSeekCalls).filter(c => c[0] === 'play' && c[2] === false), [],
        'a paused seek must never request audible playback; muted frame preparation is permitted');
    }
  } finally { h.unmount(); }
});

test('late outgoing Cross exit transfers ownership and catches a behind incoming clock forward', async () => {
  const clips = [clip('out'), clip('in')];
  clips[0].transitionAfter = { type: 'crossfade', durationMs: 1000 };
  const h = harness({ clips, sourceDurationMs: 8000, nativeClock: true });
  try {
    await h.complete(); h.transport.seek(3750); await h.complete();
    h.transport.play(); await h.complete();
    const out = h.transport.activeSlot, incoming = 1 - out;
    h.players[incoming].currentTime = 1.35;
    h.players[out].currentTime = 5.55;
    const callStart = h.calls.length;
    await h.positionAck(out);
    assert.equal(h.transport.activeSlot, incoming);
    near(h.transport.currentMs, 4500);
    assert.deepEqual(h.calls.slice(callStart).filter(c => c[0] === 'seek' && c[1] === incoming),
      [['seek', incoming, 1.5]], 'late outgoing delivery must still catch the incoming player up to the endpoint');
    near(h.players[incoming].currentTime, 1.5);
    near(h.players[incoming].playbackRate, 1);
    near(h.players[incoming].volume, .8);
    assert.equal(h.players[incoming].muted, false);
    assert.equal(h.players[incoming].playing, true);
    assert.equal(h.transport.isPlaying, true);
    assert.ok(h.players[out].muted && !h.players[out].playing);
  } finally { h.unmount(); }
});
