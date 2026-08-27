import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildTimelineRenderPlan } from '../src/lib/export-render-plan.ts';
import { setVideoClipTransform, splitVideoClip } from '../src/lib/project-editor.ts';
import { createCaptionProject, createVideoClip } from '../src/lib/project-factory.ts';
import { decodeVersionTwoProject } from '../src/lib/project-schema.ts';

const portrait = videoSource('portrait', 6_000, 1080, 1920);
const landscape = videoSource('landscape', 8_000, 1920, 1080);

test('legacy project transforms migrate into independent clip-owned transforms', () => {
  const legacy = createCaptionProject({ id: 'legacy', name: 'Legacy', sources: [portrait, landscape] });
  legacy.videoTransform = {
    fit: 'fill',
    position: { x: 0.27, y: 0.68 },
    scale: 1.7,
    rotation: -31,
  };
  for (const clip of legacy.clips) delete clip.transform;

  const decoded = decodeVersionTwoProject(structuredClone(legacy));

  assert.deepEqual(decoded.clips.map((clip) => clip.transform), [legacy.videoTransform, legacy.videoTransform]);
  assert.notEqual(decoded.clips[0].transform, decoded.clips[1].transform);
  assert.notEqual(decoded.clips[0].transform.position, decoded.clips[1].transform.position);
  assert.notEqual(decoded.clips[0].transform.position, decoded.videoTransform.position);
});

test('persisted per-clip transforms override the legacy default and validate independently', () => {
  const project = createCaptionProject({ id: 'modern', name: 'Modern', sources: [portrait, landscape] });
  project.videoTransform = { fit: 'fit', position: { x: 0.5, y: 0.5 }, scale: 1, rotation: 0 };
  project.clips[0].transform = { fit: 'fill', position: { x: 0.2, y: 0.7 }, scale: 1.4, rotation: 15 };
  project.clips[1].transform = { fit: 'fit', position: { x: 0.8, y: 0.3 }, scale: 0.7, rotation: -42 };

  const decoded = decodeVersionTwoProject(structuredClone(project));
  assert.deepEqual(decoded.clips.map((clip) => clip.transform), project.clips.map((clip) => clip.transform));

  const invalid = structuredClone(project);
  invalid.clips[1].transform.scale = Number.POSITIVE_INFINITY;
  assert.throws(() => decodeVersionTwoProject(invalid), /video clip 2 transform scale is invalid/);
});

test('transform editing mutates only the addressed clip and split clips retain detached ownership', () => {
  const project = createCaptionProject({ id: 'edit', name: 'Edit', sources: [portrait, landscape] });
  const firstBefore = structuredClone(project.clips[0].transform);
  const globalBefore = structuredClone(project.videoTransform);
  const secondId = project.clips[1].id;

  const edited = setVideoClipTransform(project, secondId, {
    fit: 'fill',
    position: { x: 0.18 },
    scale: 2.25,
    rotation: 235,
  });

  assert.deepEqual(edited.clips[0].transform, firstBefore);
  assert.deepEqual(edited.videoTransform, globalBefore);
  assert.deepEqual(edited.clips[1].transform, {
    fit: 'fill',
    position: { x: 0.18, y: 0.5 },
    scale: 2.25,
    rotation: -125,
  });

  const single = createCaptionProject({ id: 'split', name: 'Split', sources: [portrait] });
  const transformed = setVideoClipTransform(single, single.clips[0].id, {
    fit: 'fill',
    position: { x: 0.4, y: 0.6 },
    scale: 1.3,
    rotation: 22,
  });
  const split = splitVideoClip(transformed, transformed.clips[0].id, 3_000, 'left', 'right');
  assert.ok(split);
  assert.deepEqual(split.project.clips[0].transform, transformed.clips[0].transform);
  assert.deepEqual(split.project.clips[1].transform, transformed.clips[0].transform);
  assert.notEqual(split.project.clips[0].transform.position, split.project.clips[1].transform.position);
});

test('new clips clone their supplied default transform instead of sharing mutable state', () => {
  const supplied = { fit: 'fill', position: { x: 0.3, y: 0.4 }, scale: 1.2, rotation: 9 };
  const first = createVideoClip(portrait, 0, supplied);
  const second = createVideoClip(portrait, 1, supplied);

  assert.deepEqual(first.transform, supplied);
  assert.deepEqual(second.transform, supplied);
  assert.notEqual(first.transform, supplied);
  assert.notEqual(first.transform.position, second.transform.position);
});

test('render plans serialize detached transforms and recoverable source bounds for every clip', () => {
  let project = createCaptionProject({ id: 'export', name: 'Export', sources: [portrait, landscape] });
  project = setVideoClipTransform(project, project.clips[0].id, {
    fit: 'fill', position: { x: 0.25, y: 0.75 }, scale: 1.6, rotation: 12,
  });
  project = setVideoClipTransform(project, project.clips[1].id, {
    fit: 'fit', position: { x: 0.7, y: 0.35 }, scale: 0.8, rotation: -27,
  });
  project.clips[0] = {
    ...project.clips[0],
    availableSourceStartMs: 100,
    availableSourceEndMs: 5_900,
    sourceStartMs: 500,
    sourceEndMs: 5_500,
  };

  const plan = buildTimelineRenderPlan(project);

  assert.deepEqual(plan.videoTransform, project.clips[0].transform);
  assert.deepEqual(plan.clips.map((clip) => ({
    availableSourceStartMs: clip.availableSourceStartMs,
    availableSourceEndMs: clip.availableSourceEndMs,
    transform: clip.transform,
  })), project.clips.map((clip) => ({
    availableSourceStartMs: clip.availableSourceStartMs,
    availableSourceEndMs: clip.availableSourceEndMs,
    transform: clip.transform,
  })));
  assert.notEqual(plan.clips[0].transform.position, project.clips[0].transform.position);
  project.clips[0].transform.position.x = 0.99;
  assert.equal(plan.clips[0].transform.position.x, 0.25);
  assert.equal(plan.videoTransform.position.x, 0.25);
});

test('editor preview and controls resolve a concrete current or selected clip transform', () => {
  const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
  const tools = readFileSync(new URL('../src/components/editor/video-tools.tsx', import.meta.url), 'utf8');
  const projectEditor = readFileSync(new URL('../src/lib/project-editor.ts', import.meta.url), 'utf8');

  assert.match(editor, /currentVideoTransform = currentClipEntry\?\.clip\.transform \?\? project\.videoTransform/);
  assert.match(editor, /editableVideoClip = currentClipEntry\?\.clip \?\? selectedClip/);
  assert.match(editor, /setVideoClipTransform\(current, clipId, patch\)/);
  assert.match(editor, /transform=\{currentVideoTransform\}/);
  assert.match(editor, /transform=\{editableVideoTransform\}/);
  assert.doesNotMatch(tools, /project\.videoTransform/);
  assert.doesNotMatch(projectEditor, /export function setVideoTransform\(/);
});

function videoSource(id, durationMs, width, height) {
  return {
    id,
    uri: `content://media/video/${id}`,
    storageMode: 'linked',
    displayName: `${id}.mp4`,
    durationMs,
    width,
    height,
    rotation: 0,
  };
}
