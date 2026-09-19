import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { fontChoicePatch } from '../src/lib/font-style-choice.ts';

const solid = { font: { id: 'solid', family: 'Solid', source: 'built-in' }, name: 'Solid', mood: 'Clean', treatment: 'solid' };
const dual = { ...solid, font: { ...solid.font, id: 'dual' }, name: 'Dual', treatment: 'duotone-offset', colors: { primary: '#DFFF35', secondary: '#6A35FF' } };
const sources = Object.fromEntries(['font-browser', 'font-color-picker'].map((name) => [name, ts.transpileModule(
  readFileSync(new URL(`../src/components/editor/${name}.tsx`, import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } },
).outputText]));

function mount(name, exportName, props) {
  const slots = [];
  let cursor = 0, tree, effects = [];
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useMemo: (fn) => fn(),
    useEffect: (fn) => { effects.push(fn); },
  };
  const native = Object.fromEntries(['View', 'Text', 'TextInput', 'Pressable', 'FlatList', 'Modal', 'ScrollView'].map((key) => [key, key]));
  native.Alert = { alert() {} };
  const exports = {};
  runInNewContext(sources[name], {
    exports,
    require: (id) => {
      if (id === 'react') return react;
      if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (id === 'react-native') return native;
      if (id.endsWith('ui-theme')) return { chrome: { radius: {} } };
      if (id.endsWith('font-style-choice')) return { fontChoicePatch };
      if (id.endsWith('font-catalog')) return { BUILT_IN_FONT_CHOICES: [solid, dual], TWO_COLOR_FONT_COUNT: 1 };
      if (id.endsWith('font-color-picker')) return { FontColorPicker: 'FontColorPicker' };
      if (id.endsWith('font-storage')) return {
        loadFontLibrary: () => new Promise(() => {}), saveRecentFonts() {}, saveFontFavorites() {},
      };
      throw new Error(`Unexpected import: ${id}`);
    },
  });
  function render() {
    cursor = 0; effects = [];
    tree = exports[exportName](props);
    for (const effect of effects) effect();
  }
  function all(predicate, root = tree) {
    if (Array.isArray(root)) return root.flatMap((node) => all(predicate, node));
    if (!root || typeof root !== 'object') return [];
    return [...(predicate(root) ? [root] : []), ...all(predicate, root.props?.children ?? null)];
  }
  render();
  return { render, all, get: (type) => all((node) => node.type === type)[0] };
}

test('font taps draft only; native and route Back preserve the mounted font list and search', () => {
  const commits = [];
  let closeCount = 0, routeBack;
  const h = mount('font-browser', 'FontBrowser', {
    visible: true, previewText: 'Caption', onClose: () => closeCount++,
    onSelect: (...args) => commits.push(args), onBackRequestChange: (request) => { routeBack = request; },
  });
  h.get('TextInput').props.onChangeText('Dual'); h.render();
  const data = h.get('FlatList').props.data;
  assert.equal(data.length, 1);
  h.get('FlatList').props.renderItem({ item: dual }).props.onPress(); h.render();
  assert.equal(h.get('FontColorPicker').props.choice, dual);
  assert.ok(h.get('FlatList'), 'list remains mounted, preserving native scroll position');
  assert.equal(commits.length, 0);
  h.get('Modal').props.onRequestClose(); h.render();
  assert.equal(h.get('FontColorPicker'), undefined);
  assert.equal(h.get('TextInput').props.value, 'Dual');
  assert.equal(h.get('FlatList').props.data[0], dual);
  assert.equal(closeCount, 0);
  h.get('FlatList').props.renderItem({ item: dual }).props.onPress(); h.render();
  routeBack(); h.render();
  assert.equal(h.get('FontColorPicker'), undefined);
  assert.equal(commits.length, 0);
  routeBack();
  assert.equal(closeCount, 1);
});

test('browser Save submits the selected font and both colors together exactly once', () => {
  const commits = [];
  const h = mount('font-browser', 'FontBrowser', { visible: true, previewText: 'Sticker', onClose() {}, onSelect: (...args) => commits.push(args) });
  h.get('FlatList').props.renderItem({ item: dual }).props.onPress(); h.render();
  const colors = { primary: '#123456', secondary: '#ABCDEF' };
  h.get('FontColorPicker').props.onSave(colors); h.render();
  assert.equal(commits.length, 1);
  assert.equal(commits[0][0], dual);
  assert.equal(commits[0][1], colors);
  assert.equal(h.get('FontColorPicker'), undefined);
});

for (const choice of [solid, dual]) {
  test(`${choice.name} picker has the right color controls and Back does not save`, () => {
    const saved = [];
    let backs = 0;
    const h = mount('font-color-picker', 'FontColorPicker', { choice, previewText: 'Text', onBack: () => backs++, onSave: (colors) => saved.push(colors) });
    const tabs = h.all((node) => node.props?.accessibilityRole === 'tab');
    assert.equal(tabs.length, choice === dual ? 2 : 0);
    const wheel = () => h.all((node) => typeof node.props?.onChange === 'function')[0];
    assert.equal(wheel().props.color, choice.colors?.primary ?? '#FFFFFF');
    wheel().props.onChange('#123456'); h.render();
    if (choice === dual) {
      tabs[1].props.onPress(); h.render();
      assert.equal(wheel().props.color, '#6A35FF');
      wheel().props.onChange('#ABCDEF'); h.render();
      h.all((node) => node.props?.accessibilityRole === 'tab')[0].props.onPress(); h.render();
      assert.equal(wheel().props.color, '#123456');
    }
    const buttons = h.all((node) => node.props?.accessibilityRole === 'button');
    buttons[0].props.onPress();
    assert.equal(backs, 1);
    assert.equal(saved.length, 0);
    buttons[1].props.onPress();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].primary, '#123456');
    assert.equal(saved[0].secondary, choice === dual ? '#ABCDEF' : '#FFFFFF');
  });
}
