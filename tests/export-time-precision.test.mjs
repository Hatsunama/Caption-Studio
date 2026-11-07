import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTimelineRenderPlan, toNativeRenderPlan } from '../src/lib/export-render-plan.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { projectRenderDuration, projectTimelineDuration } from '../src/lib/project-timeline.ts';
import { buildClipTimeline, totalClipDuration } from '../src/lib/video-timeline.ts';
import { createEnglishChineseCaptionTrack } from '../src/lib/caption-tracks.ts';

const RECORDED_END_MS = 6385.416507720947;

function fixture(specs = [{ sourceEndMs: RECORDED_END_MS }]) {
  const project = createCaptionProject({ id: 'precision', name: 'Precision', sources: specs.map((_, i) => ({
    id: `source-${i}`, uri: `file:///source-${i}.mp4`, storageMode: 'copied', displayName: 'Source',
    durationMs: 20_000, width: 1920, height: 1080, rotation: 0, frameRate: 24,
  })) });
  project.clips = project.clips.map((clip, i) => ({ ...clip, ...specs[i] }));
  return project;
}

function serializedPlan(project) {
  // Exercise the production builder AND bridge sanitizer, then the JSON wire values.
  return JSON.parse(JSON.stringify(toNativeRenderPlan(buildTimelineRenderPlan(project))));
}

// Explicit model of Kotlin Number.toLong for the finite, nonnegative ms used here.
// This does not execute Kotlin, Media3, or verify encoded pixels.
const nativeMs = (value) => Math.trunc(value);

// Only the temporal requirements relevant to these regressions, copied from
// TimelineRenderPlan.kt's parse/require checks. This is not a native execution.
function assertNativeConsumerBounds(wire) {
  const duration = nativeMs(wire.durationMs);
  assert.ok(duration > 0, 'native duration must be positive');
  for (const caption of wire.captions) {
    assert.ok(nativeMs(caption.startMs) >= 0 && nativeMs(caption.endMs) > nativeMs(caption.startMs)
      && nativeMs(caption.endMs) <= duration, `caption ${caption.id}: invalid native timeline bounds`);
  }
  for (const layer of wire.layers.filter(layer => layer.kind === 'video')) {
    assert.ok(nativeMs(layer.startMs) >= 0 && nativeMs(layer.endMs) > nativeMs(layer.startMs)
      && nativeMs(layer.endMs) <= duration, `PIP ${layer.id}: invalid native timeline bounds`);
  }
  for (const clip of wire.audioClips) {
    assert.ok(nativeMs(clip.startMs) >= 0 && nativeMs(clip.startMs) < duration,
      `audio ${clip.id}: starts outside native duration`);
    assert.ok(nativeMs(clip.sourceEndMs) > nativeMs(clip.sourceStartMs), `audio ${clip.id}: invalid source bounds`);
    assert.ok((nativeMs(clip.sourceEndMs) - nativeMs(clip.sourceStartMs)) / clip.playbackRate
      <= duration - nativeMs(clip.startMs) + 1, `audio ${clip.id}: exceeds native duration`);
  }
}

for (const kind of ['caption', 'video', 'audio', 'text', 'image']) {
  test(`${kind} tail at native export end is omitted; neighboring content survives builder and bridge`, () => {
    const project = fixture();
    for (const [id, startMs] of [['neighbor', 6384], ['tail', 6385], ['fractional-tail', 6385.1]]) {
      if (kind === 'caption') {
        project.captions.push({ id, text: id, startMs, endMs: 9000, wordIds: [id] });
        project.transcription.words.push({ id, text: id, startMs, endMs: 9000 });
      } else if (kind === 'audio') {
        project.audioClips.push({ id, sourceId: 'audio', startMs, sourceStartMs: 0,
          sourceEndMs: 10_000, playbackRate: 4, volume: 1, muted: false, fadeInMs: 0, fadeOutMs: 0 });
      } else {
        project.layers.push({ id, kind, visible: true, startMs, endMs: 9000, text: id,
          style: project.projectStyle, uri: `file:///${id}.${kind === 'video' ? 'mp4' : 'png'}`,
          sourceStartMs: 0, sourceDurationMs: 20_000, playbackRate: 4, includeAudio: true,
          timingMode: 'timeline', position: { x: 0.5, y: 0.5 }, box: { width: 0.3, height: 0.3 },
          rotation: 0, scale: 1, scaleX: 1, scaleY: 1, opacity: 1 });
      }
    }
    if (kind === 'audio') project.audioSources = [{ id: 'audio', uri: 'file:///audio.m4a', durationMs: 20_000 }];
    const before = structuredClone(project);
    try {
      const wire = serializedPlan(project);
      assertNativeConsumerBounds(wire);
      const consumers = kind === 'caption' ? wire.captions : kind === 'audio' ? wire.audioClips
        : wire.layers.filter(layer => layer.kind === kind);
      assert.deepEqual(consumers.map(item => item.id), ['neighbor']);
      if (kind === 'audio') assert.equal(consumers[0].sourceEndMs, 4);
      else assert.deepEqual([consumers[0].startMs, consumers[0].endMs], [6384, 6385]);
      if (kind === 'caption') assert.deepEqual(consumers[0].words.map(word => [word.startMs, word.endMs]), [[6384, 6385]]);
      if (kind === 'video') {
        assert.deepEqual(wire.audioClips.map(clip => [clip.id, clip.startMs, clip.sourceEndMs]),
          [['overlay-audio:neighbor', 6384, 4]]);
      }
    } finally {
      assert.deepEqual(project, before, 'success or failure must not edit persisted content');
    }
  });
}

