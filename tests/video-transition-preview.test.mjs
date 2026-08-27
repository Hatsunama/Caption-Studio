import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildVideoTransitionPreviewWindows,
  VIDEO_TRANSITION_PRELOAD_LEAD_MS,
  videoTransitionPreloadWindow,
  videoTransitionPreviewFrameAt,
} from '../src/lib/video-transition-preview.ts';
import { buildClipTimeline } from '../src/lib/video-timeline.ts';

const transform = (rotation = 0) => ({
  fit: 'fit',
  position: { x: 0.5, y: 0.5 },
  scale: 1,
  rotation,
});

const source = (id, durationMs = 6_000) => ({
  id,
  uri: `file:///${id}.mp4`,
  storageMode: 'copied',
  displayName: `${id}.mp4`,
  durationMs,
  width: 1_920,
  height: 1_080,
  rotation: 0,
});

const clip = (id, sourceId, options = {}) => ({
  id,
  sourceId,
  availableSourceStartMs: options.availableSourceStartMs ?? 0,
  availableSourceEndMs: options.availableSourceEndMs ?? 6_000,
  sourceStartMs: options.sourceStartMs ?? 1_000,
  sourceEndMs: options.sourceEndMs ?? 5_000,
  gapBeforeMs: 0,
  gapAfterMs: 0,
  playbackRate: options.playbackRate ?? 1,
  volume: 1,
  muted: false,
  fadeInMs: 0,
  fadeOutMs: 0,
  transitionAfter: options.transitionAfter ?? { type: 'none', durationMs: 0 },
  transform: options.transform ?? transform(),
});

test('transition preview uses the native centered window and hidden handles', () => {
  const clips = [
    clip('out', 'out-source', { transform: transform(12), transitionAfter: { type: 'crossfade', durationMs: 1_000 } }),
    clip('in', 'in-source', { transform: transform(-8) }),
  ];
  const windows = buildVideoTransitionPreviewWindows(
    buildClipTimeline(clips),
    [source('out-source'), source('in-source')],
  );
  const window = windows[0];
  const cut = videoTransitionPreviewFrameAt(windows, 4_000);

  assert.equal(window.startMs, 3_500);
  assert.equal(window.boundaryMs, 4_000);
  assert.equal(window.endMs, 4_500);
  assert.deepEqual(
    [window.outgoing.sourceStartMs, window.outgoing.sourceEndMs, window.outgoing.playbackRate],
    [4_500, 5_500, 1],
  );
  assert.deepEqual(
    [window.incoming.sourceStartMs, window.incoming.sourceEndMs, window.incoming.playbackRate],
    [500, 1_500, 1],
  );
  assert.equal(cut.phase, 0.5);
  assert.equal(cut.outgoingSourceTimeMs, 5_000);
  assert.equal(cut.incomingSourceTimeMs, 1_000);
  assert.equal(cut.outgoing.transform.rotation, 12);
  assert.equal(cut.incoming.transform.rotation, -8);
});

test('full-source clips advance visible tail and head without frozen frames', () => {
  const clips = [
    clip('out', 'out-source', {
      sourceStartMs: 0,
      sourceEndMs: 4_000,
      availableSourceEndMs: 4_000,
      transitionAfter: { type: 'crossfade', durationMs: 600 },
    }),
    clip('in', 'in-source', {
      sourceStartMs: 0,
      sourceEndMs: 4_000,
      availableSourceEndMs: 4_000,
    }),
  ];
  const windows = buildVideoTransitionPreviewWindows(
    buildClipTimeline(clips),
    [source('out-source', 4_000), source('in-source', 4_000)],
  );
  const window = windows[0];

  assert.deepEqual(
    [window.outgoing.sourceStartMs, window.outgoing.sourceEndMs, window.outgoing.playbackRate],
    [3_700, 4_000, 0.5],
  );
  assert.deepEqual(
    [window.incoming.sourceStartMs, window.incoming.sourceEndMs, window.incoming.playbackRate],
    [0, 300, 0.5],
  );
  assert.equal(videoTransitionPreviewFrameAt(windows, 3_700).outgoingSourceTimeMs, 3_700);
  assert.equal(videoTransitionPreviewFrameAt(windows, 4_000).outgoingSourceTimeMs, 3_850);
  assert.equal(videoTransitionPreviewFrameAt(windows, 4_299).outgoingSourceTimeMs, 4_000);
  assert.equal(videoTransitionPreviewFrameAt(windows, 4_000).incomingSourceTimeMs, 150);
});

