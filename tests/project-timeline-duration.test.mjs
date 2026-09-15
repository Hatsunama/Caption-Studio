import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { deleteVideoClip, reorderVideoClip, splitVideoClip, trimVideoClip } from '../src/lib/project-editor.ts';
import { projectTimelineDuration, projectTimelineSegmentAt } from '../src/lib/project-timeline.ts';
import { setClipPlaybackRate, rippleDelete, totalClipDuration } from '../src/lib/video-timeline.ts';
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

test('deleting the second ten-second video preserves full audio at 15 seconds across domain and render plans', () => {
  const before = fixture();
  const { project } = deleteVideoClip(before, before.clips[1].id);
  assert.equal(totalClipDuration(project.clips), 10_000);
  assert.deepEqual(project.audioClips, before.audioClips);
  assert.equal(projectTimelineDuration(project), 20_000);
  const videoPlan = buildTimelineRenderPlan(project);
  const audioPlan = buildTimelineAudioRenderPlan(project);
  assert.equal(videoPlan.durationMs, 20_000);
  assert.equal(audioPlan.durationMs, videoPlan.durationMs);
  assert.equal(videoPlan.audioClips[0].sourceEndMs, 5_200);
  assert.deepEqual([audioPlan.audioClips[0].timelineStartMs, audioPlan.audioClips[0].timelineEndMs], [15_000, 20_000]);
  assert.deepEqual(projectTimelineSegmentAt(project, 10_000), { kind: 'gap', startMs: 10_000, endMs: 20_000 });
  assert.equal(projectTimelineSegmentAt(project, 15_000).kind, 'gap');
  assert.equal(projectTimelineSegmentAt(project, 20_000).kind, 'gap');
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

test('muted audio and hidden timed layers retain extent; canvas-only silent export has no media tracks', () => {
  const project = fixture();
  project.clips = [];
  project.audioClips[0].muted = true;
  assert.equal(buildTimelineRenderPlan(project).durationMs, 20_000);
  project.audioClips = [];
  project.layers.push({ id: 'end-card', kind: 'text', name: 'End card', text: 'End', visible: false,
    startMs: 15_000, endMs: 25_000, style: project.projectStyle });
  const plan = buildTimelineRenderPlan(project);
  assert.equal(plan.durationMs, 25_000);
  assert.deepEqual(plan.clips, []);
  assert.deepEqual(plan.audioClips, []);
  assert.equal(plan.layers.at(-1).endMs, 25_000);
  assert.equal(buildTimelineAudioRenderPlan(project).durationMs, 25_000);
  project.layers.at(-1).timelineVisible = false;
  assert.equal(projectTimelineDuration(project), 0);
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
  assert.match(native, /if \(plan.clips.isNotEmpty\(\)\) sequences \+= buildNativeVideoSequence\(plan\)/);
  assert.match(native, /plan.clips.isEmpty\(\) \|\| inputId != VIDEO_SEQUENCE_INDEX/);
  assert.match(native, /val sourceEndMs = clip.sourceEndMs/);
});
