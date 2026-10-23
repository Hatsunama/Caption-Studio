import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { decodeCaption, decodeVersionTwoProject, serializeProjectSnapshot } from '../src/lib/project-schema.ts';
import { decodePersistedProject } from '../src/lib/project-codec.ts';
import { decodeCaptionDraft, mergeCaptionScriptBlock } from '../src/lib/caption-script.ts';
import { mergeProjectCaptionPair } from '../src/lib/caption-merge.ts';
import { replaceVisibleCaptionScript } from '../src/lib/project-editor.ts';
import { recoverMergedDualCaptionDrafts } from '../src/lib/dual-caption-drafts.ts';

function fixture(count = 2) {
  const project = createCaptionProject({ id: 'join-capacity', name: 'Join capacity', sources: [{
    id: 'source', uri: 'file:///source.mp4', storageMode: 'copied', displayName: 'source.mp4',
    durationMs: 40_000, width: 1080, height: 1920, rotation: 0,
  }] });
  project.transcription.language = 'en';
  project.captions = Array.from({ length: count }, (_, index) => ({ id: `c-${index}`, text: `Part${index}`,
    startMs: index * 1000, endMs: (index + 1) * 1000, wordIds: [], textMode: 'manual',
    timingMode: 'timeline', timelineVisible: true, styleOverride: { textColor: '#FF0000' } }));
  project.captionTracks = { schemaVersion: 1, primaryTrackId: 'captions', translations: ['fr', 'de'].map(id => ({
    id, kind: 'translation', sourceTrackId: 'captions', sourceLanguageTag: 'en', languageTag: id,
    displayName: id, visible: true, origin: 'manual', provider: { id: 'manual' },
    cues: project.captions.map(caption => ({ id: `${id}-${caption.id}`, sourceCaptionId: caption.id,
      sourceTextSnapshot: caption.text, text: `${id}${caption.id}`, status: 'reviewed', reviewed: true,
      startMs: caption.startMs + 10, endMs: caption.endMs - 10, styleOverride: { textColor: '#00FF00' } })),
  })), independentTimingOrigins: Object.fromEntries(['fr', 'de'].flatMap(id => project.captions.map(c => [`${id}-${c.id}`, 0]))) };
  return project;
}
const plain = value => JSON.parse(JSON.stringify(value));

test('34 real sequential joins retain every original, intermediate, track and timing origin through persistence and recovery', () => {
  const original = fixture(34);
  const before = structuredClone(original);
  let project = original;
  for (let index = 1; index < 34; index++) {
    const draft = mergeCaptionScriptBlock(project.captions, `c-${index}`, 'previous');
    assert.ok(draft);
    project = replaceVisibleCaptionScript(project, draft.captions);
  }
  const restored = decodePersistedProject(serializeProjectSnapshot(project));
  const history = restored.captions[0].mergeProvenance;
  assert.equal(restored.captions.length, 1);
  assert.equal(restored.captions[0].id, 'c-0');
  assert.equal(history.fragments.length, 34);
  assert.equal(history.previousJoins.length, 32);
  assert.deepEqual(plain(history), plain(project.captions[0].mergeProvenance));
  assert.ok(decodeCaptionDraft(plain(restored.captions)));
  for (const [index, fragment] of history.fragments.entries()) {
    assert.deepEqual(plain(fragment.primary), plain(original.captions[index]));
    for (const track of original.captionTracks.translations) {
      assert.deepEqual(plain(fragment.translationCues[track.id]), plain(track.cues[index]));
      assert.equal(fragment.translationOrigins[track.id], 0);
    }
  }
  for (const track of restored.captionTracks.translations) {
    const oldTrack = original.captionTracks.translations.find(item => item.id === track.id);
    assert.equal(track.cues[0].text, oldTrack.cues.map(cue => cue.text).join(' '));
    assert.equal(restored.captionTracks.independentTimingOrigins[track.cues[0].id], 0);
    const payload = Object.fromEntries(original.captions.map((caption, index) => [caption.id, {
      primaryText: index === 33 ? 'Typed last' : caption.text,
      translatedText: index === 33 ? 'Translated last' : oldTrack.cues[index].text,
    }]));
    const recovered = recoverMergedDualCaptionDrafts(payload,
      [{ source: restored.captions[0], translation: track.cues[0] }], track.id);
    assert.equal(recovered.remapped, true);
    assert.deepEqual(recovered.drafts, { 'c-0': {
      primaryText: original.captions.slice(0, -1).map(c => c.text).concat('Typed last').join(' '),
      translatedText: oldTrack.cues.slice(0, -1).map(c => c.text).concat('Translated last').join(' '),
    } });
  }
  assert.deepEqual(original, before);
});

test('decoder rejects oversized provenance counts before visiting entries and preserves existing caption count', () => {
  const project = fixture();
  const caption = project.captions[0];
  const fragments = project.captions.map(c => ({ captionId: c.id, primaryText: c.text, translations: {} }));
  const oversized = new Array(100_001);
  assert.throws(() => decodeCaption({ ...caption, mergeProvenance: { fragments: oversized } }, 0), /caption merge fragments.*supported project limit/i);
  assert.throws(() => decodeCaption({ ...caption, mergeProvenance: { fragments, previousJoins: oversized } }, 0), /caption previous joins.*supported project limit/i);
  assert.throws(() => decodeCaption({ ...caption, mergeProvenance: { fragments, previousJoins: [{ captionIds: oversized }] } }, 0), /caption previous join identities.*supported project limit/i);
  assert.throws(() => decodeVersionTwoProject({ ...project, captions: oversized }), /project captions.*supported project limit/i);
});

test('project join rejects a real translation text overflow without changing originals', () => {
  const project = fixture();
  project.captionTracks.translations[0].cues[0].text = 'x'.repeat(100_000);
  const before = structuredClone(project);
  assert.throws(() => mergeProjectCaptionPair(project, 'c-0', 'c-1'), /text.*supported project limit/i);
  assert.deepEqual(project, before);
});

// Execute the actual UI callbacks with the real domain function. This avoids native
// rendering while retaining the event-handler exception and mutation semantics.
const component = readFileSync(new URL('../src/components/editor/script-editor.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('script-editor.tsx', component, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const editor = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ScriptEditor');
const declarations = editor.body.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]);
for (const direction of ['previous', 'next']) for (const failure of ['capacity', 'identity']) {
  test(`UI Join ${direction}: ${failure} error stays inline and leaves the draft and focus unchanged`, () => {
    const project = fixture();
    if (failure === 'capacity') project.captions[0].text = 'x'.repeat(100_000);
    else project.captions[0].mergeProvenance = { fragments: [
      { captionId: 'c-0', primaryText: 'Part0', translations: {} },
      { captionId: 'c-1', primaryText: 'Retired', translations: {} },
    ] };
    const before = structuredClone(project.captions);
    let message, focused = false;
    const context = { Error, draftCaptions: project.captions, mergeCaptionScriptBlock,
      setBoundaryMessage: value => { message = value; }, focusCaption: () => { focused = true; } };
    const declaration = declarations.find(node => node.name.getText(ast) === (direction === 'previous' ? 'mergeWithPrevious' : 'mergeWithNext'));
    const callback = runInNewContext(ts.transpileModule(`(${declaration.initializer.getText(ast)})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText, context);
    assert.doesNotThrow(() => callback(project.captions[direction === 'previous' ? 1 : 0]));
    assert.match(message, failure === 'capacity' ? /limit|capacity/i : /identity|identit/i);
    assert.equal(focused, false);
    assert.deepEqual(project.captions, before);
  });
}
