import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { setVideoClipGap, setVideoTransition, trimVideoClip } from '../src/lib/project-editor.ts';
import { buildClipTimeline, videoTransitionOverlay } from '../src/lib/video-timeline.ts';
import {
  canApplyVideoTransition,
  hydrateVideoTransition,
  hydrateVideoTransitionBoundaries,
  videoTransitionPreviewKind,
  VIDEO_TRANSITION_PRESETS,
} from '../src/lib/video-transitions.ts';

const nativeTransitionSource = readFileSync(new URL(
  '../modules/caption-media/android/src/main/java/app/captionstudio/media/TimelineTransitionSpec.kt',
  import.meta.url,
), 'utf8');

test('the commercial catalog has at least 28 effects and every effect is routed to preview and native export', () => {
  const ids = VIDEO_TRANSITION_PRESETS.map((preset) => preset.id);
  assert.ok(ids.length - 1 >= 28, `expected at least 28 effects, found ${ids.length - 1}`);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.notEqual(videoTransitionPreviewKind(id), undefined);
    if (id !== 'none') assert.notEqual(videoTransitionPreviewKind(id), 'none');
  }

  const supportedBlock = /supportedTypes = setOf\(([\s\S]*?)\n  \)/.exec(nativeTransitionSource)?.[1];
  assert.ok(supportedBlock, 'native transition registry was not found');
  const nativeIds = [...supportedBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(new Set(nativeIds), new Set(ids));
});

test('every advertised transition survives persisted JSON hydration', () => {
  for (const preset of VIDEO_TRANSITION_PRESETS) {
    const persisted = JSON.parse(JSON.stringify({ type: preset.id, durationMs: preset.durationMs }));
    assert.deepEqual(hydrateVideoTransition(persisted), {
      type: preset.id,
      durationMs: preset.durationMs,
    });
    const clips = hydrateVideoTransitionBoundaries([
      clip({ id: 'first', transitionAfter: persisted }),
      clip({ id: 'second' }),
    ]);
    assert.deepEqual(clips[0].transitionAfter, {
      type: preset.id,
      durationMs: preset.durationMs,
    });
  }
});

test('legacy transition records retain their established defaults while corrupt values are rejected', () => {
  assert.deepEqual(hydrateVideoTransition(undefined), { type: 'none', durationMs: 0 });
  assert.deepEqual(hydrateVideoTransition({}), { type: 'none', durationMs: 0 });
  assert.deepEqual(hydrateVideoTransition({ type: 'dip-black' }), { type: 'dip-black', durationMs: 500 });
  assert.deepEqual(hydrateVideoTransition({ type: 'none', durationMs: 500 }), { type: 'none', durationMs: 0 });
  assert.throws(() => hydrateVideoTransition([]), /transition is invalid/);
  assert.throws(() => hydrateVideoTransition({ type: 'not-a-transition', durationMs: 500 }), /transition is invalid/);
  assert.throws(() => hydrateVideoTransition({ type: 'glitch', durationMs: Number.NaN }), /duration is invalid/);
  assert.throws(() => hydrateVideoTransition({ type: 'glitch', durationMs: 2_001 }), /duration is invalid/);
});

test('persisted transition hydration removes effects across gaps and after the final clip', () => {
  const persisted = JSON.parse(JSON.stringify([
    clip({ id: 'first', transitionAfter: { type: 'glitch', durationMs: 420 } }),
    clip({ id: 'second', gapBeforeMs: 300, transitionAfter: { type: 'wipe-left', durationMs: 600 } }),
  ]));
  const hydrated = hydrateVideoTransitionBoundaries(persisted);
  assert.deepEqual(hydrated.map((item) => item.transitionAfter), [
    { type: 'none', durationMs: 0 },
    { type: 'none', durationMs: 0 },
  ]);
});

test('a gap edit atomically clears its boundary transition and blocks reapplication', () => {
  const project = projectFixture();
  const transitioned = setVideoTransition(project, 'first', 'wipe-right', 600);
  assert.equal(transitioned.clips[0].transitionAfter.type, 'wipe-right');
  assert.equal(canApplyVideoTransition(transitioned.clips, 0), true);
  assert.equal(setVideoTransition(transitioned, 'first', 'wipe-right', Number.NaN), transitioned);

  const gapped = setVideoClipGap(transitioned, 'second', 500);
  assert.ok(gapped);
  assert.deepEqual(gapped.project.clips[0].transitionAfter, { type: 'none', durationMs: 0 });
  assert.equal(canApplyVideoTransition(gapped.project.clips, 0), false);
  assert.equal(setVideoTransition(gapped.project, 'first', 'glitch', 420), gapped.project);
  assert.equal(videoTransitionOverlay(buildClipTimeline(gapped.project.clips), 4_500), undefined);

  const packed = setVideoClipGap(gapped.project, 'second', 0);
  assert.ok(packed);
  const restored = setVideoTransition(packed.project, 'first', 'glitch', 420);
  assert.equal(restored.clips[0].transitionAfter.type, 'glitch');
  assert.equal(videoTransitionOverlay(buildClipTimeline(restored.clips), 4_000)?.type, 'glitch');
});

