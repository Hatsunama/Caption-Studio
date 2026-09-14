import assert from 'node:assert/strict';
import test from 'node:test';
import { applyStylePatch, mergePatch, mergeStyle, resolveCaptionStyle } from '../src/lib/style-resolver.ts';
import { DEFAULT_CAPTION_STYLE } from '../src/types/project.ts';

const imported = {
  id: 'imported-a', family: 'Imported A', source: 'imported',
  uri: 'file:///fonts/a.otf', postScriptName: 'ImportedA-Regular',
};
const system = { id: 'system-sans', family: 'sans-serif', source: 'system' };
const base = () => ({ ...structuredClone(DEFAULT_CAPTION_STYLE), font: { ...imported } });

for (const [name, font] of Object.entries({
  system,
  builtin: { id: 'builtin-b', family: 'Built In B', source: 'built-in' },
  id: { id: 'imported-b' },
  family: { family: 'Imported B' },
  source: { source: 'system' },
})) {
  test(`${name} replacement removes stale font metadata in styles and patches`, () => {
    const original = base();
    for (const merged of [mergeStyle(original, { font }), mergePatch({ font: original.font }, { font })]) {
      assert.equal(Object.hasOwn(merged.font, 'uri'), false);
      assert.equal(Object.hasOwn(merged.font, 'postScriptName'), false);
      for (const [key, value] of Object.entries(font)) assert.equal(merged.font[key], value);
    }
    assert.deepEqual(original.font, imported);
  });
}

test('replacement retains only explicitly supplied metadata', () => {
  for (const merge of [mergeStyle, mergePatch]) {
    const font = merge(base(), { font: { id: 'imported-b', uri: 'file:///fonts/b.otf' } }).font;
    assert.equal(font.uri, 'file:///fonts/b.otf');
    assert.equal(Object.hasOwn(font, 'postScriptName'), false);
    const named = merge(base(), { font: { id: 'imported-b', postScriptName: 'ImportedB' } }).font;
    assert.equal(named.postScriptName, 'ImportedB');
    assert.equal(Object.hasOwn(named, 'uri'), false);
  }
});

test('safe partial and same-identity patches preserve font metadata', () => {
  for (const merge of [mergeStyle, mergePatch]) {
    for (const patch of [{ italic: true }, { font: {} }, { font: { id: imported.id } },
      { font: { family: imported.family, source: imported.source } }]) {
      assert.deepEqual(merge(base(), patch).font, imported);
    }
    assert.deepEqual(merge(base(), { font: { postScriptName: 'UpdatedName' } }).font,
      { ...imported, postScriptName: 'UpdatedName' });
  }
});

test('unrelated patch fields do not manufacture empty nested style overrides', () => {
  assert.deepEqual(mergePatch(undefined, { fontSize: 30 }), { fontSize: 30 });
  assert.deepEqual(mergePatch({ italic: true }, { fontSize: 30 }), { italic: true, fontSize: 30 });
});

function project() {
  return {
    projectStyle: base(),
    captions: [{ id: 'c1', wordIds: ['w1'], styleOverride: { font: { ...imported }, italic: true } }],
    transcription: { words: [{ id: 'w1', styleOverride: { font: { uri: imported.uri, postScriptName: imported.postScriptName }, fontSize: 72 } }] },
  };
}

test('global font selection clears stale caption and word font overrides without losing other styles', () => {
  const next = applyStylePatch(project(), undefined, 'all', { font: system });
  assert.deepEqual(next.projectStyle.font, system);
  assert.equal(next.captions[0].styleOverride.font, undefined);
  assert.equal(next.transcription.words[0].styleOverride.font, undefined);
  assert.equal(next.captions[0].styleOverride.italic, true);
  assert.equal(next.transcription.words[0].styleOverride.fontSize, 72);
  assert.deepEqual(resolveCaptionStyle(next.projectStyle, next.captions[0], next.transcription.words[0]).font, system);
});

test('same-identity global patches preserve imported metadata through caption and word inheritance', () => {
  const next = applyStylePatch(project(), undefined, 'all', { font: { id: imported.id } });
  assert.deepEqual(resolveCaptionStyle(next.projectStyle, next.captions[0], next.transcription.words[0]).font, imported);
});

test('single-caption font replacement resolves without imported metadata and leaves the project font intact', () => {
  const next = applyStylePatch(project(), 'c1', 'caption', { font: system });
  assert.deepEqual(resolveCaptionStyle(next.projectStyle, next.captions[0]).font, system);
  assert.deepEqual(next.projectStyle.font, imported);
});
