import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import {
  CaptionGenerationCancelledError,
  CaptionGenerationStopError,
  createCaptionGenerationSession,
} from '../src/services/caption-generation-session.ts';

// Compile the actual exported services once; only platform/dependency boundaries are mocked.
const compiled = new Map(['timeline-audio-render', 'project-transcription', 'project-workflows'].map((name) => [
  name, ts.transpileModule(readFileSync(new URL('../src/services/' + name + '.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText,
]));
const restoreCode = ts.transpileModule(readFileSync(new URL('../src/lib/timeline-transcription.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const load = (code, mocks, allowUnused = false) => {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)((id) => {
    if (id in mocks) return mocks[id];
    if (allowUnused) return {};
    throw new Error('Unexpected dependency ' + id);
  }, module, module.exports);
  return module.exports;
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const nativeError = (code, message = code) => Object.assign(new Error(message), { code });

function harness(options = {}) {
  const files = new Set(), events = [], renders = [], saves = [];
  let nextFile = 0, transcriptions = 0, hashCalls = 0;
  class File {
    constructor(parent, name) { this.uri = parent + '/' + name + '-' + nextFile++; }
    get exists() { return files.has(this.uri); }
    delete() { events.push(['delete', this.uri]); files.delete(this.uri); }
  }
  const project = {
    id: 'preserved-52', sources: [{ id: 'source', uri: 'file:///source.mp4', durationMs: 77000 }],
    clips: Array.from({ length: 52 }, (_, index) => ({
      id: 'clip-' + index, sourceId: 'source', sourceStartMs: index * 1000, sourceEndMs: (index + 1) * 1000,
      playbackRate: 1,
    })),
    audioSources: [], audioClips: [],
    captions: Array.from({ length: 73 }, (_, index) => ({ id: 'accepted-' + index, text: 'accepted ' + index })),
    captionTracks: { translations: [{ id: 'accepted-translation', cues: [] }] },
    transcription: { sourceResults: { source: { modelId: 'old', words: [] } }, words: [] },
  };
  const accepted = JSON.stringify(project);
  const timeline = {
    buildClipTimeline: (clips) => {
      if (options.mappingError) throw options.mappingError;
      return clips.map((clip, index) => ({ clip, startMs: index * 1000, endMs: (index + 1) * 1000 }));
    },
    sourceTimeAt: (entry, time) => entry.clip.sourceStartMs + (time - entry.startMs),
    mapSourceWordsToTimeline: (_clips, words) => Object.values(words).flat(),
    anchorCaptionsToClips: (captions) => captions,
  };
  const restore = load(restoreCode, { '@/lib/video-timeline': timeline });
  const media = {
    renderTimelineAudio: (uri, plan) => {
      const work = deferred();
      renders.push({ uri, plan, work }); files.add(uri); events.push(['render', uri]);
      return work.promise.then((value) => { events.push(['settled', uri]); return value; },
        (error) => { events.push(['settled', uri]); throw error; });
    },
    sha256: async () => { hashCalls += 1; return 'a'.repeat(64); },
    cancelAudioExtraction: async () => { events.push(['stop']); return options.stop?.(); },
  };
  const audio = load(compiled.get('timeline-audio-render'), {
    'expo-file-system': { File, Paths: { cache: 'file:///cache' } },
    'caption-media': media,
    '@/lib/timeline-audio-render-plan': { buildTimelineAudioRenderPlan: () => ({ durationMs: 77000 }) },
    '@/lib/video-timeline': timeline,
    '@/lib/timeline-transcription': restore,
    '@/services/caption-generation-session': { CaptionGenerationCancelledError },
  });
  const cache = new Map();
  const transcription = load(compiled.get('project-transcription'), {
    '@/services/timeline-audio-render': audio,
    'caption-media': media,
    '@/lib/caption-grouping': {
      groupingOptionsForLanguage: () => ({}),
      groupTimelineWordsByClip: () => {
        if (options.groupingError) throw options.groupingError;
        return [{ id: 'new', text: 'new caption', startMs: 0, endMs: 100 }];
      },
    },
    '@/lib/caption-tracks': { synchronizeCaptionTracksAfterTranscription: () => project.captionTracks },
    '@/lib/caption-languages': { canonicalCaptionLanguageTag: (value) => value },
    '@/lib/source-transcription-fingerprint': {
      createSourceTranscriptionFingerprint: (digest) => ({ digest }),
      canReuseSourceTranscription: (result, model, fingerprint) =>
        result?.modelId === model && result.sourceFingerprint?.digest === fingerprint.digest,
    },
    '@/lib/video-timeline': timeline,
    '@/lib/primary-caption-timing': { canonicalizeSourceWords: (words) => words },
    '@/lib/caption-audio-route': { shouldTranscribeAudibleTimeline: () => options.timeline !== false },
    '@/services/transcription': { transcribeVideoLocally: async () => {
      transcriptions += 1;
      if (options.transcriptionError) throw options.transcriptionError;
      return { language: 'en', words: [{ id: 'word', text: 'new', startMs: 0, endMs: 100 }] };
    } },
    '@/services/timeline-transcription-cache': {
      readTimelineTranscription: async (id, fingerprint, model) => cache.get(id + fingerprint.digest + model),
      writeTimelineTranscription: async (id, fingerprint, result) =>
        cache.set(id + fingerprint.digest + result.modelId, result),
    },
  });
  const workflows = load(compiled.get('project-workflows'), {
    'caption-media': media,
    '@/services/caption-generation-session': { createCaptionGenerationSession },
    '@/services/project-transcription': transcription,
    '@/services/transcription': { CAPTION_TRANSCRIPTION_MODEL_ID: 'fast' },
    '@/services/database': { saveProject: async (value) => {
      if (options.saveError) throw options.saveError;
      saves.push(value);
    } },
  }, true);
  return { ...audio, ...transcription, ...workflows, project, files, events, renders, saves,
    assertPreserved() { assert.equal(JSON.stringify(project), accepted); assert.equal(project.captions.length, 73); },
    counts() { return { transcriptions, hashCalls }; },
    succeed(index = renders.length - 1) { renders[index].work.resolve({ sizeBytes: 100 }); },
  };
}

test('success restores original media ownership and cleans temporary audio after checkpointing', async () => {
  const h = harness();
  const running = h.generateAndSaveProjectCaptions(h.project);
  h.succeed();
  const result = await running;
  assert.equal(result.sources, h.project.sources);
  assert.equal(result.clips, h.project.clips);
  assert.equal(result.transcription.sourceResults, h.project.transcription.sourceResults);
  assert.equal(result.transcription.wordTiming, 'timeline');
  assert.equal(result.captions[0].text, 'new caption');
  assert.equal(h.saves.length, 2);
  assert.ok(h.saves.every((value) => value.sources === h.project.sources));
  assert.equal(h.files.size, 0);
  h.assertPreserved();
});

test('early cancellation at preparation progress never starts native work or saves', async () => {
  const h = harness();
  let cancellation;
  const running = h.generateAndSaveProjectCaptions(h.project, () => {
    cancellation ??= h.cancelProjectCaptionGeneration();
  });
  const result = running.then((value) => ({ value }), (error) => ({ error }));
  await cancellation;
  const starts = h.renders.length;
  if (starts) h.succeed(); // Drain the old behavior before asserting RED.
  assert.ok((await result).error instanceof CaptionGenerationCancelledError);
  assert.equal(starts, 0);
  assert.equal(h.saves.length, 0);
  h.assertPreserved();
});

test('already cancelled direct preparation never starts a renderer', async () => {
  const h = harness();
  let cancelled = false;
  const session = { isCancelled: () => cancelled, throwIfCancelled() {
    if (cancelled) throw new CaptionGenerationCancelledError();
  } };
  cancelled = true;
  const running = h.createTimelineTranscriptionSession(h.project, session);
  const result = running.then((value) => ({ value }), (error) => ({ error }));
  const starts = h.renders.length;
  if (starts) h.succeed();
  const outcome = await result;
  outcome.value?.dispose();
  assert.ok(outcome.error instanceof CaptionGenerationCancelledError);
  assert.equal(starts, 0);
});

for (const late of ['cancel-rejection', 'success']) {
  test('cancel acknowledgement waits for late native ' + late + ' before cleanup or retry', async () => {
    const h = harness();
    const running = h.generateAndSaveProjectCaptions(h.project);
    const outcome = running.then((value) => ({ value }), (error) => ({ error }));
    const cancellation = await h.cancelProjectCaptionGeneration();
    assert.equal(cancellation.status, 'stopping');
    let finished = false;
    void cancellation.finished.then(() => { finished = true; });
    await tick();
    assert.equal(finished, false);
    assert.equal(h.files.size, 1);
    await assert.rejects(h.generateAndSaveProjectCaptions(h.project), /already underway/);
    if (late === 'success') h.succeed();
    else h.renders[0].work.reject(nativeError('E_TIMELINE_AUDIO_CANCELLED'));
    assert.ok((await outcome).error instanceof CaptionGenerationCancelledError);
    await cancellation.finished;
    assert.equal(finished, true);
    assert.equal(h.files.size, 0);
    assert.deepEqual(h.counts(), { transcriptions: 0, hashCalls: 0 });
    assert.equal(h.saves.length, 0);
    const settled = h.events.findIndex(([kind]) => kind === 'settled');
    const deleted = h.events.findIndex(([kind]) => kind === 'delete');
    assert.ok(settled >= 0 && deleted > settled);
    h.assertPreserved();
    const retry = h.generateAndSaveProjectCaptions(h.project);
    h.succeed();
    assert.equal((await retry).captions[0].text, 'new caption');
    assert.equal(h.files.size, 0);
  });
}

for (const code of ['E_TIMELINE_AUDIO_RENDER', 'E_TIMELINE_AUDIO_PREPARE', 'E_TIMELINE_AUDIO_BUSY']) {
  for (const cancelled of [false, true]) {
    test('real ' + code + ' survives cancellation=' + cancelled + ' with its original cause', async () => {
      const h = harness();
      const failure = nativeError(code, 'real native failure');
      const running = h.generateAndSaveProjectCaptions(h.project);
      const rejection = assert.rejects(running, (error) =>
        !(error instanceof CaptionGenerationCancelledError) && error.cause === failure
        && /could not prepare the timeline audio/.test(error.message));
      if (cancelled) await h.cancelProjectCaptionGeneration();
      h.renders[0].work.reject(failure);
      await rejection;
      assert.equal(h.files.size, 0);
      assert.equal(h.saves.length, 0);
      h.assertPreserved();
    });
  }
}

test('native cancellation without a cancelled owner remains a real preparation failure', async () => {
  const h = harness(), failure = nativeError('E_TIMELINE_AUDIO_CANCELLED');
  const running = h.createTimelineTranscriptionSession(h.project);
  const rejection = assert.rejects(running, (error) =>
    !(error instanceof CaptionGenerationCancelledError) && error.cause === failure);
  h.renders[0].work.reject(failure);
  await rejection;
  assert.equal(h.files.size, 0);
});

test('no-audio diagnostics preserve the native cause even when cancellation races them', async () => {
  const h = harness(), failure = nativeError('E_TIMELINE_AUDIO_PREPARE', 'No audible audio is available on this timeline');
  const running = h.generateAndSaveProjectCaptions(h.project);
  const rejection = assert.rejects(running, (error) => /No audible audio/.test(error.message) && error.cause === failure);
  await h.cancelProjectCaptionGeneration();
  h.renders[0].work.reject(failure);
  await rejection;
  assert.equal(h.saves.length, 0);
  h.assertPreserved();
});

test('empty native output fails and is removed without changing accepted captions', async () => {
  const h = harness();
  const running = h.generateAndSaveProjectCaptions(h.project);
  const rejection = assert.rejects(running, /audible timeline could not be prepared|could not prepare the timeline audio/);
  h.renders[0].work.resolve({ sizeBytes: 0 });
  await rejection;
  assert.equal(h.files.size, 0);
  assert.equal(h.saves.length, 0);
  h.assertPreserved();
});

test('synthetic timeline mapping failure still releases the settled native output', async () => {
  const failure = new Error('timeline mapping failed'), h = harness({ mappingError: failure });
  const running = h.createTimelineTranscriptionSession(h.project);
  const rejection = assert.rejects(running, (error) => error === failure);
  h.succeed();
  await rejection;
  assert.equal(h.files.size, 0);
});

for (const stage of ['groupingError', 'transcriptionError', 'saveError']) {
  test(stage + ' keeps real errors, cleans audio, and leaves accepted captions unchanged', async () => {
    const failure = new Error(stage), h = harness({ [stage]: failure });
    const running = h.generateAndSaveProjectCaptions(h.project);
    const rejection = assert.rejects(running, (error) => error === failure);
    h.succeed();
    await rejection;
    assert.equal(h.files.size, 0);
    h.assertPreserved();
  });
}

test('a failed stop remains explicit and cannot release work before native termination', async () => {
  const stopFailure = new Error('native cancellation unavailable');
  const h = harness({ stop: async () => { throw stopFailure; } });
  const running = h.generateAndSaveProjectCaptions(h.project);
  const outcome = running.then((value) => ({ value }), (error) => ({ error }));
  const cancellation = await h.cancelProjectCaptionGeneration();
  assert.equal(cancellation.status, 'stop-failed');
  assert.deepEqual(cancellation.failures, [stopFailure]);
  await assert.rejects(h.generateAndSaveProjectCaptions(h.project), /already underway/);
  assert.equal(h.files.size, 1);
  h.renders[0].work.reject(nativeError('E_TIMELINE_AUDIO_CANCELLED'));
  const { error } = await outcome;
  assert.ok(error instanceof CaptionGenerationStopError);
  assert.deepEqual(error.failures, [stopFailure]);
  await cancellation.finished;
  assert.equal(h.files.size, 0);
  assert.equal(h.saves.length, 0);
  h.assertPreserved();
});

test('failed stop retry does not free the renderer; a successful second stop permits cancellation', async () => {
  let stops = 0;
  const h = harness({ stop: async () => { if (++stops === 1) throw new Error('retry stop'); } });
  const running = h.generateAndSaveProjectCaptions(h.project);
  const outcome = running.then((value) => ({ value }), (error) => ({ error }));
  assert.equal((await h.cancelProjectCaptionGeneration()).status, 'stop-failed');
  const cancellation = await h.cancelProjectCaptionGeneration();
  assert.equal(cancellation.status, 'stopping');
  await assert.rejects(h.generateAndSaveProjectCaptions(h.project), /already underway/);
  h.renders[0].work.reject(nativeError('E_TIMELINE_AUDIO_CANCELLED'));
  assert.ok((await outcome).error instanceof CaptionGenerationCancelledError);
  await cancellation.finished;
  assert.equal(stops, 2);
  assert.equal(h.files.size, 0);
});

test('real render failure remains visible alongside a failed stop result', async () => {
  const stopFailure = new Error('stop failure'), renderFailure = nativeError('E_TIMELINE_AUDIO_RENDER');
  const h = harness({ stop: async () => { throw stopFailure; } });
  const running = h.generateAndSaveProjectCaptions(h.project);
  const rejection = assert.rejects(running, (error) => error.cause === renderFailure);
  const cancellation = await h.cancelProjectCaptionGeneration();
  assert.equal(cancellation.status, 'stop-failed');
  assert.deepEqual(cancellation.failures, [stopFailure]);
  h.renders[0].work.reject(renderFailure);
  await rejection;
  await cancellation.finished;
  assert.equal(h.files.size, 0);
  h.assertPreserved();
});

test('the original source transcription route remains callable without native timeline rendering', async () => {
  const h = harness({ timeline: false });
  await h.generateAndSaveProjectCaptions(h.project);
  assert.equal(h.renders.length, 0);
  assert.equal(h.counts().transcriptions, 1);
  assert.equal(h.saves.length, 2);
});