test('trimming either side of a shared cut clears the transition crossed by new dead space', () => {
  const project = setVideoTransition(projectFixture(), 'first', 'fade-dark', 800);
  const tailTrimmed = trimVideoClip(project, 'first', 'end', 3_500);
  assert.ok(tailTrimmed);
  assert.equal(tailTrimmed.project.clips[0].gapAfterMs, 500);
  assert.deepEqual(tailTrimmed.project.clips[0].transitionAfter, { type: 'none', durationMs: 0 });

  const restored = setVideoTransition(projectFixture(), 'first', 'fade-dark', 800);
  const headTrimmed = trimVideoClip(restored, 'second', 'start', 500);
  assert.ok(headTrimmed);
  assert.equal(headTrimmed.project.clips[1].gapBeforeMs, 500);
  assert.deepEqual(headTrimmed.project.clips[0].transitionAfter, { type: 'none', durationMs: 0 });
});

test('preview refuses a stale cross-gap transition even before persistence normalization', () => {
  const clips = [
    clip({ id: 'first', transitionAfter: { type: 'flash', durationMs: 350 } }),
    clip({ id: 'second', gapBeforeMs: 500 }),
  ];
  assert.equal(videoTransitionOverlay(buildClipTimeline(clips), 4_500), undefined);
});

test('preview uses the same centered duration window and linear phase as native export', () => {
  const clips = [
    clip({ id: 'first', transitionAfter: { type: 'crossfade', durationMs: 600 } }),
    clip({ id: 'second' }),
  ];
  const entries = buildClipTimeline(clips);
  assert.equal(videoTransitionOverlay(entries, 3_699), undefined);
  assert.equal(videoTransitionOverlay(entries, 3_700)?.phase, 0);
  assert.equal(videoTransitionOverlay(entries, 4_000)?.phase, 0.5);
  assert.ok(Math.abs(videoTransitionOverlay(entries, 4_299).phase - 599 / 600) < 0.000_001);
  assert.equal(videoTransitionOverlay(entries, 4_300), undefined);
});

function clip(overrides = {}) {
  return {
    id: overrides.id ?? 'clip',
    sourceId: overrides.sourceId ?? 'source',
    availableSourceStartMs: 0,
    availableSourceEndMs: 4_000,
    sourceStartMs: 0,
    sourceEndMs: 4_000,
    gapBeforeMs: 0,
    gapAfterMs: 0,
    playbackRate: 1,
    volume: 1,
    muted: false,
    fadeInMs: 0,
    fadeOutMs: 0,
    transitionAfter: { type: 'none', durationMs: 0 },
    ...overrides,
  };
}

function projectFixture() {
  return {
    schemaVersion: 2,
    id: 'project',
    name: 'Transition test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lifecycle: { status: 'draft' },
    sources: [{
      id: 'source',
      uri: 'content://video',
      storageMode: 'linked',
      displayName: 'Video',
      durationMs: 4_000,
      width: 1080,
      height: 1920,
      rotation: 0,
    }],
    transcription: { language: 'en', modelId: 'fast', words: [], sourceResults: {} },
    captions: [],
    projectStyle: {},
    layers: [{ id: 'captions', kind: 'captions', name: 'Captions', visible: true }],
    clips: [clip({ id: 'first' }), clip({ id: 'second' })],
    audioSources: [],
    audioClips: [],
    canvas: { preset: 'source', aspectWidth: 9, aspectHeight: 16, backgroundColor: '#000000' },
    videoTransform: { fit: 'fit', position: { x: 0.5, y: 0.5 }, scale: 1, rotation: 0 },
    backgroundReplacement: {
      enabled: false,
      mask: { qualityPreset: 'stable', threshold: 0.5, softness: 0.1, temporalStability: 0.8, edgeFeather: 0.1 },
      personTransform: { position: { x: 0.5, y: 0.5 }, scale: 1, rotation: 0 },
      keyframes: [],
    },
    export: { resolution: '1080p', format: 'mp4', burnCaptions: true },
  };
}