test('translated captions and words use the same integer boundary as primary captions', () => {
  const base = fixture();
  base.captions = [
    { id: 'neighbor', text: 'Neighbor', startMs: 6384, endMs: 9000, wordIds: ['neighbor', 'tail'] },
    { id: 'tail', text: 'Tail', startMs: 6385, endMs: 9000, wordIds: [] },
  ];
  base.transcription.words = [
    { id: 'neighbor', text: 'Neighbor', startMs: 6384, endMs: 9000 },
    { id: 'tail', text: 'Tail', startMs: 6385, endMs: 9000 },
  ];
  const project = createEnglishChineseCaptionTrack(base, { neighbor: '邻居', tail: '尾部' });
  const before = structuredClone(project);
  try {
    const wire = serializedPlan(project);
    assertNativeConsumerBounds(wire);
    assert.deepEqual(wire.captions.map(caption => [caption.text, caption.startMs, caption.endMs]),
      [['Neighbor', 6384, 6385], ['邻居', 6384, 6385]]);
    assert.deepEqual(wire.captions[0].words.map(word => word.text), ['Neighbor']);
  } finally {
    assert.deepEqual(project, before);
  }
});

for (const opacity of [0, 1]) {
  test(`source-anchored PIP audio clips to native end (opacity ${opacity}) without losing valid fractional starts`, () => {
    const project = fixture();
    for (const [id, startMs] of [['neighbor', 6384.25], ['tail', 6385]]) {
      project.layers.push({ id, kind: 'video', visible: true, startMs, endMs: 9000,
        uri: 'file:///pip.mp4', sourceStartMs: 0, sourceStartAtAnchorMs: 0, sourceDurationMs: 20_000,
        playbackRate: 4, includeAudio: true, timingMode: 'source', opacity,
        sourceAnchors: [{ clipId: project.clips[0].id, sourceStartMs: startMs, sourceEndMs: RECORDED_END_MS }],
        position: { x: 0.5, y: 0.5 }, box: { width: 0.3, height: 0.3 }, rotation: 0, scale: 1 });
    }
    const before = structuredClone(project);
    try {
      const wire = serializedPlan(project);
      assertNativeConsumerBounds(wire);
      assert.deepEqual(wire.layers.filter(layer => layer.kind === 'video').map(layer => [layer.id, layer.startMs, layer.endMs]),
        opacity ? [['neighbor', 6384.25, 6385]] : []);
      assert.deepEqual(wire.audioClips.map(clip => [clip.id, clip.startMs, clip.sourceStartMs, clip.sourceEndMs]),
        [['overlay-audio:neighbor', 6384.25, 0, 3]]);
    } finally {
      assert.deepEqual(project, before);
    }
  });
}

test('DIAG349 exact cut has no phantom tail after bridge serialization and Kotlin ms projection', () => {
  const project = fixture();
  const wire = serializedPlan(project);
  assert.equal(wire.clips[0].timelineEndMs, RECORDED_END_MS);
  assert.equal(nativeMs(wire.clips[0].timelineEndMs), 6385);
  assert.equal(nativeMs(wire.durationMs), nativeMs(wire.clips[0].timelineEndMs),
    'native sequence must not add a 1ms gap after a zero-gap final clip');
  assert.equal(wire.durationMs, 6385);
  assert.equal(projectRenderDuration(project), 6386);
  assert.equal(projectTimelineDuration(project), 6386);
});

