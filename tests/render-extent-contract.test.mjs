import assert from 'node:assert/strict';
import test from 'node:test';

import { addAudioSourceToProject } from '../src/lib/audio-timeline.ts';
import { createEnglishChineseCaptionTrack, setTranslationCueTiming } from '../src/lib/caption-tracks.ts';
import { buildTimelineRenderPlan } from '../src/lib/export-render-plan.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { setCaptionTiming, setLayerTiming } from '../src/lib/project-editor.ts';
import { projectTimelineDuration, projectTimelineSegmentAt } from '../src/lib/project-timeline.ts';
import { buildTimelineAudioRenderPlan } from '../src/lib/timeline-audio-render-plan.ts';

const VIDEO_END_MS = 10_000;

function projectFixture(id) {
  return createCaptionProject({ id, name: id, sources: [{
    id: 'video', uri: 'file:///video.mp4', storageMode: 'copied', displayName: 'video.mp4',
    durationMs: VIDEO_END_MS, width: 1920, height: 1080, rotation: 0, frameRate: 30,
  }] });
}

function caption(startMs, endMs, timelineVisible = true) {
  return { id: 'primary', text: 'Hello', startMs, endMs, wordIds: [],
    textMode: 'manual', timelineVisible };
}

function withTranslation(project, translationEndMs, { trackVisible = true, cueVisible = true } = {}) {
  const translated = createEnglishChineseCaptionTrack(project, { primary: '你好' });
  const track = translated.captionTracks.translations[0];
  track.visible = trackVisible;
  track.cues[0].startMs = Math.max(0, translationEndMs - 1_000);
  track.cues[0].endMs = translationEndMs;
  track.cues[0].timelineVisible = cueVisible;
  return translated;
}

function addAudio(project, startMs, sourceDurationMs, muted = false) {
  project.audioSources.push({ id: 'music', uri: 'file:///music.m4a', storageMode: 'copied',
    displayName: 'Music', durationMs: sourceDurationMs, origin: 'audio-file' });
  project.audioClips.push({ id: 'music-clip', sourceId: 'music', anchor: 'timeline',
    startMs, sourceStartMs: 0, sourceEndMs: sourceDurationMs, volume: 1, muted,
    fadeInMs: 0, fadeOutMs: 0 });
  return project;
}

test('existing caption, translation, visual, and audio tails stay stored but video bounds edit and render extent', () => {
  let project = projectFixture('legacy-tails');
  project.captions = [caption(8_000, 15_000)];
  project = withTranslation(project, 16_000);
  project.layers.push({ id: 'title', kind: 'text', name: 'Title', text: 'Title', visible: true,
    startMs: 7_000, endMs: 17_000, style: project.projectStyle });
  addAudio(project, 8_000, 10_000);
  const stored = structuredClone(project);

  assert.equal(projectTimelineDuration(project), VIDEO_END_MS);
  const render = buildTimelineRenderPlan(project);
  const audio = buildTimelineAudioRenderPlan(project);
  assert.equal(render.durationMs, VIDEO_END_MS);
  assert.equal(audio.durationMs, VIDEO_END_MS);
  assert.ok(render.captions.every((item) => item.endMs <= VIDEO_END_MS));
  assert.ok(render.layers.filter((item) => item.kind === 'text').every((item) => item.endMs <= VIDEO_END_MS));
  assert.ok(audio.audioClips.every((item) => item.timelineEndMs <= VIDEO_END_MS));
  assert.deepEqual(project, stored);
});

test('new caption, translation, visual, and audio timing cannot expand an existing video timeline', () => {
  let project = projectFixture('new-timing');
  project.captions = [caption(8_000, 9_000)];
  project = withTranslation(project, 9_000);
  project.layers.push({ id: 'title', kind: 'text', name: 'Title', text: 'Title', visible: true,
    startMs: 8_000, endMs: 9_000, style: project.projectStyle });

  const retimedCaption = setCaptionTiming(project, 'primary', 'end', 8_000, 15_000);
  const retimedTranslation = setTranslationCueTiming(project,
    project.captionTracks.translations[0].id, 'primary', 'end', 8_000, 15_000);
  const retimedVisual = setLayerTiming(project, 'title', 'end', 8_000, 15_000);
  const audioSource = { id: 'music', uri: 'file:///music.m4a', storageMode: 'copied',
    displayName: 'Music', durationMs: 12_000, origin: 'audio-file' };
  const insertedAudio = addAudioSourceToProject(project, audioSource, 'music-clip', 8_000,
    projectTimelineDuration(project));

  assert.ok(retimedCaption.captions[0].endMs <= VIDEO_END_MS);
  assert.ok(retimedTranslation.captionTracks.translations[0].cues[0].endMs <= VIDEO_END_MS);
  assert.ok(retimedVisual.layers.find((item) => item.id === 'title').endMs <= VIDEO_END_MS);
  assert.ok(insertedAudio);
  assert.ok(insertedAudio.clip.startMs + insertedAudio.clip.sourceEndMs <= VIDEO_END_MS);
});

