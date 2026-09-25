import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import { captionPreviewState } from '../src/lib/caption-preview.ts';
import { createEnglishChineseCaptionTrack, resolveCaptionPairs, setTranslationCueTiming } from '../src/lib/caption-tracks.ts';
import { buildTimelineRenderPlan } from '../src/lib/export-render-plan.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';

function bilingualProject() {
  const project = createCaptionProject({
    id: 'secondary-contract', name: 'Secondary contract',
    sources: [{ id: 'video', uri: 'file:///video.mp4', storageMode: 'copied', displayName: 'Video',
      durationMs: 4_000, width: 1080, height: 1920, rotation: 0 }],
  });
  project.captions = [{ id: 'primary', text: 'Hello world', startMs: 0, endMs: 1_000,
    wordIds: ['hello', 'world'] }];
  project.transcription.words = [
    { id: 'hello', text: 'Hello', startMs: 0, endMs: 450 },
    { id: 'world', text: 'world', startMs: 450, endMs: 1_000 },
  ];
  project.projectStyle = { ...project.projectStyle,
    animation: { id: 'karaoke', intensity: 1, durationMs: 220 } };
  const bilingual = createEnglishChineseCaptionTrack(project, { primary: '你好世界' });
  const trackId = bilingual.captionTracks.translations[0].id;
  return { project: bilingual, trackId };
}

test('secondary preview and export honor the secondary interval independently of the primary', () => {
  const { project, trackId } = bilingualProject();
  const retimed = setTranslationCueTiming(project, trackId, 'primary', 'move', 1_500, 2_500);
  const pair = resolveCaptionPairs(retimed, trackId)[0];
  assert.deepEqual([pair.startMs, pair.endMs], [1_500, 2_500]);
  assert.deepEqual([pair.source.startMs, pair.source.endMs], [0, 1_000]);

  const visibleAt = (ms) => {
    const primary = captionPreviewState(retimed.captions, ms).activeCaptions.map((cue) => cue.text);
    const secondary = resolveCaptionPairs(retimed, trackId)
      .filter((cue) => cue.visible && cue.timelineVisible && cue.displayText.trim()
        && ms >= cue.startMs && ms < cue.endMs)
      .map((cue) => cue.displayText);
    return [...primary, ...secondary];
  };
  assert.deepEqual(visibleAt(500), ['Hello world']);
  assert.deepEqual(visibleAt(1_000), []);
  assert.deepEqual(visibleAt(1_500), ['你好世界']);
  assert.deepEqual(visibleAt(2_499), ['你好世界']);
  assert.deepEqual(visibleAt(2_500), []);

  const plan = buildTimelineRenderPlan(retimed);
  assert.deepEqual(plan.captions.map(({ text, startMs, endMs }) => [text, startMs, endMs]), [
    ['Hello world', 0, 1_000], ['你好世界', 1_500, 2_500],
  ]);
});

test('clip preview keeps translated timeline cue timing independent of remapped primary timing', () => {
  const { project, trackId } = bilingualProject();
  const retimed = setTranslationCueTiming(project, trackId, 'primary', 'move', 1_500, 2_500);
  const pair = resolveCaptionPairs(retimed, trackId)[0];
  const source = readFileSync(new URL('../src/components/editor/layer-timeline.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('layer-timeline.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'displayTranslationTracks') initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(initializer, 'timeline must resolve displayed translation tracks');
  const expression = ts.transpileModule(`const displayTranslationTracks = ${initializer.getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const evaluate = new Function('props', 'clipPreview', 'displayCaptions', 'useMemo',
    `${expression}\nreturn displayTranslationTracks;`);
  const tracks = [{ id: trackId, name: 'Chinese', visible: true, pairs: [pair] }];
  const displayed = evaluate({ translationTracks: tracks }, [{}],
    [{ ...pair.source, startMs: 200, endMs: 800 }], (compute) => compute());
  assert.deepEqual([displayed[0].pairs[0].startMs, displayed[0].pairs[0].endMs], [1_500, 2_500]);
  assert.deepEqual([displayed[0].pairs[0].source.startMs, displayed[0].pairs[0].source.endMs], [0, 1_000]);
});

test('secondary captions never receive primary word timing or karaoke animation', () => {
  const { project, trackId } = bilingualProject();
  const pair = resolveCaptionPairs(project, trackId)[0];
  const [primary, secondary] = buildTimelineRenderPlan(project).captions;
  assert.equal(primary.style.animation.id, 'karaoke');
  assert.deepEqual(primary.words.map(({ text, startMs, endMs }) => [text, startMs, endMs]), [
    ['Hello', 0, 450], ['world', 450, 1_000],
  ]);
  assert.equal(pair.style.animation.id, 'none');
  assert.equal(secondary.style.animation.id, 'none');
  assert.deepEqual(secondary.words, []);

  // The editor constructs native preview captions separately from the export plan.
  const source = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('editor.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const overlays = [];
  function visit(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'CaptionOverlay') overlays.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const secondaryOverlay = overlays.find((node) => node.attributes.properties.some((attribute) =>
    ts.isJsxAttribute(attribute) && attribute.name.text === 'caption'
      && attribute.initializer?.getText(ast).includes('pair.translation.id')));
  assert.ok(secondaryOverlay, 'editor preview must render a secondary overlay');
  const props = new Map(secondaryOverlay.attributes.properties
    .filter(ts.isJsxAttribute).map((attribute) => [attribute.name.text, attribute.initializer?.getText(ast)]));
  assert.match(props.get('caption'), /wordIds:\s*\[\s*\]/);
  assert.match(props.get('words'), /^\{\[\]\}$/);
});

test('secondary timing edits preserve both primary and secondary font families', () => {
  const { project, trackId } = bilingualProject();
  const beforePair = resolveCaptionPairs(project, trackId)[0];
  const beforePlan = buildTimelineRenderPlan(project);
  const retimed = setTranslationCueTiming(project, trackId, 'primary', 'move', 1_500, 2_500);
  const afterPair = resolveCaptionPairs(retimed, trackId)[0];
  const afterPlan = buildTimelineRenderPlan(retimed);
  assert.equal(afterPair.style.font.family, beforePair.style.font.family);
  assert.deepEqual(afterPlan.captions.map((caption) => caption.style.font.family),
    beforePlan.captions.map((caption) => caption.style.font.family));
});