test('fractional clips and playback rates share cumulative native boundaries without new gaps', () => {
  for (const specs of [
    [{ sourceStartMs: 123.25, sourceEndMs: 3456.875, playbackRate: 1.5 }],
    [{ sourceEndMs: 1000.125, playbackRate: 0.5 }, { sourceStartMs: 50.75, sourceEndMs: 1730.875, playbackRate: 1.25 },
      { sourceEndMs: RECORDED_END_MS, playbackRate: 3 }],
    [{ sourceEndMs: 1500.75, playbackRate: 4 }, { sourceEndMs: 900.125, playbackRate: 0.25 }],
  ]) {
    const project = fixture(specs);
    const wire = serializedPlan(project);
    assert.equal(wire.durationMs, Math.trunc(totalClipDuration(project.clips)));
    for (let i = 1; i < wire.clips.length; i++) {
      assert.equal(nativeMs(wire.clips[i].timelineStartMs), nativeMs(wire.clips[i - 1].timelineEndMs));
    }
    assert.equal(nativeMs(wire.durationMs), nativeMs(wire.clips.at(-1).timelineEndMs));
    wire.clips.forEach((clip, i) => {
      for (const key of ['sourceStartMs', 'sourceEndMs', 'availableSourceStartMs', 'availableSourceEndMs', 'playbackRate']) {
        assert.equal(clip[key], project.clips[i][key], key);
      }
    });
  }
});

test('leading, interior, and legacy trailing gaps retain their native projection', () => {
  for (const tail of [1, 27.75, 1000]) {
    const project = fixture([
      { sourceEndMs: 1000.375, gapBeforeMs: 100.25, gapAfterMs: 200.5 },
      { sourceEndMs: RECORDED_END_MS, gapBeforeMs: 300.75, gapAfterMs: tail },
    ]);
    const entries = buildClipTimeline(project.clips);
    const wire = serializedPlan(project);
    assert.equal(wire.durationMs, Math.trunc(totalClipDuration(project.clips)));
    wire.clips.forEach((clip, i) => {
      assert.equal(clip.timelineStartMs, entries[i].startMs);
      assert.equal(clip.timelineEndMs, entries[i].endMs);
    });
    assert.equal(nativeMs(wire.clips[0].timelineStartMs), 100);
    assert.equal(nativeMs(wire.clips[1].timelineStartMs) - nativeMs(wire.clips[0].timelineEndMs), 501);
    assert.equal(nativeMs(wire.durationMs) - nativeMs(wire.clips.at(-1).timelineEndMs),
      nativeMs(entries.at(-1).afterGapEndMs) - nativeMs(entries.at(-1).endMs));
    assert.ok(nativeMs(wire.durationMs) > nativeMs(wire.clips.at(-1).timelineEndMs));
  }
});

