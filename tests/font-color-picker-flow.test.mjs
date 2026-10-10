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

function mount(name, exportName, props, options = {}) {
  const reveal = { viewportRef: { current: null }, focus() {}, blur() {}, onViewportLayout() {}, onScroll() {}, onScrollBeginDrag() {} };
  const slots = [];
  const childSlots = new Map();
  let activeSlots = slots;
  let cursor = 0, tree, effects = [];
  const react = {
    useRef: (value) => react.useState(() => ({ current: value }))[0],
    useCallback: (fn) => fn,
    useState(initial) {
      const index = cursor++;
      const state = activeSlots;
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
      return [state[index], (next) => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
    },
    useMemo: (fn) => fn(),
    useEffect: (fn) => { effects.push(fn); },
  };
  const native = Object.fromEntries(['View', 'Text', 'TextInput', 'Pressable', 'FlatList', 'Modal', 'ScrollView', 'KeyboardAvoidingView'].map((key) => [key, key]));
  native.useWindowDimensions = () => options.window ?? { width: 390, height: 844 };
  native.Platform = { OS: options.platform ?? 'android' };
  native.Alert = { alert() {} };
  function load(moduleName) {
    const exports = {};
    runInNewContext(sources[moduleName], {
    exports,
    require: (id) => {
      if (id === 'react') return react;
      if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (id === 'react-native') return native;
      if (id === '@/hooks/use-focused-input-reveal') return { useFocusedInputReveal: () => reveal };
if (id === '@/components/editor/keyboard-viewport') return { KeyboardViewport: 'KeyboardViewport' };
      if (id === 'react-native-safe-area-context') return { useSafeAreaInsets: () => options.insets ?? { top: 0, bottom: 24, left: 0, right: 0 } };
      if (id.endsWith('ui-theme')) return { chrome: { radius: {} } };
      if (id.endsWith('font-style-choice')) return { fontChoicePatch };
      if (id.endsWith('font-catalog')) return { BUILT_IN_FONT_CHOICES: [solid, dual], TWO_COLOR_FONT_COUNT: 1 };
      if (id.endsWith('font-color-picker')) return options.resolveChildren ? load('font-color-picker') : { FontColorPicker: 'FontColorPicker' };
      if (id === '@/hooks/use-font-library') return { useFontLibrary: () => ({
        imported: [], favorites: ['bungee', 'monoton', 'rubik-glitch'], recent: [],
        importFont: async () => true, rememberFont: id => options.remembered?.push(id),
        toggleFavorite: id => options.favorites?.push(id),
      }) };
      if (id.endsWith('font-storage')) return {
        loadFontLibrary: () => new Promise(() => {}), saveRecentFonts() {}, saveFontFavorites() {},
      };
      throw new Error(`Unexpected import: ${id}`);
    },
    });
    return exports;
  }
  const exports = load(name);
  function expand(node, path = 'root') {
    if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}/${index}`));
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      const id = `${path}:${node.type.name}:${node.key ?? ''}`;
      if (!childSlots.has(id)) childSlots.set(id, []);
      const previous = activeSlots, previousCursor = cursor;
      activeSlots = childSlots.get(id); cursor = 0;
      const output = node.type(node.props);
      activeSlots = previous; cursor = previousCursor;
      return expand(output, `${id}/output`);
    }
    return { ...node, props: { ...node.props, children: expand(node.props?.children, `${path}/children`) } };
  }
  function render() {
    activeSlots = slots; cursor = 0; effects = [];
    tree = exports[exportName](props);
    if (options.resolveChildren) tree = expand(tree);
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

test('a measured 300dp short font root leaves secondary controls in scrollable results', () => {
  const h = mount('font-browser', 'FontBrowser', { visible: true, previewText: 'Text', onClose() {}, onSelect() {} });
  const root = h.all((node) => node.props?.testID === 'font-browser-root')[0];
  assert.ok(root, 'measure the modal root rather than infer device orientation');
  root.props.onLayout({ nativeEvent: { layout: { width: 300, height: 230 } } }); h.render();
  const toggle = h.all((node) => node.props?.accessibilityLabel === 'Font filters and import')[0];
  assert.ok(toggle); assert.equal(toggle.props.accessibilityState.expanded, false);
  assert.ok(toggle.props.style.minHeight >= 44);
  assert.equal(h.get('FlatList').props.ListHeaderComponent, null);
  toggle.props.onPress(); h.render();
  assert.ok(h.get('FlatList').props.ListHeaderComponent, 'expanded controls scroll with results');
  assert.equal(h.get('FlatList').props.keyboardShouldPersistTaps, 'handled');
  assert.ok(h.get('KeyboardViewport'));
  h.get('TextInput').props.onChangeText('Dual'); h.render();
  h.get('FlatList').props.renderItem({ item: dual }).props.onPress(); h.render();
  h.get('Modal').props.onRequestClose(); h.render();
  assert.equal(h.get('TextInput').props.value, 'Dual');
  assert.equal(h.get('FlatList').props.data[0], dual);
});

test('picker respects keyboard and lateral safe areas while Back and Save stay outside its scrolling body', () => {
  const h = mount('font-color-picker', 'FontColorPicker', { choice: dual, previewText: 'Text', onBack() {}, onSave() {} },
    { window: { width: 300, height: 230 }, insets: { top: 0, bottom: 12, left: 20, right: 10 } });
  const root = h.get('KeyboardAvoidingView'); assert.ok(root);
  assert.equal(root.props.behavior, undefined);
  assert.ok(root.props.style.paddingLeft >= 20); assert.ok(root.props.style.paddingRight >= 10);
  assert.equal(h.get('ScrollView').props.style.flexShrink, 1);
  assert.equal(h.all((node) => node.props?.accessibilityRole === 'button', h.get('ScrollView')).length, 0);
  assert.equal(h.all((node) => node.props?.accessibilityRole === 'button').length, 2);
  h.get('ScrollView').props.onLayout({ nativeEvent: { layout: { width: 180, height: 90 } } }); h.render();
  assert.equal(h.all((node) => typeof node.props?.onChange === 'function')[0].props.size, 180,
    'wheel gesture geometry follows the measured usable body width');
});

for (const platform of ['android', 'ios']) {
  test(`${platform} measured font roots preserve portrait chrome and avoid nested keyboard adjustment`, () => {
    const commits = [];
    let routeBack;
    const h = mount('font-browser', 'FontBrowser', {
      visible: true, previewText: 'Text', onClose() {}, onSelect: (...args) => commits.push(args),
      onBackRequestChange: (request) => { routeBack = request; },
    }, { platform, resolveChildren: true });
    const root = () => h.all((node) => node.props?.testID === 'font-browser-root')[0];
    const toggle = () => h.all((node) => node.props?.accessibilityLabel === 'Font filters and import')[0];
    assert.equal(toggle(), undefined, 'roomy portrait keeps the original header controls');
    assert.ok(h.all((node) => node.props?.children === 'Import unlimited .ttf or .otf fonts').length);
    h.get('TextInput').props.onChangeText('Dual'); h.render();
    root().props.onLayout({ nativeEvent: { layout: { width: 300, height: 230 } } }); h.render();
    assert.ok(toggle().props.style.minHeight >= 44, 'short measured root wins over tall window dimensions');
    const viewport = h.get('KeyboardViewport');
    assert.ok(viewport);
    assert.equal(viewport.props.enabled ?? true, true);
    assert.equal(viewport.props.iosAvoidance ?? true, true);
    assert.equal(viewport.props.children, root(), 'measurement belongs to the reduced child');
    assert.equal(h.get('TextInput').props.disableFullscreenUI, true);
    h.get('FlatList').props.renderItem({ item: dual }).props.onPress(); h.render();
    const picker = () => h.all((node) => node.props?.testID === 'font-color-picker-root')[0];
    assert.equal(picker().props.enabled, false, 'the actual nested picker delegates avoidance to its parent');
    assert.equal(picker().props.behavior, platform === 'ios' ? 'padding' : undefined);
    assert.equal(h.all((node) => node.type === 'KeyboardViewport').length, 1);
    assert.equal(h.all((node) => node.type === 'KeyboardAvoidingView').length, 1, 'only the disabled nested picker retains its native wrapper');
    picker().props.onLayout({ nativeEvent: { layout: { width: 300, height: 230 } } }); h.render();
    assert.equal(picker().props.children.props.padding, undefined);
    assert.equal(picker().props.children.props.style.padding, 12);
    assert.equal(h.get('ScrollView').props.style.flexShrink, 1);
    const hex = h.all((node) => node.props?.accessibilityLabel === 'Hex color')[0];
    assert.equal(hex.props.disableFullscreenUI, true);
    hex.props.onChangeText('#123456'); h.render();
    const buttons = h.all((node) => node.props?.accessibilityRole === 'button', picker());
    assert.equal(buttons.length, 2);
    for (const button of buttons) assert.ok(button.props.style.minHeight >= 44);
    assert.equal(h.all((node) => node.props?.accessibilityRole === 'button', h.get('ScrollView')).length, 0);
    buttons[1].props.onPress(); h.render();
    assert.equal(commits.length, 1); assert.equal(commits[0][1].primary, '#123456');
    assert.equal(h.get('TextInput').props.value, 'Dual');
    h.get('FlatList').props.renderItem({ item: dual }).props.onPress(); h.render();
    routeBack(); h.render();
    assert.equal(picker(), undefined); assert.equal(commits.length, 1);
    root().props.onLayout({ nativeEvent: { layout: { width: 390, height: 844 } } }); h.render();
    assert.equal(toggle(), undefined, 'portrait header returns after the keyboard resize ends');
    assert.equal(h.get('TextInput').props.value, 'Dual');
  });

  test(`${platform} standalone picker follows its measured root and keeps hex input inline`, () => {
    const h = mount('font-color-picker', 'FontColorPicker', { choice: dual, previewText: 'Text', onBack() {}, onSave() {} },
      { platform, resolveChildren: true });
    const root = () => h.get('KeyboardAvoidingView');
    assert.equal(root().props.enabled, true);
    assert.equal(root().props.behavior, platform === 'ios' ? 'padding' : undefined);
    assert.equal(root().props.children.props.style.padding, 18);
    root().props.onLayout({ nativeEvent: { layout: { width: 300, height: 230 } } }); h.render();
    assert.equal(root().props.children.props.style.padding, 12);
    const input = () => h.get('TextInput');
    assert.equal(input().props.disableFullscreenUI, true);
    input().props.onChangeText('#ABCDEF'); h.render();
    assert.equal(input().props.value, '#ABCDEF');
    root().props.onLayout({ nativeEvent: { layout: { width: 390, height: 844 } } }); h.render();
    assert.equal(root().props.children.props.style.padding, 18);
    assert.equal(input().props.value, '#ABCDEF');
  });
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

test('keyboard-short wide font forms preserve the color draft and use a native measured body beside actions', () => {
  const h = mount('font-color-picker', 'FontColorPicker', { choice: dual, previewText: 'Long caption', onBack() {}, onSave() {} }, { resolveChildren: true });
  const root = () => h.get('KeyboardAvoidingView');
  h.get('TextInput').props.onChangeText('#ABCDEF'); h.render();
  root().props.onLayout({ nativeEvent: { layout: { width: 900, height: 150 } } }); h.render();
  assert.equal(root().props.children.props.style.flexDirection, 'row');
  assert.ok(h.all(node => node.props?.collapsable === false).length);
  assert.equal(h.get('TextInput').props.value, '#ABCDEF');
  assert.ok(h.get('TextInput').props.style.minHeight >= 44);
  assert.equal(typeof h.get('TextInput').props.onFocus, 'function');
  assert.equal(h.all(node => node.props?.accessibilityRole === 'button', h.get('ScrollView')).length, 0);
  root().props.onLayout({ nativeEvent: { layout: { width: 390, height: 844 } } }); h.render();
  assert.equal(root().props.children.props.style.flexDirection, 'column');
  assert.equal(h.get('TextInput').props.value, '#ABCDEF');
});

test('short-wide font search shares a header row while library actions use the controller exactly once', () => {
  const remembered = [], favorites = [];
  const h = mount('font-browser', 'FontBrowser', { visible: true, previewText: 'Text', onClose() {}, onSelect() {} }, { remembered, favorites });
  const root = h.all(node => node.props?.testID === 'font-browser-root')[0];
  root.props.onLayout({ nativeEvent: { layout: { width: 900, height: 150 } } }); h.render();
  const search = h.get('TextInput');
  assert.equal(search.props.style.flex, 1);
  assert.equal(search.props.style.height, 48);
  const card = h.get('FlatList').props.renderItem({ item: dual });
  h.all(node => node.type === 'Pressable', card)[1].props.onPress({ stopPropagation() {} });
  assert.deepEqual(favorites, ['dual']);
  card.props.onPress(); h.render(); h.get('FontColorPicker').props.onSave({ primary: '#FFFFFF', secondary: '#000000' });
  assert.deepEqual(remembered, ['dual']);
});
