import assert from 'node:assert/strict';
import test from 'node:test';

import { serializeAss, serializeSrt } from '../src/lib/subtitle-export.ts';
import { DEFAULT_CAPTION_STYLE } from '../src/types/project.ts';

const authoredCases = [
  ['standalone symbols', 'Hello ++ world'],
  ['emoji', 'Hello \u{1F44B}\u{1F3FD} \u{1F469}\u200D\u{1F4BB} world'],
  ['punctuation and its spacing', 'Hello ,  world !'],
  ['multiline whitespace', '  Hello  ++\r\n\r\n  world  '],
  ['escaped ASS characters', 'Hello {++} \\ world'],
  ['surrounding symbols', '++ Hello world \u{1F680}'],
];

for (const [label, authored] of authoredCases) {
  test(`ASS preserves ${label} with wordIds and individual word styles`, () => {
    const project = projectFixture(authored);
    const before = structuredClone(project);
    const runs = dialogueRuns(serializeAss(project));
    assert.equal(runs.map((run) => run.text).join(''), authored.replace(/\r\n?/g, '\n'));
    assertWordStyle(runs, 'Hello', '\\c&H000000FF&');
    assertWordStyle(runs, 'world', '\\c&H0000FF00&');
    assert.deepEqual(project, before, 'serialization must not mutate the project');
  });
}

test('ASS preserves ordinary word styling and punctuation attached to words', () => {
  const runs = dialogueRuns(serializeAss(projectFixture('Hello, world!')));
  assert.equal(runs.map((run) => run.text).join(''), 'Hello, world!');
  assertWordStyle(runs, 'Hello,', '\\c&H000000FF&');
  assertWordStyle(runs, 'world!', '\\c&H0000FF00&');
});

test('ASS retains authored text when ASR alignment cannot be trusted', () => {
  for (const authored of ['Hello ++ brave world', 'Helloworld ++', '\u{1F680} ++']) {
    const runs = dialogueRuns(serializeAss(projectFixture(authored)));
    assert.equal(runs.map((run) => run.text).join(''), authored);
  }
});

test('ASS retains authored text without resolvable wordIds', () => {
  const authored = '  Hello ++\n\nworld \u{1F44B}  ';
  for (const wordIds of [[], ['missing-word']]) {
    const project = projectFixture(authored);
    project.captions[0].wordIds = wordIds;
    assert.equal(dialogueRuns(serializeAss(project)).map((run) => run.text).join(''), authored);
  }
});

test('ASS applies existing per-word text transforms to authored words', () => {
  const project = projectFixture('Hello ++ world');
  project.transcription.words[0].styleOverride.textTransform = 'uppercase';
  const runs = dialogueRuns(serializeAss(project));
  assert.equal(runs.map((run) => run.text).join(''), 'HELLO ++ world');
  assertWordStyle(runs, 'HELLO', '\\c&H000000FF&');
  assertWordStyle(runs, 'world', '\\c&H0000FF00&');
});

const tabCases = [
  ['styled word gaps', 'Hello\t\tworld', 'Hello    world', ['hello', 'world']],
  ['authored symbol gaps', 'Hello\t++   \tworld', 'Hello  ++     world', ['hello', 'world']],
  ['inside a styled punctuation span', 'Hello\t,  world', 'Hello  ,  world', ['hello', 'world']],
  ['unstyled text', '  Hello\t++   world  ', '  Hello  ++   world  ', []],
  ['unresolvable wordIds', 'Hello\t++   world', 'Hello  ++   world', ['missing-word']],
  ['unaligned ASR fallback', 'Hello\tbrave   world', 'Hello  brave   world', ['hello', 'world']],
];

for (const [label, authored, expected, wordIds] of tabCases) {
  test(`ASS expands each Tab to exactly two regular spaces in ${label}`, () => {
    const project = projectFixture(authored);
    project.captions[0].wordIds = wordIds;
    const runs = dialogueRuns(serializeAss(project));
    const text = runs.map((run) => run.text).join('');
    assert.equal(text, expected, 'expand only Tabs; preserve every ordinary space');
    assert.equal(text.includes('\t'), false);
    if (wordIds.length === 2 && !authored.includes('brave')) {
      assertWordStyle(runs, 'Hello', '\\c&H000000FF&');
      assertWordStyle(runs, 'world', '\\c&H0000FF00&');
    }
  });
}

test('SRT leaves literal Tabs and ordinary spaces unchanged', () => {
  const project = projectFixture('Hello\t++   world');
  assert.equal(serializeSrt(project), '1\n00:00:00,000 --> 00:00:01,000\nHello\t++   world\n');
});

test('SRT keeps its existing authored text, line normalization, and timing contract', () => {
  const project = projectFixture('  Hello ++\r\n\r\n  world \u{1F44B}  ');
  assert.equal(serializeSrt(project), '1\n00:00:00,000 --> 00:00:01,000\nHello ++\n  world \u{1F44B}\n');
});

function assertWordStyle(runs, word, tag) {
  const run = runs.find((entry) => entry.text.includes(word));
  assert.ok(run, `missing authored word ${word}`);
  assert.ok(run.tags.includes(tag), `${word} must keep its own color`);
}

// Parse actual ASS Text fields; distinguish escaped literals from override tags.
function dialogueRuns(ass) {
  const lines = ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
  assert.equal(lines.length, 1);
  let separator = -1;
  for (let field = 0; field < 9; field += 1) {
    separator = lines[0].indexOf(',', separator + 1);
    assert.ok(separator >= 0);
  }
  const text = lines[0].slice(separator + 1);
  const runs = [];
  let tags = '';
  let literal = '';
  const flush = () => {
    if (literal) runs.push({ tags, text: literal });
    literal = '';
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\') {
      const next = text[index + 1];
      if (next === '\\' || next === '{' || next === '}') {
        literal += next;
        index += 1;
      } else if (next === 'N') {
        literal += '\n';
        index += 1;
      } else {
        literal += character;
      }
    } else if (character === '{') {
      flush();
      const end = text.indexOf('}', index + 1);
      assert.ok(end >= 0, 'unterminated ASS override');
      tags = text.slice(index + 1, end);
      index = end;
    } else {
      literal += character;
    }
  }
  flush();
  return runs;
}

function projectFixture(text) {
  return {
    clips: [], audioClips: [], layers: [{ id: 'captions', kind: 'captions', visible: true }],
    export: { burnCaptions: true },
    captions: [{ id: 'caption', text, startMs: 0, endMs: 1_000, wordIds: ['hello', 'world'] }],
    captionTracks: { schemaVersion: 1, translations: [] },
    transcription: {
      language: 'en', modelId: 'fast', sourceResults: {},
      words: [
        { id: 'hello', text: 'Hello', startMs: 0, endMs: 500, styleOverride: { textColor: '#FF0000' } },
        { id: 'world', text: 'world', startMs: 500, endMs: 1_000, styleOverride: { textColor: '#00FF00' } },
      ],
    },
    projectStyle: structuredClone(DEFAULT_CAPTION_STYLE),
    canvas: { aspectWidth: 9, aspectHeight: 16 },
  };
}
