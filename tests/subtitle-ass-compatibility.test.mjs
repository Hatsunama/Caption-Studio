import assert from 'node:assert/strict';
import test from 'node:test';

import { serializeAss } from '../src/lib/subtitle-export.ts';
import { DEFAULT_CAPTION_STYLE } from '../src/types/project.ts';

test('ASS dialogue leaves commas literal in the final Text field for libass compatibility', () => {
  const ass = serializeAss(projectFixture('Hello, {world}\\path'));
  const dialogue = ass.split('\n').find((line) => line.startsWith('Dialogue:'));
  assert.ok(dialogue);
  const textField = assDialogueText(dialogue);

  assert.match(textField, /Hello, \\\{world\\\}\\\\path/u);
  assert.doesNotMatch(textField, /\\,/u);
  assert.equal(dialogue.slice(0, textField.length * -1).split(',').length - 1, 9);
});

test('ASS styled word output preserves a spoken comma without inventing a field escape', () => {
  const project = projectFixture('Hello, world');
  project.transcription.words = [
    { id: 'word-1', text: 'Hello,', startMs: 0, endMs: 500 },
    { id: 'word-2', text: 'world', startMs: 500, endMs: 1_000, styleOverride: { textColor: '#00FF00' } },
  ];
  project.captions[0].wordIds = ['word-1', 'word-2'];
  const dialogue = serializeAss(project).split('\n').find((line) => line.startsWith('Dialogue:'));
  assert.ok(dialogue);
  const textField = assDialogueText(dialogue);

  assert.match(textField, /Hello,/u);
  assert.doesNotMatch(textField, /Hello\\,/u);
  assert.match(textField, /&H0000FF00&/u);
});

function assDialogueText(dialogue) {
  let separator = -1;
  for (let field = 0; field < 9; field += 1) separator = dialogue.indexOf(',', separator + 1);
  assert.ok(separator >= 0, 'ASS Dialogue must contain nine fixed-field separators');
  return dialogue.slice(separator + 1);
}

function projectFixture(text) {
  return {
    captions: [{ id: 'caption', text, startMs: 0, endMs: 1_000, wordIds: [] }],
    captionTracks: { schemaVersion: 1, translations: [] },
    transcription: { language: 'en', modelId: 'fast', words: [], sourceResults: {} },
    projectStyle: DEFAULT_CAPTION_STYLE,
    canvas: { aspectWidth: 9, aspectHeight: 16 },
  };
}
