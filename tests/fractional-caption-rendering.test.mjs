import assert from 'node:assert/strict';
import test from 'node:test';
import { coalesceWhisperWords } from '../src/lib/whisper-words.ts';
import { alignCaptionTimedWords, captionPlaybackTimedWords } from '../src/lib/caption-text-breaks.ts';
import { buildTimelineRenderPlan, toNativeRenderPlan } from '../src/lib/export-render-plan.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';

const intervals = words => words.map(({ text, startMs, endMs }) => [text, startMs, endMs]);
const sourceWords = () => coalesceWhisperWords([{ text: ' a b', t0: 100, t1: 100.05 }]);
const expected = [['a', 1000, 1000.25], ['b', 1000.25, 1000.5]];

test('actual coalescer fractions survive alignment and playback without synthetic timing', () => {
  const words = sourceWords();
  assert.deepEqual(intervals(words), expected);
  assert.deepEqual(intervals(alignCaptionTimedWords(words, 'a b')), expected);
  assert.deepEqual(intervals(captionPlaybackTimedWords(words, 'a b', {
    id: 'cue', startMs: 1000, endMs: 1000.5,
  })), expected);
});

for (const [t0, t1, expected] of [
  [100, 100.05, [['a', 1000, 1000.25], ['b', 1000.25, 1000.5]]],
  [100.075, 100.125, [['a', 1000.75, 1001], ['b', 1001, 1001.25]]],
]) test(`actual coalescer fractions survive render plan and JSON export bridge (${t0})`, () => {
  const project = createCaptionProject({ id: 'fraction', name: 'Fraction', sources: [{
    id: 'source', uri: 'file:///fraction.mp4', storageMode: 'copied', displayName: 'Fraction',
    durationMs: 2000, width: 1920, height: 1080, rotation: 0, frameRate: 24,
  }] });
  project.transcription.words = coalesceWhisperWords([{ text: ' a b', t0, t1 }]);
  assert.deepEqual(intervals(project.transcription.words), expected);
  project.captions = [{ id: 'cue', text: 'a b', startMs: expected[0][1], endMs: expected[1][2],
    wordIds: project.transcription.words.map(word => word.id) }];
  const before = structuredClone(project);
  const wire = JSON.parse(JSON.stringify(toNativeRenderPlan(buildTimelineRenderPlan(project))));
  assert.deepEqual(intervals(wire.captions), [['a b', expected[0][1], expected[1][2]]]);
  assert.deepEqual(intervals(wire.captions[0].words), expected);
  assert.deepEqual(project, before);
});

test('packed words use precise shared boundaries only when rounded allocation loses support', () => {
  const cases = [
    ['a b', 1000, 1000.5, [['a', 1000, 1000.25], ['b', 1000.25, 1000.5]]],
    ['a b', 1000.25, 1001.75, [['a', 1000.25, 1001], ['b', 1001, 1001.75]]],
    ['中好', 1000, 1000.5, [['中', 1000, 1000.25], ['好', 1000.25, 1000.5]]],
    ['a bb ccc', 1000, 1200, [['a', 1000, 1033], ['bb', 1033, 1100], ['ccc', 1100, 1200]]],
    ['single', 1000.25, 1001.75, [['single', 1000.25, 1001.75]]],
  ];
  for (const [text, startMs, endMs, result] of cases) {
    assert.deepEqual(intervals(alignCaptionTimedWords([{ id: 'packed', text, startMs, endMs }], text)), result);
  }
});

test('integer native parent with unequal weights keeps every word through the actual export bridge', () => {
  const long = 'c'.repeat(99);
  const words = coalesceWhisperWords([{ text: ' a b ' + long, t0: 100, t1: 101 }]);
  const exact = [['a', 1000, 1000 + 10 / 101], ['b', 1000 + 10 / 101, 1000 + 20 / 101],
    [long, 1000 + 20 / 101, 1010]];
  assert.deepEqual(intervals(words), exact);
  const project = createCaptionProject({ id: 'integer-parent', name: 'Integer parent', sources: [{
    id: 'source', uri: 'file:///synthetic.mp4', storageMode: 'copied', displayName: 'Synthetic',
    durationMs: 2000, width: 1920, height: 1080, rotation: 0, frameRate: 24,
  }] });
  project.transcription.words = words;
  project.captions = [{ id: 'cue', text: 'a b ' + long, startMs: 1000, endMs: 1080,
    wordIds: words.map(word => word.id) }];
  const before = structuredClone(project);
  const wire = JSON.parse(JSON.stringify(toNativeRenderPlan(buildTimelineRenderPlan(project))));
  assert.equal(wire.captions.length, 1);
  assert.deepEqual(intervals(wire.captions[0].words), exact);
  assert.deepEqual(project, before);
});