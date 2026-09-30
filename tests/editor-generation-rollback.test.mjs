import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

import { createCaptionProject } from '../src/lib/project-factory.ts';
import { decodeVersionTwoProject, serializeProjectSnapshot } from '../src/lib/project-schema.ts';
import * as tracks from '../src/lib/caption-tracks.ts';
import * as grouping from '../src/lib/caption-grouping.ts';
import * as languages from '../src/lib/caption-languages.ts';
import * as fingerprints from '../src/lib/source-transcription-fingerprint.ts';
import * as timeline from '../src/lib/video-timeline.ts';
import * as timing from '../src/lib/primary-caption-timing.ts';
import * as audioRoute from '../src/lib/caption-audio-route.ts';
import { createEditorSession } from '../src/services/editor-session.ts';
import { createCaptionGenerationSession } from '../src/services/caption-generation-session.ts';

const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const transcriptionSource = readFileSync(new URL('../src/services/project-transcription.ts', import.meta.url), 'utf8');
const workflowSource = readFileSync(new URL('../src/services/project-workflows.ts', import.meta.url), 'utf8');
function load(source, dependencies, allowUnusedImports = false) {
  const exports = {};
  runInNewContext(compile(source), { exports, Date, Error, console,
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      if (allowUnusedImports) return {};
      throw new Error(`Unexpected exercised dependency: ${name}`);
    },
  });
  return exports;
}

// Mutation mode deliberately removes revision retry from the production
// checkpoint loop. It never edits source and must make the concurrent test red.
let sessionFactory = createEditorSession;
if (process.env.CAPTION_GENERATION_ROLLBACK_MUTANT === 'no-revision-retry') {
  const source = readFileSync(new URL('../src/services/editor-session.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('editor-session.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const transformed = ts.transform(ast, [(context) => {
    const visit = (node) => {
      if (ts.isIfStatement(node) && ts.isBinaryExpression(node.expression)
        && node.expression.left.getText(ast) === 'started' && node.expression.right.getText(ast) === 'revision'
        && ts.isReturnStatement(node.thenStatement)) return node.thenStatement;
      return ts.visitEachChild(node, visit, context);
    };
    return (node) => ts.visitNode(node, visit);
  }]);
  sessionFactory = load(ts.createPrinter().printFile(transformed.transformed[0]), {}).createEditorSession;
  transformed.dispose();
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const project = createCaptionProject({ id: 'generation-rollback', name: 'Saved bilingual edits',
    sources: ['one', 'two'].map((id) => ({ id, uri: `file:///${id}.mp4`, storageMode: 'copied',
      displayName: `${id}.mp4`, durationMs: 1000, width: 1080, height: 1920, rotation: 0 })),
  });
  project.captions = [{ id: 'saved-cue', text: 'Original saved text', textMode: 'manual', startMs: 0, endMs: 900, wordIds: [] }];
  return tracks.createTranslationCaptionTrack(project, { id: 'fr', languageTag: 'fr', sourceLanguageTag: 'en',
    displayName: 'French', translations: { 'saved-cue': 'Original saved secondary text' } });
}
const edited = (project, primaryText, translatedText) => tracks.updatePairedCaptionTexts(project, [{
  trackId: 'fr', sourceCaptionId: 'saved-cue', primaryText, translatedText,
}]);
function assertTexts(project, primaryText, secondaryText) {
  assert.equal(project.captions.find((cue) => cue.id === 'saved-cue')?.text, primaryText);
  assert.equal(project.captionTracks.translations.find((track) => track.id === 'fr')?.cues.find((cue) => cue.sourceCaptionId === 'saved-cue')?.text, secondaryText);
}

async function mount(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'caption-generation-rollback-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('caption-generation-rollback-'));
    await rm(directory, { recursive: true, force: true });
  });
  const path = join(directory, 'project.json');
  const writes = [], transcriptions = [];
  let published = fixture();
  const reopen = async () => decodeVersionTwoProject(JSON.parse(await readFile(path, 'utf8')));
  const saveProject = async (project) => {
    // Capture before yielding: a delayed write really writes its old snapshot.
    const serialized = serializeProjectSnapshot(project);
    writes.push(JSON.parse(serialized));
    await options.beforeWrite?.(project);
    await writeFile(path, serialized, 'utf8');
    return project;
  };
  await saveProject(published);
  const transcribeVideoLocally = async (request) => {
    transcriptions.push(request.videoUri);
    await options.transcribe?.(request, transcriptions.length);
    return { language: 'en', words: [{ id: 'word', text: 'Generated words.', startMs: 100, endMs: 600 }] };
  };
  const transcription = load(transcriptionSource, {
    // Native rendering is a boundary double. Keep two prepared sources so
    // partial completion is deterministic; execute the real restore wrapper.
    '@/services/timeline-audio-render': { createTimelineTranscriptionSession: async (project) => ({
      project, restore: (candidate) => candidate, dispose() {},
    }) },
    'caption-media': { sha256: async (uri) => (uri.includes('one') ? 'a' : 'b').repeat(64) },
    '@/lib/caption-grouping': grouping, '@/lib/caption-tracks': tracks, '@/lib/caption-languages': languages,
    '@/lib/source-transcription-fingerprint': fingerprints, '@/lib/video-timeline': timeline,
    '@/lib/primary-caption-timing': timing, '@/lib/caption-audio-route': audioRoute,
    '@/services/transcription': { transcribeVideoLocally }, '@/services/timeline-transcription-cache': {
      readTimelineTranscription: async () => undefined,
      writeTimelineTranscription: async () => {},
    },
  });
  const workflow = load(workflowSource, {
    '@/services/project-transcription': transcription, '@/services/database': { saveProject },
    '@/services/transcription': { CAPTION_TRANSCRIPTION_MODEL_ID: 'fast' },
    '@/services/caption-generation-session': { createCaptionGenerationSession },
    'caption-media': { cancelAudioExtraction: async () => {} },
  }, true);
  const session = sessionFactory(published, (next) => { published = next; }, saveProject);
  const accept = async (primary, secondary) => {
    const receipt = await session.commit((before) => edited(before, primary, secondary));
    assert.equal(session.isCurrent(receipt), true, 'manual edit has a durable accepted receipt');
    assertTexts(await reopen(), primary, secondary);
    return receipt.project;
  };
  return { session, accept, reopen, saveProject, writes, transcriptions,
    get published() { return published; },
    generate: () => session.commit((before) => workflow.generateAndSaveProjectCaptions(before), true),
  };
}

