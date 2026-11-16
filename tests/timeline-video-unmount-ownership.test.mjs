import assert from 'node:assert/strict';
import test from 'node:test';
import { harness } from './transition-controller-host.mjs';

const clip = (id) => ({ id, sourceId: id === 'out' ? 'source' : 'other',
  sourceStartMs: 1000, sourceEndMs: 5000, availableSourceStartMs: 0, availableSourceEndMs: 8000,
  gapBeforeMs: 0, gapAfterMs: 0, playbackRate: 1, muted: false, volume: .8,
  transform: { position: { x: .5, y: .5 }, scale: 1, rotation: 0, fit: 'contain' },
  transitionAfter: { type: 'none', durationMs: 0 } });
const pair = () => { const clips = [clip('out'), clip('in')];
  clips[0].transitionAfter = { type: 'crossfade', durationMs: 1000 }; return clips; };

async function retire(h) {
  h.unmount();
  assert.equal(h.releasedCount, 2, 'Expo owns and releases both players exactly once');
  assert.ok(h.lifecycleTrace.filter(event => event.operation === 'release').every(event => event.muted && event.volume === 0 && !event.playing),
    'controller quiets both players before Expo passive release');
  assert.equal(h.listenerCount, 0);
  assert.equal(h.timerCount, 0);
  assert.equal(h.gapFrameCount, 0);
  const before = h.calls.length;
  h.transport.retireComposite();
  h.transport.retireComposite(false);
  await h.settle();
  assert.equal(h.calls.length, before, 'retired child callbacks and async drains are inert');
  assert.deepEqual(h.postReleaseAccesses, []);
  h.unmount();
}

test('ordinary editor unmount quiets before automatic Expo release', async () => {
  const h = harness(); await h.complete(); h.transport.play(); await h.complete();
  await retire(h);
});

for (const playing of [false, true]) test(`active composite editor unmount, playing=${playing}`, async () => {
  const h = harness({ clips: pair(), sourceDurationMs: 8000 });
  await h.complete(); h.transport.seek(3750); await h.complete();
  if (playing) { h.transport.play(); await h.complete(); }
  assert.equal(h.transport.slots.filter(slot => slot.readiness === 'ready').length, 2);
  assert.equal(h.views.length, 2);
  await retire(h);
  assert.ok(h.lifecycleTrace.some(event => event.operation === 'compositeCleanup'
    && event.phase === 'passive' && event.releasedCount === 2),
    'actual child passive cleanup executes after both parent Expo releases');
});

for (const stage of ['mask', 'replacement', 'window', 'position', 'frame', 'commit']) {
  test(`unmount cancels pending ${stage} and late completion stays retired`, async () => {
    const h = harness({ holdReplacement: stage === 'replacement', holdMaskAcquire: stage === 'mask', platform: stage === 'frame' ? 'ios' : 'android' });
    const player = h.players[0];
    if (stage === 'window') player.holdWindow = true;
    if (stage === 'commit') player.holdMaskCommit = true;
    await h.settle();
    if (stage === 'frame' || stage === 'commit') await h.positionAck(0);
    const complete = stage === 'mask' ? player.grantMask : stage === 'replacement' ? player.finishReplacement
      : stage === 'window' ? player.finishWindow : stage === 'commit' ? player.finishMaskCommit : undefined;
    if (!['position', 'frame'].includes(stage)) assert.equal(typeof complete, 'function', `must reach ${stage}`);
    assert.ok(h.timerCount > 0, 'preparation is actually pending');
    const staleFrame = h.views[0]?.onFirstFrameRender;
    h.unmount();
    assert.equal(h.timerCount, 0);
    assert.equal(h.listenerCount, 0);
    if (stage !== 'frame') assert.ok(h.calls.some(call => call[0] === 'maskDispose'));
    if (stage === 'window') assert.ok(h.calls.some(call => call[0] === 'cancelWindow'));
    if (['mask', 'replacement', 'window', 'commit'].includes(stage)) {
      assert.ok(h.calls.some(call => call[0] === 'maskCancel'));
    }
    const before = h.calls.length;
    complete?.();
    staleFrame?.();
    player.emit('timeUpdate', { currentTime: 1 });
    player.emit('statusChange', { status: 'error', error: new Error('late event') });
    await h.settle();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls.length, before, 'late native completion issues no new commands');
    assert.deepEqual(h.postReleaseAccesses, []);
    assert.equal(h.releasedCount, 2);
  });
}

test('fresh repeated mounts retire independently without assuming Expo StrictMode recreation', async () => {
  for (let i = 0; i < 4; i++) {
    const h = harness(); await h.complete(); await retire(h);
  }
});

test('unmount cancels a running gap animation clock before player release', async () => {
  const clips = [clip('out')]; clips[0].gapBeforeMs = 1000;
  const h = harness({ clips, allowGapClock: true });
  h.transport.play(); await h.settle();
  assert.equal(h.transport.phase, 'gap');
  assert.equal(h.gapFrameCount, 1);
  await retire(h);
  await h.advance(2000);
  assert.deepEqual(h.postReleaseAccesses, []);
});

test('unmount cancels a scheduled preload while a composite owns the pair', async () => {
  const clips = [...pair(), clip('third')]; clips[2].sourceId = 'source';
  const h = harness({ clips, sourceDurationMs: 8000 });
  await h.complete(); h.transport.seek(3750); await h.complete();
  h.transport.play(); await h.complete();
  h.players[h.transport.activeSlot].currentTime = 5.25;
  await h.positionAck(h.transport.activeSlot);
  assert.equal(h.transport.currentMs, 4250);
  assert.ok(h.timerCount > 0, 'transition tail schedules a real standby preload');
  await retire(h);
  const before = h.calls.length;
  await h.advance(10000);
  assert.equal(h.calls.length, before);
});
