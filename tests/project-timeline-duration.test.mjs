import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { deleteVideoClip, reorderVideoClip, splitVideoClip, trimVideoClip } from '../src/lib/project-editor.ts';
import { projectRenderDuration, projectTimelineDuration, projectTimelineSegmentAt } from '../src/lib/project-timeline.ts';
import { buildClipTimeline, sourceTimeAt, setClipPlaybackRate, rippleDelete, totalClipDuration } from '../src/lib/video-timeline.ts';
import { buildTimelineRenderPlan } from '../src/lib/export-render-plan.ts';
import { buildTimelineAudioRenderPlan } from '../src/lib/timeline-audio-render-plan.ts';
import { decodeVersionTwoProject, serializeProjectSnapshot } from '../src/lib/project-schema.ts';

function fixture() {
  const project = createCaptionProject({ id: 'audio-tail', name: 'Audio tail', sources: ['first', 'second'].map(id => ({
    id, uri: `file:///${id}.mp4`, storageMode: 'copied', displayName: id,
    durationMs: 10_000, width: 1920, height: 1080, rotation: 0, frameRate: 30,
  })) });
  project.audioSources = [{ id: 'music', uri: 'file:///music.m4a', storageMode: 'copied', displayName: 'Music', durationMs: 10_000, origin: 'audio-file' }];
  project.audioClips = [{ id: 'tail', sourceId: 'music', anchor: 'timeline', startMs: 15_000,
    sourceStartMs: 200, sourceEndMs: 5_200, volume: 0.7, muted: false, fadeInMs: 100, fadeOutMs: 300 }];
  return project;
}

for (const playbackRate of [0.5, 1, 1.5, 2]) {
  test(`footage rounding padding retains the final clip at rate ${playbackRate}`, () => {
    const project = fixture();
    project.clips = [{ ...project.clips[0], sourceStartMs: 0, sourceEndMs: 6385.416666666667, playbackRate }];
    const before = structuredClone(project);
    const entries = buildClipTimeline(project.clips), last = entries.at(-1);
    const duration = Math.ceil(last.endMs);
    assert.equal(projectTimelineDuration(project), duration);
    assert.equal(projectRenderDuration(project), duration);
    for (const time of [last.endMs - 0.001, last.endMs, (last.endMs + duration) / 2, duration]) {
      const segment = projectTimelineSegmentAt(project, time, entries);
      assert.equal(segment?.kind, 'clip', `time ${time}`);
      assert.equal(segment.entry, last);
      assert.equal(projectTimelineSegmentAt(project, time)?.entry.clip, project.clips[0]);
      if (time >= last.endMs) {
        assert.equal(sourceTimeAt(segment.entry, time), sourceTimeAt(last, last.endMs));
        assert.ok(sourceTimeAt(segment.entry, time) <= last.clip.sourceEndMs);
      }
    }
    assert.equal(projectTimelineSegmentAt(project, duration + 0.001), undefined);
    assert.deepEqual(project, before, 'lookup must not quantize or mutate saved footage');
  });
}

test('rounding repair preserves authored leading, interior and arbitrarily small trailing gaps', () => {
  for (const gapAfterMs of [0.0001, 0.25, 20]) {
    const project = fixture();
    project.clips = [
      { ...project.clips[0], sourceEndMs: 1000, gapBeforeMs: 5, gapAfterMs: 7 },
      { ...project.clips[1], sourceEndMs: 6385.416666666667, gapBeforeMs: 3, gapAfterMs },
    ];
    const entries = buildClipTimeline(project.clips), last = entries.at(-1);
    for (const time of [0, 4.999, entries[0].endMs, last.startMs - 0.001, last.endMs,
      last.endMs + gapAfterMs / 2, last.afterGapEndMs, projectTimelineDuration(project)]) {
      assert.equal(projectTimelineSegmentAt(project, time, entries)?.kind, 'gap', `gap ${gapAfterMs}, time ${time}`);
    }
    assert.equal(projectTimelineSegmentAt(project, last.startMs, entries)?.kind, 'clip');
    assert.equal(projectTimelineSegmentAt(project, projectTimelineDuration(project) + 1, entries), undefined);
  }
});

test('the rounding exception never fills a genuinely missing suffix from supplied entries', () => {
  const project = fixture();
  const available = buildClipTimeline([project.clips[0]]);
  assert.deepEqual(projectTimelineSegmentAt(project, 15000, available),
    { kind: 'gap', startMs: 10000, endMs: 20000 });
  const canvas = { clips: [], captions: [{ id: 'cue', startMs: 0, endMs: 6385.416666666667 }] };
  const retired = buildClipTimeline([{ ...project.clips[0], sourceEndMs: 6385.416666666667 }]);
  assert.deepEqual(projectTimelineSegmentAt(canvas, 6386, retired),
    { kind: 'gap', startMs: retired[0].endMs, endMs: 6386 });
});