test('partial source generation then failure keeps accepted original and secondary text on disk', async (t) => {
  const reachedSecondSource = deferred(), failSecondSource = deferred();
  const failure = new Error('second source transcription failed');
  const h = await mount(t, { transcribe: async (_request, index) => {
    if (index === 2) { reachedSecondSource.resolve(); await failSecondSource.promise; throw failure; }
  } });
  const accepted = await h.accept('Accepted original text', 'Accepted secondary text');
  const generation = h.generate();
  const rejection = assert.rejects(generation, (error) => error === failure);
  await reachedSecondSource.promise;
  assert.equal(h.transcriptions.length, 2, 'first source completed before the second failed');
  assertTexts(await h.reopen(), 'Accepted original text', 'Accepted secondary text');
  failSecondSource.resolve(); await rejection;
  assertTexts(await h.reopen(), 'Accepted original text', 'Accepted secondary text');
  assert.deepEqual((await h.reopen()).captionTracks, decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(accepted))).captionTracks);
  assert.equal(h.session.current(), accepted); assert.equal(h.published, accepted);
});

test('generated output checkpoint followed by final save failure rolls disk back to accepted bilingual edits', async (t) => {
  let generatedWrites = 0;
  const failure = new Error('final generated project save failed');
  const h = await mount(t, { beforeWrite: async (project) => {
    if (project.captions.some((cue) => cue.text.includes('Generated words.')) && ++generatedWrites === 2) throw failure;
  } });
  const accepted = await h.accept('Accepted original text', 'Accepted secondary text');
  await assert.rejects(h.generate(), (error) => error === failure);
  assert.equal(generatedWrites, 2, 'completed checkpoint reached disk before the failing final write');
  assert.ok(h.writes.some((project) => project.captions.some((cue) => cue.text.includes('Generated words.'))));
  assertTexts(await h.reopen(), 'Accepted original text', 'Accepted secondary text');
  assert.deepEqual(await h.reopen(), decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(accepted))));
  assert.equal(h.session.current(), accepted); assert.equal(h.published, accepted);
});

test('accepted concurrent edit during rollback forces a latest-revision checkpoint instead of overwriting it', async (t) => {
  const rollbackStarted = deferred(), finishOldRollbackWrite = deferred();
  const failure = new Error('generation failed after partial transcription');
  let rollingBack = false, blockedOnce = false;
  const h = await mount(t, {
    transcribe: async (_request, index) => { if (index === 2) { rollingBack = true; throw failure; } },
    beforeWrite: async (project) => {
      if (rollingBack && !blockedOnce && project.captions[0]?.text === 'Earlier accepted original') {
        blockedOnce = true; rollbackStarted.resolve(); await finishOldRollbackWrite.promise;
      }
    },
  });
  await h.accept('Earlier accepted original', 'Earlier accepted secondary');
  const generation = h.generate();
  const rejection = assert.rejects(generation, (error) => error === failure);
  await rollbackStarted.promise;
  // Exercise a durable publication outside the queued generation, arriving
  // while checkpointLatest is awaiting a write of its previous revision.
  const concurrent = edited(h.session.current(), 'Concurrent accepted original', 'Concurrent accepted secondary');
  await h.saveProject(concurrent); h.session.update(concurrent);
  assertTexts(await h.reopen(), 'Concurrent accepted original', 'Concurrent accepted secondary');
  finishOldRollbackWrite.resolve(); await rejection;
  assertTexts(await h.reopen(), 'Concurrent accepted original', 'Concurrent accepted secondary');
  assert.equal(h.session.current(), concurrent); assert.equal(h.published, concurrent);
  assert.equal(h.writes.at(-1).captions[0].text, 'Concurrent accepted original');
});

test('queued accepted bilingual save after failed generation survives subsequent checkpoint and reopen', async (t) => {
  const secondSource = deferred(), failSecondSource = deferred();
  const failure = new Error('partial generation failed');
  const h = await mount(t, { transcribe: async (_request, index) => {
    if (index === 2) { secondSource.resolve(); await failSecondSource.promise; throw failure; }
  } });
  await h.accept('Earlier accepted original', 'Earlier accepted secondary');
  const generation = h.generate();
  const rejection = assert.rejects(generation, (error) => error === failure);
  await secondSource.promise;
  const queuedEdit = h.accept('Queued accepted original', 'Queued accepted secondary');
  failSecondSource.resolve(); await rejection; await queuedEdit;
  await h.session.checkpoint();
  assertTexts(await h.reopen(), 'Queued accepted original', 'Queued accepted secondary');
  assertTexts(h.published, 'Queued accepted original', 'Queued accepted secondary');
});
