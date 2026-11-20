import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as preview from '../src/lib/caption-preview.ts';
import { resolveCaptionStyle } from '../src/lib/style-resolver.ts';
import { serializeStyle, omitUndefinedDeep } from '../src/lib/export-render-plan.ts';
import { resolveLayerGeometry } from '../src/lib/layer-geometry.ts';
import { DEFAULT_CAPTION_STYLE } from '../src/types/project.ts';

const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const plain = value => JSON.parse(JSON.stringify(value));
const compile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const editorSource = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('editor.tsx', editorSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const derivations = [];
const declaredNames = name => ts.isIdentifier(name) ? [name.text]
  : ts.isObjectBindingPattern(name) ? name.elements.flatMap(element => declaredNames(element.name)) : [];
function visit(node) {
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
    declaredNames(declaration.name).some(name => ['activeCaption', 'activeCaptions', 'selectedCaption'].includes(name)))) {
    derivations.push(node.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast);

function selectionHost() {
  const slots = [];
  let cursor;
  const code = compile(derivations.join('\n') + '\nresult = { activeCaption, activeCaptions, selectedCaption };');
  return {
    render(previewCaptions, currentMs, selectedCaptionId) {
      cursor = 0;
      const scope = { ...preview, previewCaptions, currentMs, selectedCaptionId, result: undefined,
        useMemo(fn, deps) {
          const index = cursor++;
          if (!same(slots[index]?.deps, deps)) slots[index] = { deps, value: fn() };
          return slots[index].value;
        },
      };
      runInNewContext(code, scope);
      return scope.result;
    },
  };
}
function countedCaptions(values) {
  let searches = 0;
  Object.defineProperty(values, 'find', { configurable: true, value(predicate) {
    searches++;
    return Array.prototype.find.call(this, predicate);
  } });
  return { values, get searches() { return searches; } };
}
const cue = (id, startMs = 0, endMs = 1000, extra = {}) => ({
  id, text: id, startMs, endMs, wordIds: [], ...extra,
});

test('actual editor keeps caption selection independent of playback-clock updates', () => {
  const counted = countedCaptions([cue('first'), cue('selected', 1000, 2000)]);
  const host = selectionHost();
  const before = host.render(counted.values, 0, 'selected');
  assert.strictEqual(before.selectedCaption, counted.values[1]);
  const initialSearches = counted.searches;
  assert.ok(initialSearches > 0, 'the test must observe a real selection lookup');
  for (const time of [1, 250, 999, 1000, 1250, 1999, 2000, 100, 0]) {
    const result = host.render(counted.values, time, 'selected');
    assert.strictEqual(result.selectedCaption, before.selectedCaption);
    assert.deepEqual(plain(result.activeCaptions), plain(preview.captionPreviewState(
      [...counted.values], time, 'selected').activeCaptions));
  }
  assert.equal(counted.searches, initialSearches, 'clock-only updates must not repeat selection search');
});

test('actual editor invalidates selection on ID and caption revisions without changing preview semantics', () => {
  const hidden = cue('hidden', 0, 1000, { timelineVisible: false });
  const empty = cue('empty', 0, 500, { text: '  ' });
  const first = cue('first', 0, 1000);
  const second = cue('second', 1000, 2000);
  const values = [hidden, empty, first, second];
  const host = selectionHost();
  for (const id of [undefined, 'missing', 'hidden', 'empty', 'first', 'second', undefined]) {
    for (const time of [-1, 0, 499, 500, 999, 1000, 1999, 2000]) {
      const expected = preview.captionPreviewState(values, time, id);
      const result = host.render(values, time, id);
      assert.strictEqual(result.selectedCaption, expected.selected);
      assert.strictEqual(result.activeCaption, expected.active);
      assert.deepEqual(plain(result.activeCaptions), plain(expected.activeCaptions));
    }
  }
  const revision = values.map(value => value.id === 'first'
    ? { ...value, text: 'Edited', startMs: 100, endMs: 900 } : value);
  assert.strictEqual(host.render(revision, 200, 'first').selectedCaption, revision[2]);
  assert.equal(host.render(revision.filter(value => value.id !== 'first'), 200, 'first').selectedCaption, undefined);
  assert.strictEqual(host.render(values, 200, 'first').selectedCaption, first, 'undo restores the original selection');
  assert.equal(host.render([], 200, 'first').selectedCaption, undefined);
});

function presentationHost(fontUris) {
  const slotsByInstance = new Map();
  let slots, cursor;
  const react = {
    memo: fn => fn,
    useMemo(fn, deps) {
      const index = cursor++;
      if (!same(slots[index]?.deps, deps)) slots[index] = { deps, value: fn() };
      return slots[index].value;
    },
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) {
        let value = typeof initial === 'function' ? initial() : initial;
        if (value && typeof value.key === 'string' && 'uris' in value) {
          value = { key: [...fontUris.keys()].sort().join('|'), uris: fontUris };
        }
        slots[index] = { value };
      }
      return [slots[index].value, () => {}];
    },
    useEffect() {},
  };
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  let Presentation;
  function evaluate(path) {
    const exports = {};
    runInNewContext(compile(readFileSync(new URL(path, import.meta.url), 'utf8')), {
      exports,
      require(name) {
        if (name === 'react') return react;
        if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
        if (name === 'react-native') return { View: 'View', Text: 'Text' };
        if (name === 'expo') return { requireNativeView: () => 'NativeCaptionPresentation' };
        if (name === '@/lib/style-resolver') return { resolveCaptionStyle };
        if (name === '@/lib/export-render-plan') return { serializeStyle, omitUndefinedDeep };
        if (name === '@/lib/layer-geometry') return { resolveLayerGeometry };
        if (name === '@/services/export-font-assets') return { resolveExportFontUris: async () => fontUris };
        if (name === './caption-presentation') return { CaptionPresentation: Presentation };
        throw new Error('Unexpected presentation dependency: ' + name);
      },
    });
    return exports;
  }
  Presentation = evaluate('../src/components/editor/caption-presentation.tsx').CaptionPresentation;
  const Overlay = evaluate('../src/components/editor/caption-overlay.tsx').CaptionOverlay;
  function renderComponent(component, props, instance) {
    slots = slotsByInstance.get(instance) ?? [];
    slotsByInstance.set(instance, slots);
    cursor = 0;
    return component(props);
  }
  function nativeNodes(node) {
    if (!node) return [];
    if (Array.isArray(node)) return node.flatMap(nativeNodes);
    if (node.type === Presentation) return nativeNodes(renderComponent(Presentation, node.props, 'caption:' + node.key));
    if (node.type === 'NativeCaptionPresentation') return [node];
    return nativeNodes(node.props?.children);
  }
  return {
    render(props) { return nativeNodes(renderComponent(Overlay, props, 'overlay')); },
  };
}
function countedWords(values) {
  let scans = 0;
  Object.defineProperty(values, 'map', { configurable: true, value(...args) {
    scans++;
    return Array.prototype.map.apply(this, args);
  } });
  return { values, get scans() { return scans; } };
}
const word = (id, text, startMs, extra = {}) => ({
  id, text, startMs, endMs: startMs + 200, confidence: 0.95, ...extra,
});
function propsFor(caption, words, projectStyle = DEFAULT_CAPTION_STYLE) {
  return { caption, words, projectStyle, geometry: projectStyle, currentMs: caption.startMs + 10 };
}

