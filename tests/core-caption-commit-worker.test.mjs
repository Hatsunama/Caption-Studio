import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { absorbShortCaptionCues } from '../src/lib/caption-merge.ts';
import { completeVideoTimelineEdit, buildClipTimeline, setClipPlaybackRate, totalClipDuration } from '../src/lib/video-timeline.ts';
import { previewVideoClipTrim, setVideoClipGap, setVideoClipLeadingGap, trimVideoClip, replaceVisibleCaptionScript } from '../src/lib/project-editor.ts';
import { mergeCaptionScriptBlock } from '../src/lib/caption-script.ts';
import { decodeVersionTwoProject } from '../src/lib/project-schema.ts';
import { recoverMergedDualCaptionDrafts } from '../src/lib/dual-caption-drafts.ts';

const editorSource = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
const editorAst = ts.createSourceFile('editor.tsx', editorSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const workspace = editorAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'EditorWorkspace');
function handler(name, context) {
  const declaration = workspace.body.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations]).find(node => node.name.getText(editorAst) === name);
  assert.ok(declaration, name);
  const sandbox = { result: undefined, ...context };
  const output = ts.transpileModule(`result = ${declaration.initializer.getText(editorAst)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(output, sandbox);
  return sandbox.result;
}
function fixture() {
  return createCaptionProject({ id: 'commit-worker', name: 'Commit boundary', sources: [{
    id: 'source', uri: 'file:///source.mp4', storageMode: 'copied', displayName: 'source.mp4',
    durationMs: 4000, width: 1080, height: 1920, rotation: 0,
  }] });
}
function context(initial) {
  let current = initial;
  const calls = { undo: [], checkpoints: 0, seeks: [], synchronizations: [] };
  return { calls, get: () => current, set: value => { current = value; },
    editorSession: { current: () => current },
    setProject: value => { current = value; },
    pushUndo: snapshot => calls.undo.push(snapshot ?? current),
    persistProjectInBackground: () => { calls.checkpoints++; },
    transport: { synchronizeProject: next => calls.synchronizations.push(next), pause() {}, seek: ms => calls.seeks.push(ms) },
    seekTimeline: ms => calls.seeks.push(ms), queueMicrotask: callback => callback(),
    projectTimelineDuration: project => totalClipDuration(project.clips), completeVideoTimelineEdit, absorbShortCaptionCues,
    trimVideoClip, setVideoClipGap, setVideoClipLeadingGap, setClipPlaybackRate, buildClipTimeline,
    selectedClipId: initial.clips[0].id, currentMs: 500,
    clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
  };
}

test('core worker callbacks: completion helper is imported into the actual workspace', () => {
  assert.ok(editorAst.statements.filter(ts.isImportDeclaration).some(node => node.importClause?.namedBindings
    && ts.isNamedImports(node.importClause.namedBindings)
    && node.importClause.namedBindings.elements.some(element => element.name.text === 'completeVideoTimelineEdit')));
});

test('core worker callbacks: trim preview retains outer gap drafts', () => {
  const project = fixture();
  const clip = { ...project.clips[0], gapBeforeMs: 300, gapAfterMs: 700 };
  const before = structuredClone(clip);
  const preview = previewVideoClipTrim(clip, 'end', 3000);
  assert.equal(preview.gapBeforeMs, 300);
  assert.equal(preview.gapAfterMs, 1700);
  assert.deepEqual(clip, before);
});

for (const [name, args] of [
  ['trimClipEdge', ['end', 3000]], ['setClipGap', [500]], ['setClipLeadingGap', [500]],
]) {
  test(`core worker callbacks: ${name} creates one undo/checkpoint and seeks within completed footage`, () => {
    const project = fixture();
    project.clips[0] = { ...project.clips[0], gapBeforeMs: 300, gapAfterMs: 700 };
    const environment = context(project);
    handler(name, environment)(project.clips[0].id, ...args);
    assert.equal(environment.calls.undo.length, 1);
    assert.equal(environment.calls.checkpoints, 1);
    assert.equal(environment.calls.seeks.length, 1);
    assert.equal(environment.get().clips[0].gapBeforeMs, 0);
    assert.equal(environment.get().clips[0].gapAfterMs, 0);
    assert.ok(environment.calls.seeks[0] >= 0 && environment.calls.seeks[0] <= totalClipDuration(environment.get().clips));
  });
}

test('core worker callbacks: preview interaction completes with one undo/checkpoint and preserves its baseline', () => {
  const before = fixture();
  const draft = { ...before, clips: [{ ...before.clips[0], gapBeforeMs: 300, gapAfterMs: 700 }] };
  const environment = context(draft);
  environment.interactionStartRef = { current: before };
  handler('finishHistoryInteraction', environment)();
  assert.equal(environment.calls.undo.length, 1);
  assert.equal(environment.calls.undo[0], before);
  assert.equal(environment.calls.checkpoints, 1);
  assert.equal(environment.get().clips[0].gapBeforeMs, 0);
  assert.equal(environment.get().clips[0].gapAfterMs, 0);
  assert.equal(environment.calls.seeks[0], 200);
});

test('core worker callbacks: speed action uses the completed-edit path and a single checkpoint', () => {
  const project = fixture();
  project.clips[0] = { ...project.clips[0], gapBeforeMs: 300, gapAfterMs: 700 };
  const environment = context(project);
  handler('updateSelectedClipRate', environment)(2);
  assert.equal(environment.calls.undo.length, 1);
  assert.equal(environment.calls.checkpoints, 1);
  assert.equal(environment.get().clips[0].gapBeforeMs, 0);
  assert.equal(environment.get().clips[0].gapAfterMs, 0);
  assert.equal(totalClipDuration(environment.get().clips), 2000);
});

test('core worker: chained joins retain earliest metadata and the edited intermediate input', () => {
  const project = fixture();
  project.captions = ['a', 'b', 'c'].map((id, index) => ({ id, text: id.toUpperCase(), startMs: index * 1000,
    endMs: (index + 1) * 1000, wordIds: [], textMode: 'manual', timingMode: 'timeline', timelineVisible: true,
    styleOverride: { textColor: index === 0 ? '#FF0000' : '#00FF00' } }));
  project.captionTracks = { schemaVersion: 1, primaryTrackId: 'captions', translations: [{
    id: 'fr', kind: 'translation', sourceTrackId: 'captions', sourceLanguageTag: 'en', languageTag: 'fr',
    displayName: 'French', visible: true, origin: 'manual', provider: { id: 'manual' },
    cues: project.captions.map(c => ({ id: `fr-${c.id}`, sourceCaptionId: c.id, sourceTextSnapshot: c.text,
      text: c.id, status: 'reviewed', reviewed: true, styleOverride: c.styleOverride })),
  }] };
  project.transcription.language = 'en';
  const first = replaceVisibleCaptionScript(project, mergeCaptionScriptBlock(project.captions, 'b').captions);
  first.captions[0] = { ...first.captions[0], text: 'Edited intermediate' };
  first.captionTracks.translations[0].cues[0] = { ...first.captionTracks.translations[0].cues[0], text: 'intermediate translation' };
  const final = replaceVisibleCaptionScript(first, mergeCaptionScriptBlock(first.captions, 'c').captions);
  const history = final.captions[0].mergeProvenance;
  assert.equal(final.captions[0].text, 'Edited intermediate C');
  assert.equal(history.fragments[0].primary.text, 'A');
  assert.deepEqual(history.fragments[0].translationCues.fr, project.captionTracks.translations[0].cues[0]);
  assert.equal(history.previousJoins[0].primary.text, 'Edited intermediate');
  assert.equal(history.previousJoins[0].translationCues.fr.text, 'intermediate translation');
  const restored = decodeVersionTwoProject(JSON.parse(JSON.stringify(final)));
  assert.deepEqual(JSON.parse(JSON.stringify(restored.captions[0].mergeProvenance)), JSON.parse(JSON.stringify(history)));
  const recovery = recoverMergedDualCaptionDrafts({
    a: { primaryText: 'Typed intermediate', translatedText: 'intermediate translation' },
    c: { primaryText: 'C', translatedText: 'typed last' },
  }, [{ source: final.captions[0], translation: final.captionTracks.translations[0].cues[0] }], 'fr');
  assert.deepEqual(recovery.drafts, { a: { primaryText: 'Typed intermediate C', translatedText: 'intermediate translation typed last' } });
});
