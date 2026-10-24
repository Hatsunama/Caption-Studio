import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import * as schema from '../src/lib/project-schema.ts';
import { decodePersistedProject } from '../src/lib/project-codec.ts';
import { mergeCaptionScriptBlock } from '../src/lib/caption-script.ts';
import { recoverMergedDualCaptionDrafts } from '../src/lib/dual-caption-drafts.ts';
import { MAX_PROJECT_SNAPSHOT_LENGTH } from '../src/lib/project-capacity.ts';

// Compile the complete real modules; replace only the serializer with a
// delegating spy. No copied merge algorithm or source-text assertions.
const require = createRequire(import.meta.url);
const compiled = new Map(['caption-merge', 'project-editor', 'video-timeline'].map(name => {
  const url = new URL(`../src/lib/${name}.ts`, import.meta.url);
  return [name, ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText];
}));
function harness() {
  const calls = [];
  const cache = new Map();
  function load(name) {
    if (cache.has(name)) return cache.get(name);
    const exports = {};
    cache.set(name, exports);
    runInNewContext(compiled.get(name), { exports, require: id => {
      if (id === '@/lib/project-schema') return { ...schema, serializeProjectSnapshot: candidate => {
        calls.push(candidate);
        return schema.serializeProjectSnapshot(candidate);
      } };
      const local = id.replace('@/lib/', '');
      return compiled.has(local) ? load(local) : require(id);
    } });
    return exports;
  }
  return { calls, merge: load('caption-merge'), editor: load('project-editor'), timeline: load('video-timeline') };
}
const plain = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const project = createCaptionProject({ id: 'validation-owner', name: 'Validation owner', sources: [{
    id: 'source', uri: 'file:///source.mp4', storageMode: 'copied', displayName: 'source.mp4',
    durationMs: 20_000, width: 1080, height: 1920, rotation: 0,
  }] });
  project.captions = Array.from({ length: 8 }, (_, index) => {
    const startMs = Math.floor(index / 2) * 2000 + (index % 2 ? 40 : 0);
    const endMs = startMs + (index % 2 ? 500 : 40);
    return { id: `c-${index}`, text: `Part${index}`, startMs, endMs, wordIds: [`w-${index}`],
      textMode: 'automatic', timingMode: 'source', timelineVisible: true,
      sourceAnchor: { clipId: project.clips[0].id, sourceStartMs: startMs, sourceEndMs: endMs, wordIds: [`w-${index}`] },
      styleOverride: { textColor: '#FF0000' } };
  });
  project.transcription.words = project.captions.map(caption => ({ id: caption.wordIds[0], text: caption.text,
    startMs: caption.startMs, endMs: caption.endMs }));
  project.captionTracks = { schemaVersion: 1, primaryTrackId: 'captions', translations: ['fr', 'de'].map(id => ({
    id, kind: 'translation', sourceTrackId: 'captions', sourceLanguageTag: 'en', languageTag: id,
    displayName: id, visible: true, origin: 'manual', provider: { id: 'manual' },
    cues: project.captions.map(caption => ({ id: `${id}-${caption.id}`, sourceCaptionId: caption.id,
      sourceTextSnapshot: caption.text, text: `${id}${caption.id}`, status: 'reviewed', reviewed: true,
      startMs: caption.startMs, endMs: caption.endMs, styleOverride: { textColor: '#00FF00' } })),
  })), independentTimingOrigins: Object.fromEntries(['fr', 'de'].flatMap(id => project.captions.map(c => [`${id}-${c.id}`, 0]))) };
  // Start from a reopened project so codec word-identity migration has already
  // happened before asserting exact identity preservation on the next reopen.
  return decodePersistedProject(schema.serializeProjectSnapshot(project));
}
function draftFor(project) {
  let draft = project.captions.filter(c => c.timelineVisible !== false);
  for (const id of ['c-1', 'c-3', 'c-5', 'c-7']) {
    const joined = mergeCaptionScriptBlock(draft, id, 'previous');
    assert.ok(joined);
    draft = joined.captions;
  }
  return draft;
}
function roundTrip(project) {
  return decodePersistedProject(schema.serializeProjectSnapshot(project));
}
function assertRetained(original, candidate) {
  const restored = roundTrip(candidate);
  assert.equal(restored.captions.filter(c => c.timelineVisible !== false).length, 4);
  assert.deepEqual(restored.transcription.words, original.transcription.words);
  const fragments = restored.captions.flatMap(c => c.mergeProvenance?.fragments ?? []);
  assert.deepEqual(fragments.map(f => f.captionId).sort(), original.captions.filter(c => c.timelineVisible !== false).map(c => c.id).sort());
  for (const fragment of fragments) {
    const old = original.captions.find(c => c.id === fragment.captionId);
    assert.deepEqual(plain(fragment.primary), plain(old));
    for (const track of original.captionTracks.translations) {
      assert.deepEqual(plain(fragment.translationCues[track.id]), plain(track.cues.find(c => c.sourceCaptionId === old.id)));
      assert.equal(fragment.translationOrigins[track.id], 0);
    }
  }
  for (const track of restored.captionTracks.translations) {
    const originals = original.captionTracks.translations.find(t => t.id === track.id);
    for (const cue of track.cues.filter(c => c.sourceCaptionId.startsWith('c-'))) {
      const source = restored.captions.find(c => c.id === cue.sourceCaptionId);
      assert.equal(cue.text, source.mergeProvenance.fragments.map(f => f.translationCues[track.id].text).join(' '));
      assert.equal(restored.captionTracks.independentTimingOrigins[cue.id], 0);
      const payload = Object.fromEntries(source.mergeProvenance.fragments.map(f => [f.captionId, {
        primaryText: f.primaryText, translatedText: originals.cues.find(c => c.sourceCaptionId === f.captionId).text,
      }]));
      const recovery = recoverMergedDualCaptionDrafts(payload, [{ source, translation: cue }], track.id);
      assert.equal(recovery.remapped, true);
      assert.equal(recovery.drafts[source.id].translatedText, cue.text);
    }
  }
}

