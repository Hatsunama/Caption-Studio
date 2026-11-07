import assert from 'node:assert/strict';
import test from 'node:test';
import { desiredVideoPlaybackWindowEnd } from '../src/lib/video-playback-window.ts';
import { shouldJoinTimelinePreparation, canContinuePreparedTimelineClip } from '../src/lib/video-playback-policy.ts';

const source = { id: 's', uri: 'original', previewUri: 'proxy', durationMs: 10000 };
const entry = (id, start, end, timelineStart = start) => ({ clip: { id, sourceId: 's', sourceStartMs: start,
  sourceEndMs: end, gapBeforeMs: 0, gapAfterMs: 0 }, startMs: timelineStart, endMs: timelineStart + end - start });
const a = entry('a', 0, 2000), b = entry('b', 2000, 6385.9);
const bound = (entries = [a, b], windows = [], platform = 'android', uri = 'proxy') =>
  desiredVideoPlaybackWindowEnd(entries[0], entries, source, uri, windows, platform);

test('integer source cap spans only the contiguous run and preserves full-source reuse', () => {
  assert.equal(bound(), 6385);
  assert.equal(bound([b]), 6385);
  assert.equal(bound([a, { ...b, clip: { ...b.clip, gapBeforeMs: 1 } }]), 2000);
  assert.equal(bound([{ ...a, clip: { ...a.clip, gapAfterMs: 1 } }, b]), 2000);
  assert.equal(bound([{ ...a, clip: { ...a.clip, transitionAfter: { type: 'crossfade', durationMs: 500 } } }, b]), 2000);
  assert.equal(bound([a, { ...b, startMs: 2001 }]), 2000);
  assert.equal(bound([a, entry('b', 2100, 6385, 2000)]), 2000);
  assert.equal(bound([a, { ...b, clip: { ...b.clip, sourceId: 'other' } }]), 2000);
  assert.equal(bound([entry('all', 0, 10000)]), undefined);
  assert.equal(bound([entry('all', 0, 10000)], [], 'ios'), undefined);
});

test('only actual matching transition legs can extend the selected end', () => {
  const leg = { clipId: 'a', sourceId: 's', uri: 'original', sourceStartMs: 1500, sourceEndMs: 2400 };
  const outgoing = { outgoing: leg };
  assert.equal(bound([a], [outgoing]), 2400);
  assert.equal(bound([a], [{ incoming: { ...leg, uri: 'proxy', sourceStartMs: 0 } }]), 2400);
  for (const change of [{ clipId: 'other' }, { sourceId: 'other' }, { uri: 'old-proxy' }]) {
    assert.equal(bound([a], [{ outgoing: { ...leg, ...change } }]), 2000);
  }
  assert.equal(bound([a], [{ outgoing: { ...leg, sourceEndMs: 11000 } }]), undefined);
  assert.equal(bound([a], [{ ...outgoing, unavailableReason: 'unreadable' }]), 2000);
});

test('invalid matching bounds fail closed; relinked URI cannot silently use the source', () => {
  for (const end of [NaN, Infinity, -1, 0, .5]) assert.throws(() => bound([entry('bad', 0, end)]));
  assert.throws(() => bound([a], [{ outgoing: { clipId: 'a', sourceId: 's', uri: 'proxy', sourceStartMs: 0, sourceEndMs: NaN } }]));
  assert.throws(() => bound([a], [], 'android', 'stale-uri'));
  assert.throws(() => desiredVideoPlaybackWindowEnd(a, [a], { ...source, durationMs: NaN }, 'proxy', [], 'android'));
  assert.throws(() => desiredVideoPlaybackWindowEnd(a, [a], { ...source, id: 'other' }, 'proxy', [], 'android'));
});

test('actual join and contiguous handoff reject a changed native window', () => {
  const slot = { sourceId: 's', playbackUri: 'proxy', preparedClipId: 'a', firstFrameReady: true,
    readiness: 'preparing', preparingTimelineMs: 0, preparingWindowEndMs: 2000,
    appliedWindowEndMs: 2000, preparation: new AbortController(), preparationTask: Promise.resolve(0) };
  assert.equal(shouldJoinTimelinePreparation(slot, 'a', 'proxy', 0, false, 6385), false);
  assert.equal(shouldJoinTimelinePreparation(slot, 'a', 'proxy', 0, false, 2000), true);
  const ready = { ...slot, readiness: 'ready', preparation: undefined };
  assert.equal(canContinuePreparedTimelineClip(a, b, ready, 'proxy', { status: 'readyToPlay', currentTime: 2 }, 2000, 6385), false);
  assert.equal(canContinuePreparedTimelineClip(a, b, { ...ready, appliedWindowEndMs: 6385 }, 'proxy', { status: 'readyToPlay', currentTime: 2 }, 2000, 6385), true);
});
