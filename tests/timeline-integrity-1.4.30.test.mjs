import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createCaptionProject } from '../src/lib/project-factory.ts';
import { splitVideoClip } from '../src/lib/project-editor.ts';

test('splitting video is topology-only for subtitle identity, text, timing, and word references', () => {
  const source = { id: 'source', uri: 'content://video/source', storageMode: 'linked', displayName: 'source.mp4', durationMs: 6_000, width: 1080, height: 1920, rotation: 0 };
  const project = createCaptionProject({ id: 'split-integrity', name: 'Split integrity', sources: [source] });
  const clipId = project.clips[0].id;
  project.captions = [
    { id: 'left-caption', text: 'left', textMode: 'automatic', timingMode: 'source', startMs: 400, endMs: 1_200, wordIds: ['word-left'], timelineVisible: true, sourceAnchor: { clipId, sourceStartMs: 400, sourceEndMs: 1_200, wordIds: ['word-left'] } },
    { id: 'cross-caption', text: 'do not rewrite me', textMode: 'manual', timingMode: 'source', startMs: 2_700, endMs: 3_300, wordIds: ['word-cross'], timelineVisible: true, sourceAnchor: { clipId, sourceStartMs: 2_700, sourceEndMs: 3_300, wordIds: ['word-cross'] } },
    { id: 'right-caption', text: 'right', textMode: 'automatic', timingMode: 'source', startMs: 4_000, endMs: 4_800, wordIds: ['word-right'], timelineVisible: true, sourceAnchor: { clipId, sourceStartMs: 4_000, sourceEndMs: 4_800, wordIds: ['word-right'] } },
  ];
  const immutableFields = project.captions.map(({ id, text, startMs, endMs, wordIds }) => ({ id, text, startMs, endMs, wordIds }));

  const result = splitVideoClip(project, clipId, 3_000, 'left-clip', 'right-clip');
  assert.ok(result);
  assert.deepEqual(result.project.captions.map(({ id, text, startMs, endMs, wordIds }) => ({ id, text, startMs, endMs, wordIds })), immutableFields);
  assert.equal(result.project.captions[0].sourceAnchor.clipId, 'left-clip');
  assert.equal(result.project.captions[1].timingMode, 'timeline');
  assert.equal(result.project.captions[1].sourceAnchor, undefined);
  assert.equal(result.project.captions[2].sourceAnchor.clipId, 'right-clip');
});

test('preview layers own hit testing, authored lines, stable transform baselines, and timing UI', () => {
  const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
  const captions = readFileSync(new URL('../src/components/editor/caption-overlay.tsx', import.meta.url), 'utf8');
  const images = readFileSync(new URL('../src/components/editor/image-layer-overlay.tsx', import.meta.url), 'utf8');
  const gesture = readFileSync(new URL('../src/hooks/use-layer-gesture.ts', import.meta.url), 'utf8');
  const presentation = readFileSync(new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/TextPresentation.kt', import.meta.url), 'utf8');
  assert.match(editor, /TransitionTimingSheet/);
  assert.match(editor, /Transition timing…/);
  assert.match(editor, /preserveLineBreaks/);
  assert.match(editor, /onSelect=\{\(\) => selectEditorObject\(/);
  assert.match(captions, /<CaptionPresentation/);
  assert.match(captions, /authored=\{Boolean\(props\.preserveLineBreaks\)\}/);
  assert.match(captions, /ref=\{canvasRef\}/);
  assert.match(captions, /zIndex: props\.interactive \? 100 : 0/);
  assert.doesNotMatch(captions, /ref=\{\(node\) =>/);
  assert.match(images, /ref=\{canvasRef\}/);
  assert.match(images, /zIndex: props\.interactive \? 100 : 0/);
  assert.doesNotMatch(images, /ref=\{\(node\) =>/);
  assert.match(presentation, /rawText\.replace\("\\r\\n", "\\n"\)/);
  assert.match(presentation, /text\.contains\('\\n'\)/);
  assert.match(gesture, /activeOwner\.source/);
  assert.match(gesture, /Boolean\(interactive \|\| \(mode === 'move' && selectable\)\)/);
  assert.match(images, /useLayerGesture/);
  assert.doesNotMatch(images, /function ImageCornerHandle/);
});

test('timeline seeks retain an already owned source instead of replacing its decoder on transient status', () => {
  const controller = readFileSync(new URL('../src/hooks/use-timeline-video-controller.ts', import.meta.url), 'utf8');
  assert.match(controller, /const loadedSource = slotSourcesRef\.current\[activeSlotRef\.current\];/);
  assert.match(controller, /loadedSource\?\.id !== source\.id[\s\S]*loadedSource\.uri !== source\.uri/);
  assert.doesNotMatch(controller, /const sourceChanged = confirmedSourceIdRef\.current !== source\.id\n\s*\|\| !canReuseVideoSource/);
});