for (const operation of ['manual', 'automatic', 'timeline']) test(`${operation}: four valid pairs own exactly one full validation and persist all originals`, () => {
  const h = harness(), project = fixture(), before = structuredClone(project);
  const result = operation === 'manual' ? h.editor.replaceVisibleCaptionScript(project, draftFor(project))
    : operation === 'timeline' ? h.timeline.completeVideoTimelineEdit(project) : h.merge.absorbShortCaptionCues(project);
  assert.equal(h.calls.length, 1, `${operation}: four pairs must validate only their final candidate`);
  assertRetained(project, result);
  assert.deepEqual(project, before);
});

test('applyCaptionMergeDraft directly validates its final draft text once', () => {
  const h = harness(), project = fixture(), draft = draftFor(project);
  draft[0] = { ...draft[0], text: 'Final edited primary' };
  const result = h.merge.applyCaptionMergeDraft(project, draft);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].captions[0].text, 'Final edited primary');
  const restored = roundTrip({ ...project, ...result });
  assert.equal(restored.captions[0].text, 'Final edited primary');
  assert.deepEqual(restored.transcription.words, project.transcription.words);
  const source = restored.captions[0], track = restored.captionTracks.translations[0];
  const payload = Object.fromEntries(source.mergeProvenance.fragments.map(f => [f.captionId, {
    primaryText: f.primaryText, translatedText: f.translations[track.id],
  }]));
  assert.throws(() => recoverMergedDualCaptionDrafts(payload, [{ source, translation: track.cues[0] }], track.id), /changed.*preserved/i);
});

for (const limit of ['text', 'wordIds']) test(`direct manual batch rejects final draft ${limit} overflow without mutating input`, () => {
  const h = harness(), project = fixture(), draft = draftFor(project);
  if (limit === 'text') draft[0].text = 'x'.repeat(100_001);
  else draft[0].wordIds = Array.from({ length: 10_001 }, (_, index) => `word-${index}`);
  const before = structuredClone(project), draftBefore = structuredClone(draft);
  assert.throws(() => h.merge.applyCaptionMergeDraft(project, draft), /supported project limit/i);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(project, before);
  assert.deepEqual(draft, draftBefore);
});

test('automatic grouping retains its local text budget', () => {
  const h = harness(), project = fixture();
  project.captions[0].text = 'x'.repeat(34);
  const result = h.merge.absorbShortCaptionCues(project);
  assert.equal(h.calls.length, 1);
  assert.ok(result.captions.some(c => c.id === 'c-1'));
  assert.equal(roundTrip(result).captions.length, 5);
});

for (const automatic of [false, true]) test(`direct pair automatic=${automatic}: success and capacity failure each validate once`, () => {
  const h = harness(), project = fixture();
  const result = h.merge.mergeProjectCaptionPair(project, 'c-0', 'c-1', automatic);
  assert.equal(h.calls.length, 1);
  assert.equal(roundTrip(result).captions.length, 7);
  project.captionTracks.translations[0].cues[0].text = 'x'.repeat(100_000);
  const before = structuredClone(project);
  h.calls.length = 0;
  if (automatic) assert.equal(h.merge.mergeProjectCaptionPair(project, 'c-0', 'c-1', true), null);
  else assert.throws(() => h.merge.mergeProjectCaptionPair(project, 'c-0', 'c-1'), /text.*limit/i);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(project, before);
});

for (const operation of ['manual', 'automatic', 'timeline']) test(`${operation}: last pair overflow rolls back the whole batch`, () => {
  const h = harness(), project = fixture();
  project.captionTracks.translations[1].cues[6].text = 'x'.repeat(100_000);
  schema.serializeProjectSnapshot(project);
  const before = structuredClone(project), draft = draftFor(project), draftBefore = structuredClone(draft);
  if (operation === 'manual') assert.throws(() => h.editor.replaceVisibleCaptionScript(project, draft), /text.*limit/i);
  else {
    const result = operation === 'timeline' ? h.timeline.completeVideoTimelineEdit(project) : h.merge.absorbShortCaptionCues(project);
    assert.equal(result, project);
    assert.deepEqual(roundTrip(result).transcription.words, project.transcription.words);
    assert.equal(roundTrip(result).captions.length, 8);
  }
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].captions.length, 4);
  assert.deepEqual(project, before);
  assert.deepEqual(draft, draftBefore);
});

