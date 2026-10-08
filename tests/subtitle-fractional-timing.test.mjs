import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

import { createEnglishChineseCaptionTrack } from '../src/lib/caption-tracks.ts';
import { exportCaptionPairs } from '../src/lib/export-caption-pairs.ts';
import { buildTimelineRenderPlan, toNativeRenderPlan } from '../src/lib/export-render-plan.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { serializeAss, serializeSrt, visibleCaptions } from '../src/lib/subtitle-export.ts';
import { totalClipDuration, setClipPlaybackRate } from '../src/lib/video-timeline.ts';

function fixture(startMs = 1000.6, endMs = 2000.4) {
  const project = createCaptionProject({
    id: 'fractional-export', name: 'Fractional export',
    sources: [{ id: 'video', uri: 'file:///video.mp4', storageMode: 'linked',
      displayName: 'video.mp4', durationMs: 4000, width: 1080, height: 1920, rotation: 0 }],
  });
  project.captions = [{ id: 'c1', text: 'Primary', startMs, endMs, wordIds: [],
    timingMode: 'timeline', textMode: 'manual', timelineVisible: true }];
  return createEnglishChineseCaptionTrack(project, { c1: 'Secondary' });
}

function cues(project) {
  const srt = serializeSrt(project);
  if (!srt) return [];
  return srt.trimEnd().split('\n\n').map((block) => {
    const [, timing, ...text] = block.split('\n');
    return { timing, text: text.join('\n') };
  });
}

function assTimes(project) {
  return serializeAss(project).split('\n').filter((line) => line.startsWith('Dialogue:'))
    .map((line) => line.split(',').slice(1, 3));
}

function planTimes(project) {
  return toNativeRenderPlan(buildTimelineRenderPlan(project)).captions
    .map(({ startMs, endMs }) => [startMs, endMs]);
}

test('identical fractional dual timing produces one SRT event without changing the project', () => {
  const project = fixture();
  const before = structuredClone(project);
  assert.deepEqual(cues(project), [
    { timing: '00:00:01,001 --> 00:00:02,000', text: 'Primary\nSecondary' },
  ]);
  assert.deepEqual(project, before);
});

test('export projections preserve fractional precision until format quantization', () => {
  const project = fixture();
  assert.deepEqual(exportCaptionPairs(project).map(({ startMs, endMs }) => [startMs, endMs]),
    [[1000.6, 2000.4]]);
  assert.deepEqual(visibleCaptions(project).map(({ startMs, endMs }) => [startMs, endMs]),
    [[1000.6, 2000.4]]);
});

test('independent fractional timing stays as two SRT events', () => {
  const project = fixture();
  Object.assign(project.captionTracks.translations[0].cues[0], { startMs: 1100.6, endMs: 1900.4 });
  assert.deepEqual(cues(project), [
    { timing: '00:00:01,001 --> 00:00:02,000', text: 'Primary' },
    { timing: '00:00:01,101 --> 00:00:01,900', text: 'Secondary' },
  ]);
  assert.deepEqual(planTimes(project), [[1001, 2000], [1101, 1900]]);
  assert.deepEqual(assTimes(project), [['0:00:01.00', '0:00:02.00'], ['0:00:01.10', '0:00:01.90']]);
});

test('independent timings in the same millisecond bin remain separate events', () => {
  const project = fixture();
  Object.assign(project.captionTracks.translations[0].cues[0], { startMs: 1000.7, endMs: 2000.3 });
  assert.deepEqual(cues(project), [
    { timing: '00:00:01,001 --> 00:00:02,000', text: 'Primary' },
    { timing: '00:00:01,001 --> 00:00:02,000', text: 'Secondary' },
  ]);
});

test('clipping retains fractions and applies identical zero and duration bounds', () => {
  for (const [startMs, endMs, clipped, srt, ass, plan] of [
    [-10.6, 2000.4, [0, 2000.4], '00:00:00,000 --> 00:00:02,000',
      ['0:00:00.00', '0:00:02.00'], [0, 2000]],
    [1000.6, 4000.4, [1000.6, 4000], '00:00:01,001 --> 00:00:04,000',
      ['0:00:01.00', '0:00:04.00'], [1001, 4000]],
  ]) {
    const project = fixture(startMs, endMs);
    const before = structuredClone(project);
    assert.deepEqual(exportCaptionPairs(project).map((pair) => [pair.startMs, pair.endMs]), [clipped]);
    assert.deepEqual(cues(project), [{ timing: srt, text: 'Primary\nSecondary' }]);
    assert.deepEqual(assTimes(project), [ass, ass]);
    assert.deepEqual(planTimes(project), [plan, plan]);
    assert.deepEqual(project, before);
  }
});

