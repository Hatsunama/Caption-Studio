import assert from 'node:assert/strict';
import test from 'node:test';

import { createEnglishChineseCaptionTrack } from '../src/lib/caption-tracks.ts';
import { buildTimelineRenderPlan, collectUnresolvedFontFamilies } from '../src/lib/export-render-plan.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { projectTimelineDuration } from '../src/lib/project-timeline.ts';
import { serializeSrt } from '../src/lib/subtitle-export.ts';

function projectFixture(id) {
  return createCaptionProject({ id, name: id, sources: [{
    id: 'video', uri: 'file:///video.mp4', storageMode: 'copied', displayName: 'video.mp4',
    durationMs: 4_000, width: 1920, height: 1080, rotation: 0, frameRate: 30,
  }] });
}

function textLayer(project, id, endMs, style = project.projectStyle) {
  return { id, kind: 'text', name: id, text: id, visible: true,
    startMs: 0, endMs, style };
}

for (const kind of ['text', 'image']) {
  test(`canvas duration ignores a fully transparent ${kind} tail without changing the draft`, () => {
    const project = projectFixture(`transparent-${kind}`);
    project.clips = [];
    project.layers.push(textLayer(project, 'short-title', 2_000));
    const tail = kind === 'text'
      ? textLayer(project, 'transparent-tail', 9_000, { ...project.projectStyle, opacity: 0 })
      : { id: 'transparent-tail', kind: 'image', name: 'transparent-tail', visible: true,
          uri: 'file:///sticker.png', startMs: 0, endMs: 9_000,
          position: { x: 0.5, y: 0.5 }, box: { width: 0.2, height: 0.2 },
          rotation: 0, opacity: 0 };
    project.layers.push(tail);
    const draft = structuredClone(project);

    assert.equal(projectTimelineDuration(project), 9_000);
    assert.equal(buildTimelineRenderPlan(project).durationMs, 2_000);
    assert.deepEqual(project, draft);
    assert.deepEqual(project.layers.at(-1), tail);
  });
}

function translationFixture(id, outside) {
  const project = projectFixture(id);
  project.captions = [{ id: 'primary', text: 'Hello', startMs: 0, endMs: 1_000,
    wordIds: [], textMode: 'manual', timelineVisible: true }];
  const bilingual = createEnglishChineseCaptionTrack(project, { primary: 'Ni hao' });
  const track = bilingual.captionTracks.translations[0];
  track.sourceLanguageTag = 'fr';
  track.cues[0].startMs = outside ? 5_000 : 500;
  track.cues[0].endMs = outside ? 6_000 : 900;
  return bilingual;
}

test('out-of-range translation language mismatch cannot block the MP4 render plan', () => {
  const project = translationFixture('outside-video', true);
  const draft = structuredClone(project);
  assert.deepEqual(buildTimelineRenderPlan(project).captions.map((caption) => caption.text), ['Hello']);
  assert.deepEqual(project, draft);
});

test('out-of-range translation language mismatch cannot block SRT', () => {
  const project = translationFixture('outside-srt', true);
  const draft = structuredClone(project);
  assert.match(serializeSrt(project), /Hello/);
  assert.doesNotMatch(serializeSrt(project), /Ni hao/);
  assert.deepEqual(project, draft);
});

test('an in-range translation language mismatch still blocks MP4 and SRT', () => {
  const project = translationFixture('inside-video', false);
  assert.throws(() => buildTimelineRenderPlan(project), /no longer matches the primary caption language/);
  assert.throws(() => serializeSrt(project), /no longer matches the primary caption language/);
});

test('transparent in-range text with unavailable fonts is omitted before font resolution', () => {
  const project = projectFixture('transparent-fonts');
  const missingFonts = [
    { id: 'missing-import', family: 'Missing Import', source: 'imported', uri: 'file:///missing-font.otf' },
    { id: 'missing-bundle', family: 'Missing Bundle', source: 'built-in' },
  ];
  for (const font of missingFonts) {
    project.layers.push(textLayer(project, font.id, 2_000,
      { ...project.projectStyle, opacity: 0, font }));
  }
  const draft = structuredClone(project);
  const plan = buildTimelineRenderPlan(project);

  assert.deepEqual(plan.layers.map((layer) => layer.id), ['captions']);
  assert.deepEqual(collectUnresolvedFontFamilies(plan), []);
  assert.deepEqual(project, draft);
  assert.deepEqual(project.layers.slice(-2).map((layer) => layer.style.font), missingFonts);
});
