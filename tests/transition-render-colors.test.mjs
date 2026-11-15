import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTimelineRenderPlan, serializeStyle, toNativeRenderPlan } from '../src/lib/export-render-plan.ts';
import { resolveCanvasColor } from '../src/lib/canvas-color.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { DEFAULT_CAPTION_STYLE } from '../src/types/project.ts';

const fields = ['textColor', 'secondaryTextColor', 'activeWordColor', 'stroke.color', 'shadow.color', 'background.color'];
const read = (value, path) => path.split('.').reduce((part, key) => part[key], value);
function write(value, path, color) {
  const keys = path.split('.');
  const key = keys.pop();
  keys.reduce((part, name) => part[name], value)[key] = color;
}
function colored(color) {
  const style = structuredClone(DEFAULT_CAPTION_STYLE);
  for (const field of fields) write(style, field, color);
  return style;
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

// Call the actual TS serializer: RGBA project bytes must cross the bridge as ARGB.
for (const field of fields) {
  for (const [input, expected] of [
    ['#11223380', '#80112233'],
    ['#11223300', '#00112233'],
    ['#112233FF', '#FF112233'],
    ['#112233', '#112233'],
    ['#aBcDeF7f', '#7FABCDEF'],
  ]) {
    test(`serializeStyle ${field}: ${input} -> ${expected}`, () => {
      const style = structuredClone(DEFAULT_CAPTION_STYLE);
      write(style, field, input);
      const before = structuredClone(style);
      const result = serializeStyle(freeze(style), new Map());
      assert.equal(read(result, field), expected);
      assert.deepEqual(style, before);
      for (const other of fields.filter((name) => name !== field)) {
        assert.equal(read(result, other), read(before, other));
      }
    });
  }

  test(`serializeStyle rejects invalid required ${field} without a fallback`, () => {
    for (const invalid of [undefined, null, 123, '', 'red', '#abc', '#12345G', '#1234567', '#123456789', '#123456\n', '#12345680\n']) {
      const style = structuredClone(DEFAULT_CAPTION_STYLE);
      write(style, field, invalid);
      assert.throws(() => serializeStyle(style, new Map()), /color/i);
    }
  });
}

test('serializeStyle preserves font URI precedence, metadata, geometry and non-color settings without mutation', () => {
  const style = colored('#11223380');
  Object.assign(style, {
    font: { id: 'test', family: 'Test', source: 'built-in', postScriptName: 'TestPS', uri: 'file:///explicit.ttf' },
    position: { x: .31, y: .64 }, box: { width: .42, height: .13 },
    rotation: 27, scale: 1.7, scaleX: .8, scaleY: 1.2, opacity: .43,
  });
  const expected = structuredClone(style);
  for (const field of fields) write(expected, field, '#80112233');
  const before = structuredClone(style);
  const fonts = new Map([['Test', 'file:///resolved.ttf']]);
  const result = serializeStyle(freeze(style), fonts);
  assert.deepEqual(result, expected);
  assert.deepEqual(style, before);
  assert.deepEqual([...fonts], [['Test', 'file:///resolved.ttf']]);
  for (const key of ['font', 'position', 'box', 'stroke', 'shadow', 'background', 'animation']) {
    assert.notEqual(result[key], style[key]);
  }
  const mapped = structuredClone(style);
  delete mapped.font.uri;
  assert.equal(serializeStyle(mapped, fonts).font.uri, 'file:///resolved.ttf');
});

test('serializeStyle honors absent optional opacity and font metadata and keeps zero opacity', () => {
  const style = colored('#11223380');
  delete style.opacity;
  style.font = { id: 'test', family: 'Test', source: 'built-in' };
  const result = serializeStyle(style, new Map());
  assert.equal(Object.hasOwn(result, 'opacity'), false);
  assert.equal(Object.hasOwn(result.font, 'uri'), false);
  assert.equal(Object.hasOwn(result.font, 'postScriptName'), false);
  for (const source of ['system', 'imported']) {
    style.font.source = source;
    assert.equal(Object.hasOwn(serializeStyle(style, new Map([['Test', 'file:///wrong.ttf']])).font, 'uri'), false);
  }
  style.opacity = 0;
  assert.equal(serializeStyle(style, new Map()).opacity, 0);
});

test('actual render plan bridges primary/word/translated captions, text and watermark once, preserving project RGBA and canvas policy', () => {
  const project = createCaptionProject({ id: 'colors', name: 'Colors', sources: [{
    id: 'video', uri: 'file:///video.mp4', durationMs: 4000,
    width: 1920, height: 1080, rotation: 0, frameRate: 30, displayName: 'video.mp4',
  }] });
  project.canvas.backgroundColor = '#11223380';
  project.projectStyle = colored('#11223380');
  project.captions = [{ id: 'primary', text: 'Primary', startMs: 0, endMs: 2000, wordIds: ['word'] }];
  project.transcription.words = [{ id: 'word', text: 'Primary', startMs: 0, endMs: 2000, styleOverride: colored('#44556640') }];
  project.captionTracks.translations = [{
    id: 'translation', kind: 'translation', sourceTrackId: 'captions', sourceLanguageTag: 'en',
    languageTag: 'fr', displayName: 'French', visible: true, origin: 'manual', provider: { id: 'manual' },
    styleOverride: colored('#77889920'),
    cues: [{ id: 'translated', sourceCaptionId: 'primary', sourceTextSnapshot: 'Primary',
      text: 'Traduction', status: 'reviewed', reviewed: true }],
  }];
  for (const [id, color] of [['text', '#AABBCC00'], ['watermark', '#DDEEFFff']]) {
    project.layers.push({ id, kind: 'text', name: id, visible: true, text: id,
      startMs: 0, endMs: 2000, style: colored(color), ...(id === 'watermark' ? { watermark: true } : {}) });
  }
  const before = structuredClone(project);
  const plan = buildTimelineRenderPlan(freeze(project));
  const native = toNativeRenderPlan(plan);
  for (const output of [plan, native]) {
    assert.equal(output.captions.length, 2);
    assert.equal(output.layers.filter((layer) => layer.kind === 'text').length, 2);
    for (const [style, expected] of [
      [output.captions.find((cue) => cue.id === 'primary').style, '#80112233'],
      [output.captions.find((cue) => cue.id === 'primary').words[0].style, '#40445566'],
      [output.captions.find((cue) => cue.id === 'translated').style, '#20778899'],
      [output.layers.find((layer) => layer.id === 'text').style, '#00AABBCC'],
      [output.layers.find((layer) => layer.id === 'watermark').style, '#FFDDEEFF'],
    ]) for (const field of fields) assert.equal(read(style, field), expected);
    assert.equal(output.backgroundColor, '#09111A');
  }
  assert.deepEqual(project, before);
});

test('canvas colors still resolve over black with strict validation', () => {
  for (const [color, expected] of [['#11223380', '#09111A'], ['#11223300', '#000000'], ['#aBcDeFFF', '#ABCDEF'], ['#112233', '#112233']]) {
    assert.equal(resolveCanvasColor(color), expected);
  }
  for (const invalid of ['red', '#abc', '#12345G', '#123456\n', '#12345680\n']) {
    assert.throws(() => resolveCanvasColor(invalid), /canvas color/i);
  }
});
