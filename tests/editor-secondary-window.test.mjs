import assert from 'node:assert/strict';
import { keyboardViewportHostProps } from './keyboard-viewport-host.mjs';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const sources = Object.fromEntries(['watermark-sheet', 'extract-audio-source-sheet', 'dual-language-picker'].map(name => [name,
  ts.transpileModule(readFileSync(new URL(`../src/components/editor/${name}.tsx`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText,
]));
const spanish = { tag: 'es', displayName: 'Spanish', automatic: true };

// Execute the actual components. Host layout events and native primitives are mocked;
// this proves render structure and handlers, not native pixel or keyboard behavior.
function mount(name, exportName, props, options = {}) {
  const reveal = { viewportRef: { current: null }, focus() {}, blur() {}, onViewportLayout() {}, onScroll() {}, onScrollBeginDrag() {} };
  const slots = [];
  let cursor = 0, tree, effects;
  const react = {
    useRef: (value) => react.useState(() => ({ current: value }))[0],
    useCallback: (fn) => fn,
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useCallback: fn => fn,
    useMemo: fn => fn(),
    useEffect: fn => effects.push(fn),
  };
  const native = Object.fromEntries(['Modal', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View', 'KeyboardAvoidingView', 'ActivityIndicator'].map(name => [name, name]));
  native.Platform = { OS: options.platform ?? 'android' };
  native.useWindowDimensions = () => options.window ?? { width: 390, height: 844, fontScale: 1 };
  const exports = {};
  runInNewContext(sources[name], { exports, Error, require(id) {
    if (id === 'react') return react;
    if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props: keyboardViewportHostProps(type, props, options.bottomInsetCovered) }), jsxs: (type, props) => ({ type, props: keyboardViewportHostProps(type, props, options.bottomInsetCovered) }) };
    if (id === 'react-native') return native;
    if (id === '@/hooks/use-focused-input-reveal') return { useFocusedInputReveal: () => [reveal.viewportRef, reveal] };
if (id === '@/components/editor/keyboard-viewport') return { KeyboardViewport: 'KeyboardViewport' };
    if (id === 'react-native-safe-area-context') return { useSafeAreaInsets: () => options.insets ?? { top: 0, bottom: 24, left: 30, right: 18 } };
    if (id === 'expo-image') return { Image: 'Image' };
    if (id.endsWith('ui-theme')) return { chrome: { radius: { sm: 8, md: 12, lg: 16, xl: 24, pill: 999 } } };
    if (id.endsWith('caption-languages')) return { dualCaptionLanguageChoices: () => [spanish] };
    if (id.endsWith('dual-language-choice-copy')) return { dualLanguageChoiceCopy: () => ({ badge: 'Automatic', detail: 'Private translation' }) };
    throw new Error(`Unexpected import: ${id}`);
  } });
  function all(predicate, root = tree) {
    if (Array.isArray(root)) return root.flatMap(node => all(predicate, node));
    if (!root || typeof root !== 'object') return [];
    return [...(predicate(root) ? [root] : []), ...all(predicate, root.props?.children ?? null)];
  }
  function render() {
    cursor = 0; effects = []; tree = exports[exportName](props);
    effects.forEach(fn => fn());
  }
  render();
  const get = type => all(node => node.type === type)[0];
  const id = value => all(node => node.props?.testID === value)[0]
    ?? (value.endsWith('-root') ? get('View') : value.endsWith('-card') ? all(node => node.type === 'View')[1] : undefined);
  const label = value => all(node => node.props?.accessibilityLabel === value)[0];
  return { all, get, id, label, render, measure(height) {
    const root = id(`${name}-root`);
    assert.ok(root, 'actual modal root must measure the usable window');
    assert.equal(typeof root.props.onLayout, 'function', 'sheet must react to the measured usable window, including keyboard resize');
    root.props.onLayout({ nativeEvent: { layout: { width: 300, height } } }); render();
  } };
}

function assertSafeBody(h, name) {
  const root = h.id(`${name}-root`);
  assert.ok(root.props.style.paddingLeft >= 30);
  assert.ok(root.props.style.paddingRight >= 18);
  const body = h.get('ScrollView');
  assert.equal(body.props.style.flexShrink, 1);
  assert.equal(body.props.style.minHeight, 0);
  assert.equal(body.props.keyboardShouldPersistTaps, 'handled');
  return body;
}

for (const platform of ['android', 'ios']) {
  test(`${platform}: watermark form scrolls within the measured short sheet and preserves draft across resizing`, () => {
    const added = [], selected = [], removed = [];
    let closes = 0;
    const h = mount('watermark-sheet', 'WatermarkSheet', {
      visible: true, watermarks: [{ id: 'mark', text: 'Existing label' }], maxWatermarks: 5,
      onAdd: text => added.push(text), onSelect: id => selected.push(id), onRemove: id => removed.push(id), onClose: () => closes++,
    }, { platform });
    assert.equal(h.id('watermark-sheet-card').props.style.maxHeight, '76%');
    h.get('TextInput').props.onChangeText('  Draft words  '); h.render();
    h.measure(230);
    const body = assertSafeBody(h, 'watermark-sheet');
    assert.equal(h.id('watermark-sheet-card').props.style.maxHeight, '100%');
    const viewport = h.get('KeyboardViewport');
    assert.ok(viewport);
    assert.equal(viewport.props.enabled ?? true, true);
    assert.equal(viewport.props.iosAvoidance ?? true, true);
    assert.equal(viewport.props.style.flex, 1);
    assert.equal(viewport.props.style.minHeight, 0);
    assert.equal(viewport.props.children, h.id('watermark-sheet-root'), 'measurement belongs to the reduced child');
    assert.equal(h.get('KeyboardAvoidingView'), undefined);
    assert.equal(h.get('TextInput').props.disableFullscreenUI, true);
    assert.equal(h.all(node => node.type === 'TextInput', body).length, 1);
    assert.equal(h.all(node => node.props?.accessibilityLabel === 'Add watermark', body).length, 1);
    assert.equal(h.all(node => node.props?.accessibilityLabel === 'Close watermarks', body).length, 0);
    assert.ok(h.label('Close watermarks').props.style.minHeight >= 44);
    h.measure(844);
    assert.equal(h.get('TextInput').props.value, '  Draft words  ');
    assert.equal(h.id('watermark-sheet-card').props.style.maxHeight, '76%');
    h.label('Select watermark 1').props.onPress(); h.label('Remove watermark 1').props.onPress();
    assert.deepEqual(selected, ['mark']); assert.deepEqual(removed, ['mark']);
    h.label('Add watermark').props.onPress(); h.render();
    assert.deepEqual(added, ['Draft words']); assert.equal(h.get('TextInput').props.value, '');
    h.get('Modal').props.onRequestClose(); assert.equal(closes, 1);
  });
}

test('watermark limit disables editing and Add without hiding existing actions', () => {
  const h = mount('watermark-sheet', 'WatermarkSheet', {
    visible: true, watermarks: [{ id: 'a', text: 'A' }], maxWatermarks: 1,
    onAdd() {}, onSelect() {}, onRemove() {}, onClose() {},
  });
  h.measure(230);
  assert.equal(h.get('TextInput').props.editable, false);
  assert.equal(h.label('Add watermark').props.disabled, true);
  assert.ok(h.label('Select watermark 1')); assert.ok(h.label('Remove watermark 1'));
});

test('audio sources and secondary actions share a bounded short body; busy locks native Back and selection', () => {
  const chosen = []; let another = 0, closes = 0;
  const props = {
    visible: true, busy: false, sources: [{ id: 'video', displayName: 'My clip', durationMs: 61000, thumbnailUri: 'file://frame' }],
    onChoose: id => chosen.push(id), onChooseAnother: () => another++, onClose: () => closes++,
  };
  const h = mount('extract-audio-source-sheet', 'ExtractAudioSourceSheet', props);
  assert.equal(h.id('extract-audio-source-sheet-card').props.style.maxHeight, '78%');
  h.measure(230);
  const body = assertSafeBody(h, 'extract-audio-source-sheet');
  assert.equal(h.id('extract-audio-source-sheet-card').props.style.maxHeight, '100%');
  assert.equal(h.all(node => node.props?.accessibilityLabel === 'Choose another video from phone', body).length, 1);
  assert.equal(h.all(node => node.props?.accessibilityLabel === 'Close audio source picker', body).length, 0);
  assert.ok(h.label('Close audio source picker').props.style.minHeight >= 44);
  assert.ok(h.all(node => node.props?.children === '1:01', body).length);
  h.label('Extract audio from My clip').props.onPress(); h.label('Choose another video from phone').props.onPress();
  assert.deepEqual(chosen, ['video']); assert.equal(another, 1);
  props.busy = true; h.render();
  assert.equal(h.label('Extract audio from My clip').props.disabled, true);
  assert.equal(h.label('Choose another video from phone').props.disabled, true);
  assert.equal(h.label('Close audio source picker').props.disabled, true);
  h.get('Modal').props.onRequestClose(); assert.equal(closes, 0);
  props.busy = false; h.render(); h.get('Modal').props.onRequestClose(); assert.equal(closes, 1);
  h.measure(844); assert.equal(h.id('extract-audio-source-sheet-card').props.style.maxHeight, '78%');
});

test('language intro and long retry error scroll in a short measured window; pending choice blocks Back', async () => {
  let routeBack, rejectChoice, closes = 0, attempts = 0;
  const h = mount('dual-language-picker', 'DualLanguagePicker', {
    visible: true, sourceLanguageTag: 'en', sourceLanguageLabel: 'English', automaticModelLabel: 'Model',
    onClose: () => closes++, onBackRequestChange: fn => { routeBack = fn; },
    onChoose: () => { attempts++; return new Promise((resolve, reject) => { rejectChoice = reject; }); },
  });
  h.measure(230);
  let body = assertSafeBody(h, 'dual-language-picker');
  assert.ok(h.all(node => node.props?.testID === 'dual-language-picker-intro', body).length);
  assert.equal(h.all(node => node.props?.accessibilityLabel === 'Close language picker', body).length, 0);
  assert.ok(h.label('Close language picker').props.style.minHeight >= 44);
  const choice = () => h.label('Add Spanish subtitles, generated on this phone');
  choice().props.onPress(); h.render();
  assert.equal(choice().props.disabled, true); assert.equal(h.label('Close language picker').props.disabled, true);
  routeBack(); h.get('Modal').props.onRequestClose(); assert.equal(closes, 0);
  rejectChoice(new Error('Download consent required. '.repeat(30)));
  await new Promise(setImmediate); h.render();
  body = h.get('ScrollView');
  assert.equal(h.all(node => node.props?.accessibilityRole === 'alert', body).length, 1);
  assert.equal(choice().props.disabled, false);
  choice().props.onPress(); h.render(); assert.equal(attempts, 2);
  rejectChoice(new Error('Retry later')); await new Promise(setImmediate); h.render();
  h.measure(844); assert.equal(h.all(node => node.props?.testID === 'dual-language-picker-intro', h.get('ScrollView')).length, 0);
  routeBack(); h.render(); assert.equal(closes, 1);
  assert.equal(h.all(node => node.props?.accessibilityRole === 'alert').length, 0);
});

test('large language text moves the intro into the scroll body even in a tall window', () => {
  const h = mount('dual-language-picker', 'DualLanguagePicker', {
    visible: true, sourceLanguageTag: 'en', sourceLanguageLabel: 'English', automaticModelLabel: 'Model', onClose() {}, onChoose: async () => {},
  }, { window: { width: 390, height: 844, fontScale: 2 } });
  assert.ok(h.all(node => node.props?.testID === 'dual-language-picker-intro', h.get('ScrollView')).length);
});

test('watermark entry and Add share the short-wide body without resetting the draft', () => {
  const h = mount('watermark-sheet', 'WatermarkSheet', { visible: true, watermarks: [], maxWatermarks: 5, onAdd() {}, onSelect() {}, onRemove() {}, onClose() {} });
  h.get('TextInput').props.onChangeText('Keep draft'); h.render();
  h.id('watermark-sheet-root').props.onLayout({ nativeEvent: { layout: { width: 900, height: 150 } } }); h.render();
  assert.equal(h.id('watermark-sheet-card').props.style.flexDirection, 'row');
  assert.ok(h.all(node => node.props?.collapsable === false).length);
  assert.equal(h.get('TextInput').props.value, 'Keep draft');
  assert.ok(h.get('TextInput').props.style.minHeight >= 44);
  assert.ok(h.label('Add watermark').props.style.minHeight >= 44);
  assert.equal(h.all(node => node.props?.accessibilityLabel === 'Close watermarks', h.get('ScrollView')).length, 0);
  h.measure(844); assert.equal(h.get('TextInput').props.value, 'Keep draft');
});

test('watermark entry consumes the measured host inset rather than reserving navigation below the keyboard twice', () => {
  const h = mount('watermark-sheet', 'WatermarkSheet', {
    visible: true, watermarks: [], maxWatermarks: 5, onAdd() {}, onSelect() {}, onRemove() {}, onClose() {},
  }, { bottomInsetCovered: true });
  assert.equal(h.id('watermark-sheet-root').props.style.paddingBottom, 0);
  assert.equal(h.id('watermark-sheet-root').props.style.paddingLeft, 30);
  assert.equal(h.id('watermark-sheet-root').props.style.paddingRight, 18);
});