test('captions, overlays and audio stay bounded to the same video endpoint without editing project or clock', (t) => {
  const project = fixture();
  project.captions = [{ id: 'caption', text: 'Tail', startMs: 100, endMs: 9000, wordIds: ['word'] }];
  project.transcription.words = [{ id: 'word', text: 'Tail', startMs: 100, endMs: 9000 }];
  project.layers.push({ id: 'title', kind: 'text', visible: true, text: 'Title', startMs: 0,
    endMs: 9000, style: project.projectStyle }, {
    id: 'pip', kind: 'video', visible: true, uri: 'file:///pip.mp4', startMs: 0, endMs: 9000,
    sourceStartMs: 10.25, sourceDurationMs: 20_000, playbackRate: 1.5, includeAudio: true,
    position: { x: 0.5, y: 0.5 }, box: { width: 0.3, height: 0.3 }, rotation: 0,
    scale: 1, scaleX: 1, scaleY: 1, opacity: 0.75, timingMode: 'timeline',
  });
  project.audioSources = [{ id: 'audio', uri: 'file:///audio.m4a', durationMs: 20_000 }];
  project.audioClips = [{ id: 'music', sourceId: 'audio', startMs: 100.25, sourceStartMs: 50.5,
    sourceEndMs: 1000.75, playbackRate: 1.25, volume: 0.7, muted: false, fadeInMs: 50, fadeOutMs: 100 }];
  const before = structuredClone(project);
  const clock = Date.now;
  t.mock.method(Date, 'now', () => { throw new Error('Rendering must not read or update the clock'); });
  const wire = serializedPlan(project);
  assert.equal(wire.captions[0].endMs, 6385);
  assert.equal(wire.captions[0].words[0].endMs, 6385);
  assert.equal(nativeMs(wire.captions[0].words[0].endMs), nativeMs(wire.durationMs));
  for (const layer of wire.layers.filter(layer => layer.kind !== 'captions')) {
    assert.equal(layer.endMs, 6385);
  }
  assert.deepEqual(wire.audioClips.find(clip => clip.id === 'music'), {
    id: 'music', uri: 'file:///audio.m4a', startMs: 100.25, sourceStartMs: 50.5,
    sourceEndMs: 1000.75, playbackRate: 1.25, volume: 0.7, muted: false, fadeInMs: 50, fadeOutMs: 100,
  });
  const overlay = wire.layers.find(layer => layer.id === 'pip');
  const sound = wire.audioClips.find(clip => clip.id === 'overlay-audio:pip');
  assert.equal(sound.sourceEndMs, overlay.sourceEndMs);
  assert.equal(sound.sourceStartMs, overlay.sourceStartMs);
  assert.equal(sound.playbackRate, overlay.playbackRate);
  assert.deepEqual(project, before);
  t.mock.restoreAll();
  assert.equal(Date.now, clock);
});

test('integer render payload matches an independent literal baseline', () => {
  const project = fixture([{ sourceEndMs: 6000, gapBeforeMs: 100, gapAfterMs: 200 }]);
  const wire = serializedPlan(project);
  assert.deepEqual(wire, {
    version: 1, durationMs: 6300, width: 1920, height: 1080, frameRate: 24,
    backgroundColor: '#000000', burnCaptions: true,
    videoTransform: { fit: 'fit', position: { x: 0.5, y: 0.5 }, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 },
    clips: [{ id: 'clip-source-0-0', uri: 'file:///source-0.mp4', timelineStartMs: 100, timelineEndMs: 6100,
      availableSourceStartMs: 0, availableSourceEndMs: 20_000, sourceStartMs: 0, sourceEndMs: 6000,
      playbackRate: 1, volume: 1, muted: false, fadeInMs: 0, fadeOutMs: 0,
      transform: { fit: 'fit', position: { x: 0.5, y: 0.5 }, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 },
      transition: { type: 'none', durationMs: 0 } }],
    captions: [], layers: [{ id: 'captions', kind: 'captions', visible: true }], audioClips: [],
  });
  assert.equal(wire.durationMs, projectRenderDuration(project));
});

test('canvas export retains its ceiled effective-content policy', () => {
  const project = fixture();
  project.clips = [];
  project.layers.push({ id: 'text', kind: 'text', visible: true, text: 'Canvas', startMs: 0,
    endMs: RECORDED_END_MS, style: project.projectStyle });
  assert.equal(serializedPlan(project).durationMs, 6386);
  assert.equal(projectRenderDuration(project), 6386);
  project.layers.at(-1).visible = false;
  assert.throws(() => serializedPlan(project), /Add timed content/);
});

test('sub-ms footage fails early without a fake millisecond; invalid source trims fail closed without mutation', () => {
  for (const sourceEndMs of [0.25, 0, -1, NaN, Infinity, 20_001]) {
    const project = fixture([{ sourceEndMs }]);
    const before = structuredClone(project);
    try {
      assert.throws(() => serializedPlan(project), /Add timed content|trim outside/);
    } finally {
      assert.deepEqual(project, before);
    }
  }
});

test('invalid in-export audio source still fails without mutation', () => {
  for (const sourceId of ['missing', 'audio']) {
    const project = fixture();
    project.audioSources = [{ id: 'audio', uri: 'file:///audio.m4a', durationMs: 100 }];
    project.audioClips = [{ id: 'invalid', sourceId, startMs: 6384, sourceStartMs: 200,
      sourceEndMs: 300, playbackRate: 4, volume: 1, muted: false, fadeInMs: 0, fadeOutMs: 0 }];
    const before = structuredClone(project);
    assert.throws(() => serializedPlan(project), /unavailable|trim outside/);
    assert.deepEqual(project, before);
  }
});