test('fully out of bounds and nonfinite secondary intervals are omitted', () => {
  for (const [startMs, endMs] of [[-10.6, -0.4], [4000.1, 4100.4], [NaN, 2000.4],
    [1000.6, Infinity], [2000.4, 1000.6]]) {
    const project = fixture();
    Object.assign(project.captionTracks.translations[0].cues[0], { startMs, endMs });
    assert.deepEqual(exportCaptionPairs(project), []);
    assert.equal(cues(project).length, 1);
    assert.equal(assTimes(project).length, 1);
    assert.equal(planTimes(project).length, 1);
  }
});

test('ASS quantizes original fractional timing directly and MP4 rounds both tracks equally', () => {
  const project = fixture(1004.6, 2004.4);
  assert.deepEqual(assTimes(project), [
    ['0:00:01.00', '0:00:02.00'], ['0:00:01.00', '0:00:02.00'],
  ]);
  assert.deepEqual(planTimes(project), [[1005, 2004], [1005, 2004]]);
  assert.deepEqual(cues(project), [
    { timing: '00:00:01,005 --> 00:00:02,004', text: 'Primary\nSecondary' },
  ]);
});

test('playback speed derived fractions remain aligned across SRT, ASS, and MP4', () => {
  const original = fixture(1001, 2002);
  const project = setClipPlaybackRate(original, original.clips[0].id, 1.5);
  const caption = project.captions[0];
  assert.ok(!Number.isInteger(caption.startMs));
  assert.deepEqual(exportCaptionPairs(project).map((pair) => [pair.startMs, pair.endMs]),
    [[caption.startMs, caption.endMs]]);
  assert.deepEqual(cues(project), [
    { timing: '00:00:00,667 --> 00:00:01,335', text: 'Primary\nSecondary' },
  ]);
  assert.deepEqual(assTimes(project), [
    ['0:00:00.67', '0:00:01.33'], ['0:00:00.67', '0:00:01.33'],
  ]);
  assert.deepEqual(planTimes(project), [[667, 1335], [667, 1335]]);
});

test('fractional cues rounding to the output end do not extend past the format bound', () => {
  const project = fixture(3999.8, 4000.4);
  assert.deepEqual(exportCaptionPairs(project).map((pair) => [pair.startMs, pair.endMs]),
    [[3999.8, 4000]]);
  assert.deepEqual(cues(project), []);
  assert.deepEqual(assTimes(project), []);
  assert.deepEqual(planTimes(project), []);
});

function terminalFixture(startMs = 3000) {
  const original = fixture(startMs, 4000);
  return setClipPlaybackRate(original, original.clips[0].id, 1.5);
}

function assertSrtTimes(value, durationMs) {
  for (const line of value.split('\n').filter((line) => line.includes(' --> '))) {
    assert.match(line, /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/u);
    const milliseconds = line.split(' --> ').map((timestamp) => {
      const [hours, minutes, seconds, millis] = timestamp.split(/[:,]/u).map(Number);
      return hours * 3600000 + minutes * 60000 + seconds * 1000 + millis;
    });
    assert.ok(milliseconds.every(Number.isInteger));
    assert.ok(milliseconds[0] >= 0 && milliseconds[1] > milliseconds[0]);
    assert.ok(milliseconds[1] <= Math.floor(durationMs));
  }
}

// Execute the complete current serializer with an exact-duration dependency.
// This covers fractional bounds even though the shared MP4 helper currently ceils them.
function serializersAtExactDuration(durationMs) {
  const require = createRequire(import.meta.url);
  const source = readFileSync(new URL('../src/lib/subtitle-export.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((id) => {
    assert.ok(id.startsWith('@/'));
    const dependency = require('../src/' + id.slice(2) + '.ts');
    return id === '@/lib/project-timeline'
      ? { ...dependency, projectRenderDuration: () => durationMs } : dependency;
  }, module, module.exports);
  return module.exports;
}

