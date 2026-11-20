import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { createSourceTranscriptionFingerprint } from '../src/lib/source-transcription-fingerprint.ts';
import { coalesceWhisperWords } from '../src/lib/whisper-words.ts';
import { alignWordsToSpeech } from '../src/lib/speech-alignment.ts';
import { createCaptionGenerationSession } from '../src/services/caption-generation-session.ts';

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL('../src/services/project-transcription.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const fingerprint = createSourceTranscriptionFingerprint('a'.repeat(64));

function harness(composed, { starts = [790, 795], cached, cancel = false, durationMs = 8000, end = 805, vadEnd = 810 } = {}) {
  const source = { id: 'source', uri: 'file:///source.mp4', displayName: 'Source', storageMode: 'linked', durationMs, width: 1080, height: 1920, rotation: 0 };
  const project = createCaptionProject({ id: 'boundary', name: 'Boundary', sources: [source] });
  if (composed) project.audioClips.push({ id: 'audio', muted: false, volume: 1 });
  project.captions = [{ id: 'saved', text: 'User saved text', startMs: 10, endMs: 100, wordIds: [] }];
  if (cached) project.transcription.sourceResults.source = cached;
  const before = structuredClone(project);
  const synthetic = createCaptionProject({ id: project.id, name: project.name, sources: [{ ...source, id: 'mix', uri: 'file:///mix.m4a' }] });
  const events = [], durations = [], checkpoints = [], writes = [], nativeInputs = [];
  const session = createCaptionGenerationSession(async () => {});
  const mocks = {
    'caption-media': { sha256: async () => 'a'.repeat(64) },
    '@/services/timeline-audio-render': { createTimelineTranscriptionSession: async () => {
      events.push('render');
      return { project: synthetic, restore: (value) => value, dispose: () => events.push('dispose') };
    } },
    '@/services/timeline-transcription-cache': {
      readTimelineTranscription: async (_id, _key, _model, duration) => { durations.push(['read', duration]); return cached; },
      writeTimelineTranscription: async (_id, _key, _value, duration) => { durations.push(['write', duration]); writes.push(structuredClone(_value)); events.push('write'); },
    },
    '@/services/transcription': { transcribeVideoLocally: async (options) => {
      events.push('transcribe'); durations.push(['transcribe', options.durationMs]);
      if (cancel) await session.cancel();
      const raw = coalesceWhisperWords(starts.map((t0, i) => ({ text: ` Token${i}`, t0, t1: end })));
      nativeInputs.push({ raw, before: structuredClone(raw) });
      return { language: 'en', words: alignWordsToSpeech(raw, [{ t0: 0, t1: vadEnd }], options.durationMs) };
    } },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((id) => mocks[id] ?? require('../src/' + id.slice(2) + '.ts'), module, module.exports);
  const run = () => session.run((context) => module.exports.generateProjectCaptions(project, 'fast', undefined, async candidate => { checkpoints.push(structuredClone(candidate)); events.push('checkpoint'); }, context));
  return { run, project, before, events, durations, checkpoints, writes, nativeInputs };
}

for (const composed of [false, true]) {
  test(`${composed ? 'composed' : 'source'} route preserves real overlap chain and passes logical duration`, async () => {
    const h = harness(composed);
    const generated = await h.run();
    assert.deepEqual(generated.transcription.words.map(({ text, startMs, endMs }) => [text, startMs, endMs]), [['Token0', 7900, 7950], ['Token1', 7950, 8000]]);
    assert.ok(h.durations.every(([, duration]) => duration === 8000));
    assert.ok(h.events.includes('checkpoint'));
    assert.equal(h.events.includes('dispose'), composed);
    assert.deepEqual(h.project, h.before);
  });

  for (const options of [{ starts: [790, 790] }, { starts: [795, 790] }, { cancel: true }, { starts: [1159, 1200], durationMs: 12000, end: 1208.7, vadEnd: 1203, cancel: true }]) {
    test(`${composed ? 'composed' : 'source'} failure/cancellation is atomic: ${JSON.stringify(options)}`, async () => {
      const h = harness(composed, options);
      await assert.rejects(h.run(), /Source word timing quality failure|cancel/i);
      assert.equal(h.events.includes('checkpoint'), false);
      assert.equal(h.events.includes('write'), false);
      assert.equal(h.events.includes('dispose'), composed);
      assert.deepEqual(h.project, h.before);
    });
  }

  test(`${composed ? 'composed' : 'source'} rejects reusable-looking cache outside D`, async () => {
    const h = harness(composed, { cached: { modelId: 'fast', sourceFingerprint: fingerprint, language: 'en', words: [{ id: 'bad', text: 'outside', startMs: 8010, endMs: 8030 }] } });
    await h.run();
    assert.ok(h.events.includes('transcribe'));
    assert.deepEqual(h.project, h.before);
  });

  for (const oldRevision of [false, true]) {
    test(`${composed ? 'composed' : 'source'} cache ${oldRevision ? 'misses old revision' : 'reuses current bounded words'}`, async () => {
      const h = harness(composed, { cached: {
        modelId: 'fast', sourceFingerprint: oldRevision ? createSourceTranscriptionFingerprint('a'.repeat(64), '1'.repeat(64)) : fingerprint,
        language: 'en', words: [{ id: 'tail', text: 'Cached', startMs: 7950, endMs: 8000 }],
      } });
      await h.run();
      assert.equal(h.events.includes('transcribe'), oldRevision);
      assert.deepEqual(h.project, h.before);
    });
  }
}


for (const composed of [false, true]) {
  for (const tailStart of [1200, 1201]) {
    test(`${composed ? 'composed' : 'source'} checkpoints only bounded prefix with EOF token at ${tailStart * 10}ms`, async () => {
      const h = harness(composed, { starts: [1159, 1199.975, tailStart],
        durationMs: 12000, end: 1208.7, vadEnd: 1203 });
      const generated = await h.run();
      const expected = [['Token0', 11590, 11999.75], ['Token1', 11999.75, 12000]];
      const intervals = words => words.map(({ text, startMs, endMs }) => [text, startMs, endMs]);
      assert.deepEqual(intervals(generated.transcription.words), expected);
      assert.equal(h.checkpoints.length, 1);
      assert.deepEqual(h.checkpoints[0], generated);
      for (const candidate of [generated, ...h.checkpoints]) {
        assert.deepEqual(intervals(candidate.transcription.words), expected);
        const results = Object.values(candidate.transcription.sourceResults);
        assert.equal(results.length, 1);
        assert.deepEqual(intervals(results[0].words), expected);
      }
      assert.equal(h.writes.length, Number(composed));
      for (const result of h.writes) assert.deepEqual(intervals(result.words), expected);
      assert.ok(h.durations.length > 0);
      assert.ok(h.durations.every(([, duration]) => duration === 12000));
      assert.equal(h.events.filter(e => e === 'dispose').length, Number(composed));
      assert.deepEqual(h.project, h.before);
      assert.equal(h.nativeInputs.length, 1);
      assert.deepEqual(h.nativeInputs[0].raw, h.nativeInputs[0].before);
    });
  }
}
