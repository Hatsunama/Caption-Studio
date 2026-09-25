import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import { mapPreviewTranslationTracks } from '../src/lib/translation-preview-timeline.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { remapCaptionsToTimeline } from '../src/lib/video-timeline.ts';

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
const evaluate = new Function('props', 'clipPreview', 'previewClips', 'displayCaptions',
  'mapPreviewTranslationTracks', 'useMemo', `${expression}\nreturn displayTranslationTracks;`);

function fixture() {
  const project = createCaptionProject({ id: 'preview-mapping', name: 'Preview mapping', sources: [{
    id: 'video', uri: 'file:///video.mp4', storageMode: 'copied', displayName: 'Video',
    durationMs: 3_000, width: 1080, height: 1920, rotation: 0,
  }] });
  const clip = project.clips[0];
  const primary = { id: 'primary', text: 'Hello', startMs: 0, endMs: 1_000, wordIds: [],
    timingMode: 'source', sourceAnchor: { clipId: clip.id, sourceStartMs: 0, sourceEndMs: 1_000, wordIds: [] } };
  const pair = { trackId: 'translation-zh-Hans', languageTag: 'zh-Hans', visible: true,
    startMs: 1_500, endMs: 2_500, timelineVisible: true, source: primary,
    translation: { id: 'translated', sourceCaptionId: primary.id, text: '你好', status: 'translated' },
    displayText: '你好', displayProvenance: 'translation', style: {} };
  return { clip, primary, tracks: [{ id: pair.trackId, name: 'Chinese', visible: true, pairs: [pair] }] };
}

function displayed(fixture, previewClips) {
  const props = { clips: [fixture.clip], translationTracks: fixture.tracks };
  const displayCaptions = remapCaptionsToTimeline([fixture.primary], previewClips, []);
  return evaluate(props, previewClips, previewClips, displayCaptions,
    mapPreviewTranslationTracks, (compute) => compute())[0].pairs[0];
}

test('temporary clip move shifts an independently retimed secondary cue', () => {
  const original = fixture();
  const previewClips = [{ ...original.clip, gapBeforeMs: 500 }];
  const pair = displayed(original, previewClips);
  assert.deepEqual([pair.startMs, pair.endMs, pair.timelineVisible], [2_000, 3_000, true]);
  assert.deepEqual([pair.source.startMs, pair.source.endMs], [500, 1_500]);
  assert.deepEqual([original.tracks[0].pairs[0].startMs, original.tracks[0].pairs[0].endMs], [1_500, 2_500]);
});

test('temporary trim clips a secondary cue by its own interval and hides it when cut away', () => {
  const original = fixture();
  const partial = displayed(original, [{ ...original.clip, sourceEndMs: 2_000 }]);
  assert.deepEqual([partial.startMs, partial.endMs, partial.timelineVisible], [1_500, 2_000, true]);
  const removed = displayed(original, [{ ...original.clip, sourceEndMs: 1_200 }]);
  assert.equal(removed.timelineVisible, false);
  assert.equal(removed.startMs, removed.endMs);
  assert.equal(original.tracks[0].pairs[0].timelineVisible, true);
});

test('cross-clip secondary preview follows the dominant media owner used by committed reorders', () => {
  const original = fixture();
  const left = { ...original.clip, id: 'left', sourceEndMs: 2_000 };
  const right = { ...original.clip, id: 'right', sourceStartMs: 2_000, sourceEndMs: 3_000 };
  const pair = { ...original.tracks[0].pairs[0], startMs: 1_750, endMs: 2_500 };
  const props = { clips: [left, right], translationTracks: [{ ...original.tracks[0], pairs: [pair] }] };
  const previewClips = [left, { ...right, gapBeforeMs: 500 }];
  const displayed = evaluate(props, previewClips, previewClips, [original.primary],
    mapPreviewTranslationTracks, (compute) => compute())[0].pairs[0];
  assert.deepEqual([displayed.startMs, displayed.endMs, displayed.timelineVisible], [2_250, 3_000, true]);
});