test('full SRT serializer never emits a fractional comma timestamp at a speed-derived project end', () => {
  const project = terminalFixture();
  const durationMs = totalClipDuration(project.clips);
  const before = structuredClone(project);
  assert.equal(durationMs, 4000 / 1.5);
  const serializer = serializersAtExactDuration(durationMs);
  const srt = serializer.serializeSrt(project);
  assertSrtTimes(srt, durationMs);
  assert.equal(srt, '1\n00:00:02,000 --> 00:00:02,666\nPrimary\nSecondary\n');
  assert.deepEqual(project, before);
});

test('actual speed-derived terminal subtitles floor the format bound, including saved and failed tracks', () => {
  for (const [status, text, allowIncomplete, displayed] of [
    ['translated', 'Secondary', false, 'Secondary'],
    ['reviewed', 'Secondary', false, 'Secondary'],
    ['failed', 'Saved', true, 'Saved'],
    ['failed', '', true, 'Primary'],
  ]) {
    const project = terminalFixture();
    Object.assign(project.captionTracks.translations[0].cues[0], { status, text });
    const before = structuredClone(project);
    const durationMs = totalClipDuration(project.clips);
    const planBefore = buildTimelineRenderPlan(project, undefined, allowIncomplete);
    if (status === 'failed') {
      assert.throws(() => serializeSrt(project), /Export anyway/u);
      assert.throws(() => serializeAss(project), /Export anyway/u);
    }
    const srt = serializeSrt(project, allowIncomplete);
    assertSrtTimes(srt, durationMs);
    assert.equal(srt, '1\n00:00:02,000 --> 00:00:02,666\nPrimary\n' + displayed + '\n');
    const times = serializeAss(project, allowIncomplete).split('\n')
      .filter((line) => line.startsWith('Dialogue:')).map((line) => line.split(',').slice(1, 3));
    assert.deepEqual(times, [
      ['0:00:02.00', '0:00:02.66'], ['0:00:02.00', '0:00:02.66'],
    ]);
    assert.deepEqual(buildTimelineRenderPlan(project, undefined, allowIncomplete), planBefore);
    assert.deepEqual(project, before);
  }
});

test('independent dual terminal intervals stay independent at a fractional project bound', () => {
  const original = fixture(3000, 4000);
  Object.assign(original.captionTracks.translations[0].cues[0], { startMs: 2900, endMs: 4000 });
  const project = setClipPlaybackRate(original, original.clips[0].id, 1.5);
  const before = structuredClone(project);
  assert.deepEqual(cues(project), [
    { timing: '00:00:01,933 --> 00:00:02,666', text: 'Secondary' },
    { timing: '00:00:02,000 --> 00:00:02,666', text: 'Primary' },
  ]);
  assertSrtTimes(serializeSrt(project), totalClipDuration(project.clips));
  assert.deepEqual(assTimes(project), [
    ['0:00:02.00', '0:00:02.66'], ['0:00:01.93', '0:00:02.66'],
  ]);
  assert.deepEqual(project, before);
});

test('positive terminal tails are dropped only in formats without a representable interval', () => {
  for (const [startMs, expectedSrt, expectedAss] of [
    [3999.7, '', []],
    [3994.6, '1\n00:00:02,663 --> 00:00:02,666\nPrimary\nSecondary\n', []],
  ]) {
    for (const status of ['translated', 'failed']) {
      const project = terminalFixture(startMs);
      const cue = project.captionTracks.translations[0].cues[0];
      Object.assign(cue, { status, text: status === 'failed' ? '' : 'Secondary' });
      const before = structuredClone(project);
      const planBefore = buildTimelineRenderPlan(project, undefined, true);
      assert.ok(project.captions[0].endMs > project.captions[0].startMs);
      assert.equal(exportCaptionPairs(project, true).length, 1);
      if (status === 'failed') {
        assert.throws(() => serializeSrt(project), /Export anyway/u);
        assert.throws(() => serializeAss(project), /Export anyway/u);
      }
      const srt = serializeSrt(project, true);
      assert.equal(srt, status === 'failed' ? expectedSrt.replace('Secondary', 'Primary') : expectedSrt);
      assertSrtTimes(srt, totalClipDuration(project.clips));
      const dialogues = serializeAss(project, true).split('\n').filter((line) => line.startsWith('Dialogue:'));
      assert.deepEqual(dialogues, expectedAss);
      assert.deepEqual(buildTimelineRenderPlan(project, undefined, true), planBefore);
      assert.deepEqual(project, before);
    }
  }
});