test('deleting the second video preserves stored audio but bounds both render plans to footage', () => {
  const before = fixture();
  const { project } = deleteVideoClip(before, before.clips[1].id);
  assert.equal(totalClipDuration(project.clips), 10_000);
  assert.deepEqual(project.audioClips, before.audioClips);
  assert.equal(projectTimelineDuration(project), 10_000);
  const videoPlan = buildTimelineRenderPlan(project);
  const audioPlan = buildTimelineAudioRenderPlan(project);
  assert.equal(videoPlan.durationMs, 10_000);
  assert.equal(audioPlan.durationMs, videoPlan.durationMs);
  assert.deepEqual(videoPlan.audioClips, []);
  assert.deepEqual(audioPlan.audioClips, []);
  assert.equal(projectTimelineSegmentAt(project, 15_000), undefined);
  assert.equal(projectTimelineSegmentAt(project, 20_001), undefined);
});

test('deleting the only video leaves persistent editable audio and a canvas export', () => {
  const before = fixture();
  before.clips = [before.clips[0]];
  const { project } = deleteVideoClip(before, before.clips[0].id);
  assert.deepEqual(project.clips, []);
  assert.deepEqual(project.audioClips, [{ ...before.audioClips[0], startMs: 5_000 }]);
  assert.equal(projectTimelineDuration(project), 10_000);
  const restored = decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(project)));
  assert.deepEqual(restored.audioClips, project.audioClips);
  const plan = buildTimelineRenderPlan(restored);
  assert.deepEqual(plan.clips, []);
  assert.equal(plan.durationMs, 10_000);
  assert.equal(plan.audioClips[0].sourceEndMs - plan.audioClips[0].sourceStartMs, 5_000);
  assert.equal(projectTimelineSegmentAt(restored, 0).kind, 'gap');
  assert.equal(projectTimelineSegmentAt(restored, 10_000).kind, 'gap');
});

test('audio inside the deleted final video survives without source edits', () => {
  const before = fixture();
  before.clips = [before.clips[0]];
  before.audioClips[0].startMs = 5_000;
  const { project } = deleteVideoClip(before, before.clips[0].id);
  assert.deepEqual(project.audioClips, before.audioClips);
  assert.equal(buildTimelineRenderPlan(project).durationMs, 10_000);
});

test('split, trim, reorder, speed and legacy ripple never shorten or remove audio source ranges', () => {
  const before = fixture();
  const id = before.clips[1].id;
  const projects = [
    splitVideoClip(before, id, 17_000, 'left', 'right').project,
    trimVideoClip(before, id, 'end', 4_000).project,
    reorderVideoClip(before, id, 0).project,
    setClipPlaybackRate(before, id, 4),
    rippleDelete(before, 10_000, 20_000, id),
  ];
  for (const project of projects) {
    assert.deepEqual(project.audioClips, before.audioClips);
    assert.equal(buildTimelineRenderPlan(project).durationMs, projectTimelineDuration(project));
  }
});

test('muted audio and hidden timed layers remain reachable on a silent canvas', () => {
  const project = fixture();
  project.clips = [];
  project.audioClips[0].muted = true;
  assert.equal(projectTimelineDuration(project), 20_000);
  assert.throws(() => buildTimelineRenderPlan(project), /Add timed content/);
  project.audioClips = [];
  project.layers.push({ id: 'end-card', kind: 'text', name: 'End card', text: 'End', visible: false,
    startMs: 15_000, endMs: 25_000, style: project.projectStyle });
  assert.equal(projectTimelineDuration(project), 25_000);
  assert.equal(project.layers.at(-1).endMs, 25_000);
  assert.equal(buildTimelineAudioRenderPlan(project).durationMs, 0);
  project.layers.at(-1).visible = true;
  const plan = buildTimelineRenderPlan(project);
  assert.equal(plan.durationMs, 25_000);
  assert.deepEqual(plan.clips, []);
  assert.deepEqual(plan.audioClips, []);
  assert.equal(plan.layers.at(-1).endMs, 25_000);
  project.layers.at(-1).timelineVisible = false;
  assert.equal(projectTimelineDuration(project), 25_000);
  assert.throws(() => buildTimelineRenderPlan(project), /Add timed content/);
});

test('preview and native composition consume the project extent and preserve canvas without footage', () => {
  const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const controller = read('src/hooks/use-timeline-video-controller.ts');
  assert.match(controller, /projectTimelineDuration\(projectRef.current\)/);
  assert.match(controller, /projectTimelineSegmentAt\(projectRef.current, target.timelineMs, entriesRef.current\)/);
  assert.doesNotMatch(controller, /entriesRef.current.at\(-1\)\?\.afterGapEndMs/);
  const native = read('modules/caption-media/android/src/main/java/app/captionstudio/media/TimelineVideoExporter.kt');
  assert.match(native, /setImageDurationMs\(plan.durationMs\)/);
  assert.match(native, /val sourceEndMs = clip.sourceEndMs/);
});