test('preview distinguishes exact composition, cover effects, and approximated masks', () => {
  const makeWindow = (type) => buildVideoTransitionPreviewWindows(
    buildClipTimeline([
      clip(`out-${type}`, 'out-source', { transitionAfter: { type, durationMs: 600 } }),
      clip(`in-${type}`, 'in-source'),
    ]),
    [source('out-source'), source('in-source')],
  )[0];

  assert.deepEqual([makeWindow('crossfade').mode, makeWindow('crossfade').fidelity], ['composite', 'exact']);
  assert.deepEqual([makeWindow('wipe-left').mode, makeWindow('wipe-left').fidelity], ['composite', 'exact']);
  assert.deepEqual([makeWindow('dip-black').mode, makeWindow('dip-black').fidelity], ['cover', 'exact']);
  assert.deepEqual([makeWindow('iris-circle').mode, makeWindow('iris-circle').fidelity], ['composite', 'approximate']);
  assert.match(makeWindow('iris-circle').approximationLabel, /EXPORT USES THE FULL EFFECT/);
});

test('missing and insufficient transition media fail visibly', () => {
  const missing = buildVideoTransitionPreviewWindows(
    buildClipTimeline([
      clip('out', 'missing', { transitionAfter: { type: 'crossfade', durationMs: 600 } }),
      clip('in', 'in-source'),
    ]),
    [source('in-source')],
  )[0];
  assert.match(missing.unavailableReason, /lost its source video/i);
  assert.equal(missing.outgoing, undefined);

  const entries = buildClipTimeline([
    clip('short-out', 'short-out-source', {
      sourceStartMs: 3_900,
      sourceEndMs: 4_000,
      availableSourceEndMs: 4_000,
      transitionAfter: { type: 'crossfade', durationMs: 600 },
    }),
    clip('long-in', 'long-in-source', { sourceStartMs: 0, sourceEndMs: 4_000, availableSourceEndMs: 4_000 }),
  ]);
  const inconsistentTimeline = [
    { ...entries[0], startMs: 0, endMs: 4_000 },
    { ...entries[1], gapStartMs: 4_000, startMs: 4_000, endMs: 8_000, afterGapEndMs: 8_000 },
  ];
  const insufficient = buildVideoTransitionPreviewWindows(
    inconsistentTimeline,
    [source('short-out-source', 4_000), source('long-in-source', 4_000)],
  )[0];
  assert.match(insufficient.unavailableReason, /enough selected video/i);
  assert.equal(insufficient.outgoing, undefined);
});

test('auxiliary decoders preload near a valid transition only', () => {
  const windows = buildVideoTransitionPreviewWindows(
    buildClipTimeline([
      clip('out', 'out-source', { transitionAfter: { type: 'crossfade', durationMs: 600 } }),
      clip('in', 'in-source'),
    ]),
    [source('out-source'), source('in-source')],
  );

  const preloadStartMs = windows[0].startMs - VIDEO_TRANSITION_PRELOAD_LEAD_MS;
  assert.equal(videoTransitionPreloadWindow(windows, preloadStartMs - 1), undefined);
  assert.equal(videoTransitionPreloadWindow(windows, preloadStartMs)?.key, windows[0].key);
  assert.equal(videoTransitionPreloadWindow(windows, 4_300), undefined);
});
