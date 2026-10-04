import assert from 'node:assert/strict';
import test from 'node:test';

import { createEnglishChineseCaptionTrack, resolveCaptionPairs } from '../src/lib/caption-tracks.ts';
import { serializeAss, serializeSrt, visibleCaptions } from '../src/lib/subtitle-export.ts';
import { DEFAULT_CAPTION_STYLE } from '../src/types/project.ts';

// A separator-based reader exposes the portability failure independently of FFmpeg.
function readSrt(value) {
  if (!value) return [];
  return value.trimEnd().split('\n\n').map((block, index) => {
    const [number, timing, ...lines] = block.split('\n');
    assert.equal(number, String(index + 1));
    assert.match(timing, /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/u);
    assert.ok(lines.length > 0);
    assert.ok(lines.every((line) => line.trim().length > 0));
    return { timing, text: lines.join('\n') };
  });
}

function fixture(text) {
  return {
    clips: [], audioClips: [], layers: [{ id: 'captions', kind: 'captions', visible: true }],
    export: { burnCaptions: true },
    captions: [
      { id: 'c1', text, startMs: 0, endMs: 1_000, wordIds: [] },
      { id: 'c2', text: 'Following cue', startMs: 1_000, endMs: 2_000, wordIds: [] },
    ],
    captionTracks: { schemaVersion: 1, translations: [] },
    transcription: { language: 'en', modelId: 'fast', words: [], sourceResults: {} },
    projectStyle: DEFAULT_CAPTION_STYLE,
    canvas: { aspectWidth: 9, aspectHeight: 16 },
  };
}

function dual(text, translatedText) {
  return createEnglishChineseCaptionTrack(fixture(text), {
    c1: translatedText, c2: '\u540e\u7eed',
  });
}

for (const [name, text] of [
  ['LF', 'First\n\nSecond\nThird'],
  ['CRLF', 'First\r\n\r\nSecond\r\nThird'],
  ['CR', 'First\r\rSecond\rThird'],
  ['mixed endings and whitespace-only lines', 'First\r\n \t\rSecond\n\nThird'],
]) {
  test('SRT retains all content across ' + name + ' interior blank lines', () => {
    const project = fixture(text);
    const before = structuredClone(project);
    assert.deepEqual(readSrt(serializeSrt(project)), [
      { timing: '00:00:00,000 --> 00:00:01,000', text: 'First\nSecond\nThird' },
      { timing: '00:00:01,000 --> 00:00:02,000', text: 'Following cue' },
    ]);
    assert.deepEqual(project, before);
  });
}

test('SRT keeps ordinary multiline content, Unicode, indentation, and literal backslash text', () => {
  const text = 'Caf\u00e9 \ud83d\udc4b\n  \u4e16\u754c  \npath\\N\\n';
  assert.equal(readSrt(serializeSrt(fixture(text)))[0].text, text);
});

test('SRT retains timestamp-like and index-like content inside its original cue', () => {
  const text = 'First\n\n2\n00:00:01,000 --> 00:00:02,000\nLiteral timestamp\n\nLast';
  const cues = readSrt(serializeSrt(fixture(text)));
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'First\n2\n00:00:01,000 --> 00:00:02,000\nLiteral timestamp\nLast');
  assert.equal(cues[1].text, 'Following cue');
});

test('SRT skips blank-only primary cues and numbers the remaining content consecutively', () => {
  assert.deepEqual(readSrt(serializeSrt(fixture(' \r\n\t\r\n '))), [
    { timing: '00:00:01,000 --> 00:00:02,000', text: 'Following cue' },
  ]);
});

test('SRT skips cues that become empty after existing NUL removal', () => {
  assert.deepEqual(readSrt(serializeSrt(fixture('\0\n \0'))), [
    { timing: '00:00:01,000 --> 00:00:02,000', text: 'Following cue' },
  ]);
  const project = fixture('\0');
  project.captions.pop();
  assert.equal(serializeSrt(project), '');
});

test('SRT collapses interior blank lines in both aligned primary and dual captions', () => {
  const project = dual('Primary\n\nNext', '\u4f60\u597d\r\n \t\r\n\u4e16\u754c');
  const before = structuredClone(project);
  assert.equal(readSrt(serializeSrt(project))[0].text, 'Primary\nNext\n\u4f60\u597d\n\u4e16\u754c');
  assert.deepEqual(project, before);
});

test('SRT collapses blank lines in independently timed translations', () => {
  const project = dual('Primary\n\nNext', '\u4f60\u597d\n\n\u4e16\u754c');
  Object.assign(project.captionTracks.translations[0].cues[0], { startMs: 250, endMs: 750 });
  assert.deepEqual(readSrt(serializeSrt(project)).slice(0, 2), [
    { timing: '00:00:00,000 --> 00:00:01,000', text: 'Primary\nNext' },
    { timing: '00:00:00,250 --> 00:00:00,750', text: '\u4f60\u597d\n\u4e16\u754c' },
  ]);
});

test('SRT applies the same policy to translations whose primary caption is hidden', () => {
  const project = dual('Primary', '\u4f60\u597d\r\r\u4e16\u754c');
  project.captions[0].timelineVisible = false;
  project.captionTracks.translations[0].cues[0].timelineVisible = true;
  assert.equal(readSrt(serializeSrt(project))[0].text, '\u4f60\u597d\n\u4e16\u754c');
  assert.doesNotMatch(serializeSrt(project), /Primary/u);
});

test('SRT preserves incomplete-source fallback and consent while removing separator ambiguity', () => {
  const project = dual('Source\r\n\r\nContinuation', '');
  project.captionTracks.translations[0].cues[0].status = 'failed';
  const before = structuredClone(project);
  assert.throws(() => serializeSrt(project), /Export anyway/u);
  assert.equal(readSrt(serializeSrt(project, true))[0].text,
    'Source\nContinuation\nSource\nContinuation');
  assert.deepEqual(project, before);
});

test('SRT retains saved failed translations when incomplete export is allowed', () => {
  const project = dual('Source', '\u4f60\u597d\n\n\u4e16\u754c');
  project.captionTracks.translations[0].cues[0].status = 'failed';
  assert.throws(() => serializeSrt(project), /Export anyway/u);
  assert.equal(readSrt(serializeSrt(project, true))[0].text, 'Source\n\u4f60\u597d\n\u4e16\u754c');
});

test('blank-only dual content still requires consent and never adds empty cue lines', () => {
  const project = dual('Primary', '');
  project.captionTracks.translations[0].cues[0].text = ' \r\n\t ';
  assert.throws(() => serializeSrt(project), /Export anyway/u);
  assert.equal(readSrt(serializeSrt(project, true))[0].text, 'Primary');
});

test('SRT policy leaves project, visible text, dual presentation, and ASS blank lines intact', () => {
  const project = dual('Primary\n\nNext', '\u4f60\u597d\n\n\u4e16\u754c');
  const before = structuredClone(project);
  const ass = serializeAss(project);
  assert.equal(readSrt(serializeSrt(project))[0].text, 'Primary\nNext\n\u4f60\u597d\n\u4e16\u754c');
  assert.equal(visibleCaptions(project)[0].text, 'Primary\n\nNext');
  assert.equal(resolveCaptionPairs(project, 'translation-zh-Hans')[0].displayText, '\u4f60\u597d\n\n\u4e16\u754c');
  assert.match(ass, /Primary\\N\\NNext/u);
  assert.match(ass, /\u4f60\u597d\\N\\N\u4e16\u754c/u);
  assert.equal(serializeAss(project), ass);
  assert.deepEqual(project, before);
});
