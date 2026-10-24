import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { absorbShortCaptionCues } from '../src/lib/caption-merge.ts';
import { createEnglishChineseCaptionTrack } from '../src/lib/caption-tracks.ts';
import { buildClipTimeline, completeVideoTimelineEdit, totalClipDuration } from '../src/lib/video-timeline.ts';
import { trimVideoClip, replaceVisibleCaptionScript } from '../src/lib/project-editor.ts';
import { mergeCaptionScriptBlock, splitCaptionScriptBlock } from '../src/lib/caption-script.ts';
import { recoverMergedDualCaptionDrafts, dualCaptionDraftRevision, dualCaptionDraftsFromPairs } from '../src/lib/dual-caption-drafts.ts';

function fixture() {
  return createCaptionProject({ id: 'review-probe', name: 'Review probe', sources: [{ id: 'source',
    uri: 'file:///source.mp4', storageMode: 'copied', displayName: 'source.mp4', durationMs: 4000,
    width: 1080, height: 1920, rotation: 0 }] });
}
function pairs(project) {
  return project.captions.map(source => ({ source,
    translation: project.captionTracks.translations[0].cues.find(cue => cue.sourceCaptionId === source.id) }));
}

test('review probe: caption-only timing completion must not shift footage or clear video gaps', t => {
  const before = fixture();
  before.clips[0] = { ...before.clips[0], gapBeforeMs: 300, gapAfterMs: 700 };
  before.captions = [{ id: 'caption', text: 'Caption only', startMs: 800, endMs: 1800,
    wordIds: [], textMode: 'manual', timingMode: 'timeline', timelineVisible: true }];
  let current = { ...before, captions: [{ ...before.captions[0], startMs: 900, endMs: 1900 }] };
  const source = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('editor.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const workspace = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'EditorWorkspace');
  const declaration = workspace.body.statements.filter(ts.isVariableStatement)
    .flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(ast) === 'finishHistoryInteraction');
  let undo = 0, checkpoints = 0;
  const sandbox = { result: undefined, interactionStartRef: { current: before }, editorSession: { current: () => current },
    completeVideoTimelineEdit, absorbShortCaptionCues, currentMs: 1000, projectTimelineDuration: project => totalClipDuration(project.clips),
    setProject: next => { current = next; }, pushUndo: () => undo++, persistProjectInBackground: () => checkpoints++,
    transport: { synchronizeProject() {}, seek() {} } };
  runInNewContext(ts.transpileModule(`result = ${declaration.initializer.getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, sandbox);
  sandbox.result();
  t.diagnostic(JSON.stringify({ before: { footageStart: buildClipTimeline(before.clips)[0].startMs,
    gaps: [before.clips[0].gapBeforeMs, before.clips[0].gapAfterMs], extent: totalClipDuration(before.clips) },
  after: { footageStart: buildClipTimeline(current.clips)[0].startMs,
    gaps: [current.clips[0].gapBeforeMs, current.clips[0].gapAfterMs], extent: totalClipDuration(current.clips) }, undo, checkpoints }));
  assert.deepEqual(current.clips, before.clips);
});

test('review probe: head-trim origin compaction must retain enough independent timing to restore its interval', t => {
  let project = fixture();
  project.clips = [{ ...project.clips[0], id: 'a' }, { ...project.clips[0], id: 'b' }];
  project.transcription.language = 'en';
  project.captions = [
    { id: 'c1', text: 'First', startMs: 3200, endMs: 3800, wordIds: [], textMode: 'manual', timingMode: 'source', timelineVisible: true,
      sourceAnchor: { clipId: 'a', sourceStartMs: 3200, sourceEndMs: 3800, wordIds: [] } },
    { id: 'c2', text: 'Second', startMs: 4500, endMs: 5500, wordIds: [], textMode: 'manual', timingMode: 'source', timelineVisible: true,
      sourceAnchor: { clipId: 'b', sourceStartMs: 500, sourceEndMs: 1500, wordIds: [] } },
  ];
  project = createEnglishChineseCaptionTrack(project, { c1: 'Independent first', c2: 'Independent second' });
  const cue = value => value.captionTracks.translations[0].cues.find(item => item.sourceCaptionId === 'c1');
  const bounds = value => [cue(value).startMs, cue(value).endMs];
  Object.assign(cue(project), { startMs: 3300, endMs: 3700 });
  const trimmed = trimVideoClip(project, 'a', 'start', 3500).project;
  const restored = trimVideoClip(trimmed, 'a', 'start', 0).project;
  t.diagnostic(JSON.stringify({ original: bounds(project), trimmed: bounds(trimmed), restored: bounds(restored),
    originalSourceAnchor: project.captions[0].sourceAnchor, restoredSourceAnchor: restored.captions[0].sourceAnchor,
    independentText: cue(restored).text }));
  assert.deepEqual(bounds(restored), bounds(project));
});

function splitFixture(newId = 'split-right') {
  let project = fixture();
  project.transcription.language = 'en';
  project.captions = [{ id: 'a', text: 'Alpha', startMs: 0, endMs: 1000, wordIds: [], textMode: 'manual', timingMode: 'timeline', timelineVisible: true },
    { id: 'b', text: 'Beta', startMs: 1000, endMs: 2000, wordIds: [], textMode: 'manual', timingMode: 'timeline', timelineVisible: true }];
  project = createEnglishChineseCaptionTrack(project, { a: 'Translation Alpha', b: 'Translation Beta' });
  const joined = replaceVisibleCaptionScript(project, mergeCaptionScriptBlock(project.captions, 'b').captions);
  const split = splitCaptionScriptBlock(joined.captions, 'a', 5, [], newId);
  assert.ok(split);
  return { project, joined, split: replaceVisibleCaptionScript(joined, split.captions) };
}

test('review probe: ordinary pre-split journal is rejected rather than misapplied by the retained left aliases', t => {
  const { project, split } = splitFixture();
  const payload = { a: { primaryText: 'Typed Alpha', translatedText: 'Typed translation Alpha' },
    b: { primaryText: 'Typed Beta', translatedText: 'Typed translation Beta' } };
  const trackId = project.captionTracks.translations[0].id;
  t.diagnostic(JSON.stringify({ splitTexts: split.captions.map(c => [c.id, c.text]),
    leftAliases: split.captions[0].mergeProvenance.fragments.map(f => f.captionId), rightHistory: !!split.captions[1].mergeProvenance }));
  assert.throws(() => recoverMergedDualCaptionDrafts(payload, pairs(split), trackId), /conflict/i);
});

test('review probe: retained split aliases must not route both original fragments into the left split cue', t => {
  const { project, joined, split } = splitFixture();
  const edited = replaceVisibleCaptionScript(split, split.captions.map(c => c.id === 'a' ? { ...c, text: joined.captions[0].text } : c));
  const trackId = project.captionTracks.translations[0].id;
  const payload = { a: { primaryText: 'Typed Alpha', translatedText: 'Typed translation Alpha' },
    b: { primaryText: 'Typed Beta', translatedText: 'Typed translation Beta' } };
  const recover = () => recoverMergedDualCaptionDrafts(payload, pairs(edited), trackId);
  let actualRecovery, error;
  try { actualRecovery = recover(); } catch (caught) { error = caught.message; }
  t.diagnostic(JSON.stringify({ currentTexts: edited.captions.map(c => [c.id, c.text]), actualRecovery, error }));
  assert.throws(recover, /conflict/i);
});

test('review probe: reusing a retired ID for the right split must not reject a current-revision journal', t => {
  const { split } = splitFixture('b');
  const currentPairs = pairs(split);
  const payload = dualCaptionDraftsFromPairs(currentPairs);
  payload.b = { primaryText: 'Typed current right', translatedText: 'Typed current right translation' };
  const revision = dualCaptionDraftRevision(dualCaptionDraftsFromPairs(currentPairs));
  t.diagnostic(JSON.stringify({ currentIds: split.captions.map(c => c.id),
    leftAliases: split.captions[0].mergeProvenance.fragments.map(f => f.captionId), revision }));
  assert.doesNotThrow(() => recoverMergedDualCaptionDrafts(payload, currentPairs, split.captionTracks.translations[0].id, revision));
});