test('canvas-only output can use visible visual and audible audio extent without hidden or muted tails', () => {
  const project = projectFixture('canvas-content');
  project.clips = [];
  project.layers.push({ id: 'title', kind: 'text', name: 'Title', text: 'Title', visible: true,
    startMs: 0, endMs: 9_000, style: project.projectStyle });
  project.layers.push({ id: 'hidden', kind: 'text', name: 'Hidden', text: 'Hidden', visible: false,
    startMs: 0, endMs: 14_000, style: project.projectStyle });
  addAudio(project, 0, 7_000);

  assert.equal(projectTimelineDuration(project), 14_000);
  assert.equal(buildTimelineRenderPlan(project).durationMs, 9_000);
  assert.equal(buildTimelineAudioRenderPlan(project).durationMs, 9_000);
  assert.equal(project.audioClips[0].sourceEndMs, 7_000);
});

for (const kind of ['text', 'image']) {
  for (const invisibility of ['hidden', 'transparent']) {
    test(`canvas-only ${invisibility} ${kind} tail remains editable but does not extend MP4`, () => {
      const project = projectFixture(`editable-${invisibility}-${kind}`);
      project.clips = [];
      project.layers.push({ id: 'visible-title', kind: 'text', name: 'Visible title',
        text: 'Visible title', visible: true, startMs: 0, endMs: 2_000,
        style: project.projectStyle });
      const tail = kind === 'text'
        ? { id: 'saved-tail', kind, name: 'Saved tail', text: 'Saved tail',
            visible: invisibility !== 'hidden', startMs: 7_000, endMs: 9_000,
            style: { ...project.projectStyle, opacity: invisibility === 'transparent' ? 0 : 1 } }
        : { id: 'saved-tail', kind, name: 'Saved tail', uri: 'file:///tail.png',
            visible: invisibility !== 'hidden', startMs: 7_000, endMs: 9_000,
            position: { x: 0.5, y: 0.5 }, box: { width: 0.2, height: 0.2 },
            rotation: 0, opacity: invisibility === 'transparent' ? 0 : 1 };
      project.layers.push(tail);
      const savedProject = structuredClone(project);

      assert.equal(projectTimelineDuration(project), 9_000);
      assert.deepEqual(projectTimelineSegmentAt(project, 8_000),
        { kind: 'gap', startMs: 0, endMs: 9_000 });
      assert.equal(buildTimelineRenderPlan(project).durationMs, 2_000);
      assert.deepEqual(project, savedProject);
      assert.deepEqual(project.layers.at(-1), tail);
    });
  }
}

test('visible translation can own canvas timing when primary is hidden; hidden track cannot extend output', () => {
  let project = projectFixture('translation-visibility');
  project.clips = [];
  project.captions = [caption(0, 2_000, false)];
  project = withTranslation(project, 5_000);

  assert.equal(projectTimelineDuration(project), 5_000);
  let render = buildTimelineRenderPlan(project);
  assert.equal(render.durationMs, 5_000);
  assert.deepEqual(render.captions.map((item) => item.text), ['你好']);

  project.captionTracks.translations[0].visible = false;
  project.layers.push({ id: 'title', kind: 'text', name: 'Title', text: 'Title', visible: true,
    startMs: 0, endMs: 2_000, style: project.projectStyle });
  assert.equal(projectTimelineDuration(project), 5_000);
  render = buildTimelineRenderPlan(project);
  assert.equal(render.durationMs, 2_000);
  assert.deepEqual(render.captions, []);
});

test('disabled caption burn-in cannot lengthen canvas-only output', () => {
  let project = projectFixture('burn-disabled');
  project.clips = [];
  project.captions = [caption(0, 8_000)];
  project = withTranslation(project, 9_000);
  addAudio(project, 0, 2_000);
  project.export.burnCaptions = false;

  const render = buildTimelineRenderPlan(project);
  assert.equal(projectTimelineDuration(project), 9_000);
  assert.equal(render.durationMs, 2_000);
  assert.deepEqual(render.captions, []);
});