test('manual batch preserves independent translation timings, origins and intermediate joins', () => {
  const h = harness(), project = fixture();
  for (const track of project.captionTracks.translations) for (const [index, cue] of track.cues.entries()) {
    cue.startMs += 5; cue.endMs += 5;
    project.captionTracks.independentTimingOrigins[cue.id] = index + 10;
  }
  let draft = project.captions;
  for (const id of ['c-1', 'c-2', 'c-3']) draft = mergeCaptionScriptBlock(draft, id, 'previous').captions;
  const result = h.editor.replaceVisibleCaptionScript(project, draft);
  assert.equal(h.calls.length, 1);
  const restored = roundTrip(result), history = restored.captions[0].mergeProvenance;
  assert.equal(history.fragments.length, 4);
  assert.equal(history.previousJoins.length, 2);
  for (const track of project.captionTracks.translations) {
    assert.equal(history.fragments[3].translationOrigins[track.id], 13);
    assert.deepEqual(plain(history.fragments[3].translationCues[track.id]), plain(track.cues[3]));
    assert.equal(restored.captionTracks.independentTimingOrigins[track.cues[0].id], 10);
  }
});

test('no-op and incompatible automatic calls do not validate or mutate', () => {
  const h = harness(), project = fixture();
  for (const caption of project.captions) caption.timingMode = 'timeline';
  const before = structuredClone(project);
  assert.equal(h.merge.absorbShortCaptionCues(project), project);
  assert.equal(h.merge.mergeProjectCaptionPair(project, 'c-0', 'c-7'), null);
  assert.equal(h.merge.mergeProjectCaptionPair(project, 'c-0', 'c-1', true), null);
  assert.equal(h.editor.replaceVisibleCaptionScript(project, project.captions), project);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(project, before);
});

for (const difference of ['primary-style', 'second-track-style', 'origin', 'timing']) test(`automatic compatibility retains ${difference} boundaries`, () => {
  const h = harness(), project = fixture();
  if (difference === 'primary-style') project.captions[1].styleOverride.textColor = '#0000FF';
  const cue = project.captionTracks.translations[1].cues[1];
  if (difference === 'second-track-style') cue.styleOverride.textColor = '#0000FF';
  if (difference === 'origin') project.captionTracks.independentTimingOrigins[cue.id] = 1;
  if (difference === 'timing') cue.startMs += 1;
  const result = h.merge.absorbShortCaptionCues(project);
  assert.equal(h.calls.length, 1);
  assert.ok(result.captions.some(c => c.id === 'c-1'));
  assert.equal(roundTrip(result).captions.length, 5);
});

test('real 64 Mi snapshot overflow retains hidden captions and atomically rejects manual and automatic batches', () => {
  const h = harness(), project = fixture();
  const track = project.captionTracks.translations[0];
  for (let index = 0; index < 340; index++) {
    const id = `hidden-${index}`;
    project.captions.push({ id, text: 'x'.repeat(97_000), startMs: 10_000, endMs: 11_000, wordIds: [],
      timingMode: 'timeline', textMode: 'manual', timelineVisible: false });
    track.cues.push({ id: `fr-${id}`, sourceCaptionId: id, sourceTextSnapshot: '', text: 'y'.repeat(97_000),
      status: 'reviewed', reviewed: true });
  }
  // Approach the real ceiling with individually valid text fields, including
  // every track's synchronization result in the normal save path.
  let remaining = MAX_PROJECT_SNAPSHOT_LENGTH - 500 - JSON.stringify(project).length;
  assert.ok(remaining > 0);
  for (const caption of project.captions.filter(c => c.id.startsWith('hidden-'))) {
    const add = Math.min(3000, remaining);
    caption.text += 'z'.repeat(add); remaining -= add;
    const cue = track.cues.find(c => c.sourceCaptionId === caption.id);
    const translatedAdd = Math.min(3000, remaining);
    cue.text += 'z'.repeat(translatedAdd); remaining -= translatedAdd;
  }
  assert.equal(remaining, 0);
  schema.serializeProjectSnapshot(project);
  const snapshot = JSON.stringify(project), draft = draftFor(project), draftBefore = plain(draft);
  assert.equal(h.merge.absorbShortCaptionCues(project), project);
  assert.equal(h.calls.length, 1);
  h.calls.length = 0;
  assert.throws(() => h.editor.replaceVisibleCaptionScript(project, draft), /size limit/i);
  assert.equal(h.calls.length, 1);
  assert.equal(JSON.stringify(project), snapshot);
  assert.deepEqual(plain(draft), draftBefore);
  assert.equal(roundTrip(project).captions.length, 348);
});