test('actual caption overlay shares one transcript lookup across cue mounts and style revisions', () => {
  const words = countedWords([
    word('w1', 'one', 0),
    word('w2', 'two', 1000, { styleOverride: { textColor: '#123456' } }),
  ]);
  const fontUris = new Map([[DEFAULT_CAPTION_STYLE.font.family, 'file:///fixture-font.ttf']]);
  const host = presentationHost(fontUris);
  const first = cue('first', 0, 900, { wordIds: ['w1'] });
  const second = cue('second', 1000, 1900, { wordIds: ['w2'] });
  assert.equal(host.render(propsFor(first, words.values)).length, 1);
  const initialScans = words.scans;
  assert.equal(initialScans, 1, 'fixture must execute the real transcript lookup');
  assert.equal(host.render(propsFor(second, words.values)).length, 1);
  const styled = { ...DEFAULT_CAPTION_STYLE, textColor: '#abcdef' };
  assert.equal(host.render(propsFor(second, words.values, styled)).length, 1);
  assert.equal(words.scans, initialScans, 'new cue/style must not rescan the same transcript');
});

test('shared lookup preserves serialized words, duplicate/missing IDs, styling, timing and revisions', () => {
  const words = [
    word('repeat', 'old', 0), word('second', '🌈 punctuation ++', 1000),
    word('repeat', 'last', 20, { styleOverride: { textColor: '#FF8800', fontSize: 44 } }),
  ];
  const caption = cue('first', 0, 2000, { wordIds: ['second', 'missing', 'repeat', 'second'],
    styleOverride: { textColor: '#abcdef' } });
  const fontUris = new Map([[DEFAULT_CAPTION_STYLE.font.family, 'file:///fixture-font.ttf']]);
  const host = presentationHost(fontUris);
  const before = structuredClone({ words, caption, style: DEFAULT_CAPTION_STYLE });
  const nodes = host.render(propsFor(caption, words));
  assert.equal(nodes.length, 1);
  const expectedStyle = resolveCaptionStyle(DEFAULT_CAPTION_STYLE, caption);
  const index = new Map(words.map(item => [item.id, item]));
  const expectedWords = caption.wordIds.flatMap(id => {
    const item = index.get(id);
    return item ? [{ text: item.text, startMs: item.startMs, endMs: item.endMs,
      style: serializeStyle(resolveCaptionStyle(DEFAULT_CAPTION_STYLE, caption, item), fontUris) }] : [];
  });
  assert.deepEqual(plain(nodes[0].props.caption), plain(omitUndefinedDeep({
    id: caption.id, text: caption.text, startMs: caption.startMs, endMs: caption.endMs,
    style: serializeStyle(expectedStyle, fontUris), words: expectedWords,
  })));
  assert.deepEqual({ words, caption, style: DEFAULT_CAPTION_STYLE }, before, 'lookup never mutates source state');
  const revised = words.map(item => item.id === 'second' ? { ...item, text: 'edited', endMs: 1550 } : item);
  const revisedNode = host.render(propsFor(caption, revised))[0];
  assert.equal(revisedNode.props.caption.words[0].text, 'edited');
  assert.equal(revisedNode.props.caption.words[0].endMs, 1550);
  assert.deepEqual(plain(host.render(propsFor(caption, []))[0].props.caption.words), []);
  assert.equal(host.render(propsFor(undefinedCaption(), []))[0].props.authored, false);
  const manual = cue('manual', 0, 2000, { text: 'Text only', wordIds: [] });
  assert.deepEqual(plain(host.render({ ...propsFor(manual, revised), preserveLineBreaks: true })[0].props.caption.words), []);
});
function undefinedCaption() { return cue('empty-words'); }
