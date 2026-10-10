import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync(new URL('../src/components/editor/adaptive-dialog.tsx', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function mount(props, insets, platform = 'android') {
  const exports = {};
  const states = [];
  let cursor = 0;
  let latest;
  const calls = [];
  const react = {
    createContext: value => {
      const context = { value };
      context.Provider = { context };
      return context;
    },
    useContext: context => context.value,
    useState: initial => {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useRef: initial => {
      const index = cursor++;
      return states[index] ?? (states[index] = { current: initial });
    },
    useCallback: callback => callback,
  };
  runInNewContext(compiled, { exports, require(id) {
    if (id === 'react') return react;
    if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (id === 'react-native') return { Platform: { OS: platform }, ...Object.fromEntries(['KeyboardAvoidingView', 'Pressable', 'ScrollView', 'View', 'TextInput'].map(key => [key, key])) };
    if (id === '@/hooks/use-focused-input-reveal') return { useFocusedInputReveal: scrollToOffset => ({
      viewportRef: { current: null },
      focus(input) { calls.push(['focus', input]); },
      blur(input) { calls.push(['blur', input]); },
      onViewportLayout(event) { calls.push(['viewport', event]); scrollToOffset(32); },
      onScroll(event) { calls.push(['scroll', event]); },
      onScrollBeginDrag(event) { calls.push(['drag', event]); },
    }) };
    if (id === 'react-native-safe-area-context') return { useSafeAreaInsets: () => insets };
    if (id === '@/components/editor/keyboard-viewport') return { KeyboardViewport: 'KeyboardViewport' };
    if (id.endsWith('ui-theme')) return { chrome: { radius: { xl: 20 } } };
    throw Error('Unexpected dependency: ' + id);
  } });
  const render = () => { cursor = 0; latest = exports.AdaptiveDialog(props); return latest; };
  const root = render();
  // Keep state between layout events, as a mounted component does.
  Object.defineProperty(root, 'rerender', { value: render });
  Object.defineProperty(root, 'calls', { value: calls });
  Object.defineProperty(root, 'renderInput', { value: inputProps => {
    const provider = walk(latest, n => n.type?.context)[0];
    provider.type.context.value = provider.props.value;
    cursor = 100; // Separate, persistent hook slots for the child component.
    return exports.AdaptiveDialogTextInput(inputProps);
  } });
  return root;
}
function walk(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(n => walk(n, predicate));
  if (!node || typeof node !== 'object') return [];
  return [...(predicate(node) ? [node] : []), ...walk(node.props?.children, predicate)];
}

test('keyboard viewport contains both the dialog body and footer and honors keyboard opt-in', () => {
  for (const platform of ['android', 'ios']) {
    for (const keyboard of [undefined, false, true]) {
      const footer = { type: 'Button', props: { children: 'Save' } };
      const root = mount({ children: 'Editable content', footer, keyboard }, { top: 0, bottom: 12, left: 0, right: 0 }, platform);
      assert.equal(root.type, 'KeyboardViewport');
      assert.equal(root.props.enabled, Boolean(keyboard));
      assert.equal(root.props.iosAvoidance ?? true, true);
      assert.equal(root.props.style.flex, 1);
      assert.equal(root.props.style.minHeight, 0);
      assert.equal(root.props.children.props.testID, 'adaptive-dialog-frame');
      assert.equal(walk(root, n => n.props?.testID === 'adaptive-dialog-body').length, 1);
      assert.equal(walk(root, n => n === footer).length, 1);
      assert.equal(walk(root, n => n.type === 'KeyboardAvoidingView').length, 0);
    }
  }
});

test('bounded cards keep long content scrollable and actions outside its scroll region', () => {
  const footer = { type: 'Button', props: { children: 'Save' } };
  const content = { type: 'Input', props: {} };
  const root = mount({ children: content, footer, keyboard: true }, { top: 0, bottom: 12, left: 30, right: 20 });
  const frame = walk(root, n => n.props?.testID === 'adaptive-dialog-frame')[0];
  assert.ok(frame.props.style.paddingLeft >= 30 && frame.props.style.paddingRight >= 20);
  const card = walk(root, n => n.type === 'Pressable')[0];
  assert.equal(card.props.style[0].maxHeight, '100%');
  const body = walk(root, n => n.type === 'ScrollView')[0];
  assert.equal(body.props.style.flexShrink, 1);
  assert.equal(walk(body, n => n === footer).length, 0);
  assert.equal(walk(root, n => n === footer).length, 1);
  assert.equal(walk(body, n => n === content).length, 1);
  let stopped = false; card.props.onPress({ stopPropagation() { stopped = true; } }); assert.equal(stopped, true);
});

test('sheets respect landscape cutouts and preserve their established portrait padding', () => {
  for (const insets of [{ top: 0, bottom: 0, left: 0, right: 0 }, { top: 20, bottom: 48, left: 30, right: 10 }]) {
    const root = mount({ children: 'Options', sheet: true, footer: 'Done' }, insets);
    const frame = walk(root, n => n.props?.testID === 'adaptive-dialog-frame')[0];
    assert.equal(frame.props.style.justifyContent, 'flex-end');
    const footer = walk(root, n => n.props?.testID === 'adaptive-dialog-footer')[0];
    assert.equal(footer.props.style.paddingBottom, Math.max(34, insets.bottom));
  }
});

test('measured keyboard frame gives a short-wide body its own height beside fixed actions', () => {
  const content = { type: 'Input', props: { value: 'Long draft' } };
  const footer = { type: 'Button', props: { style: { minHeight: 48 }, children: 'Save' } };
  const initial = mount({ children: content, footer, keyboard: true, padding: 20, framePadding: 24 },
    { top: 0, bottom: 12, left: 30, right: 20 });
  const frame = walk(initial, n => n.props?.testID === 'adaptive-dialog-frame')[0];
  assert.equal(typeof frame.props.onLayout, 'function', 'must respond to actual keyboard-reduced frame layout');
  frame.props.onLayout({ nativeEvent: { layout: { width: 740, height: 150 } } });
  const short = initial.rerender();
  const shortFrame = walk(short, n => n.props?.testID === 'adaptive-dialog-frame')[0];
  const card = walk(short, n => n.type === 'Pressable')[0];
  const body = walk(short, n => n.props?.testID === 'adaptive-dialog-body')[0];
  const actions = walk(short, n => n.props?.testID === 'adaptive-dialog-footer')[0];
  assert.equal(card.props.style[0].flexDirection, 'row');
  assert.equal(body.props.style.flex, 1);
  assert.equal(actions.props.style.flexShrink, 0);
  assert.ok(150 - shortFrame.props.style.paddingTop - shortFrame.props.style.paddingBottom
    - body.props.contentContainerStyle.paddingTop - body.props.contentContainerStyle.paddingBottom >= 44);
  assert.equal(walk(body, n => n === footer).length, 0);
  assert.equal(walk(body, n => n === content).length, 1);
  assert.equal(walk(short, n => n === footer).length, 1);
  frame.props.onLayout({ nativeEvent: { layout: { width: 390, height: 700 } } });
  const portrait = initial.rerender();
  assert.equal(walk(portrait, n => n.type === 'Pressable')[0].props.style[0].flexDirection, 'column');
  assert.equal(walk(portrait, n => n.props?.testID === 'adaptive-dialog-body')[0].props.contentContainerStyle.paddingTop, 20);
  assert.equal(walk(portrait, n => n === content).length, 1);
});

test('sidecar requires keyboard, footer, width threshold, short height and a non-sheet card', () => {
  for (const [props, width, height] of [
    [{ keyboard: false, footer: 'Save' }, 740, 150],
    [{ keyboard: true }, 740, 150],
    [{ keyboard: true, footer: 'Save', sheet: true }, 740, 150],
    [{ keyboard: true, footer: 'Save' }, 599, 150],
    [{ keyboard: true, footer: 'Save' }, 740, 260],
  ]) {
    const initial = mount({ children: 'Draft', ...props }, { top: 0, bottom: 0, left: 0, right: 0 });
    walk(initial, n => n.props?.testID === 'adaptive-dialog-frame')[0].props.onLayout({ nativeEvent: { layout: { width, height } } });
    assert.equal(walk(initial.rerender(), n => n.type === 'Pressable')[0].props.style[0].flexDirection, 'column');
  }
});

test('measured body bounds multiline input and bridges native focus and scroll without replacing its ref', () => {
  const root = mount({ children: 'Draft', keyboard: true, footer: 'Save', padding: 20 },
    { top: 0, bottom: 0, left: 0, right: 0 });
  walk(root, n => n.props?.testID === 'adaptive-dialog-frame')[0].props.onLayout({ nativeEvent: { layout: { width: 740, height: 100 } } });
  let tree = root.rerender();
  const body = walk(tree, n => n.props?.testID === 'adaptive-dialog-body')[0];
  const viewport = walk(tree, n => n.props?.collapsable === false)[0];
  const scrolls = [];
  body.props.ref.current = { scrollTo: options => scrolls.push(options.y) };
  const layout = { nativeEvent: { layout: { width: 450, height: 84 } } };
  viewport.props.onLayout(layout);
  tree = root.rerender();
  let callerFocus = 0;
  let callerBlur = 0;
  let callerLayout = 0;
  const inputProps = { multiline: true, value: 'Long draft', style: { padding: 14 },
    onFocus() { callerFocus++; }, onBlur() { callerBlur++; }, onLayout() { callerLayout++; } };
  const input = root.renderInput(inputProps);
  const nativeInput = { name: 'focused native input' };
  input.props.ref.current = nativeInput;
  assert.equal(input.props.scrollEnabled, true);
  assert.equal(input.props.style[1].height, 68);
  assert.ok(input.props.style[1].minHeight >= 44);
  input.props.onFocus({});
  input.props.onLayout({});
  input.props.onContentSizeChange({});
  body.props.onScroll({ nativeEvent: { contentOffset: { y: 32 } } });
  body.props.onScrollBeginDrag({});
  assert.deepEqual(scrolls, [32]);
  assert.equal(root.calls.filter(([kind, node]) => kind === 'focus' && node === nativeInput).length, 3);
  assert.equal(root.calls.filter(([kind]) => kind === 'scroll').length, 1);
  assert.equal(root.calls.filter(([kind]) => kind === 'drag').length, 1);
  walk(tree, n => n.props?.testID === 'adaptive-dialog-frame')[0].props.onLayout({ nativeEvent: { layout: { width: 390, height: 700 } } });
  root.rerender();
  const rotatedInput = root.renderInput(inputProps);
  assert.equal(rotatedInput.props.ref, input.props.ref);
  assert.equal(rotatedInput.props.ref.current, nativeInput);
  rotatedInput.props.onBlur({});
  rotatedInput.props.onLayout({});
  assert.equal(root.calls.filter(([kind, node]) => kind === 'blur' && node === nativeInput).length, 1);
  assert.equal(root.calls.filter(([kind]) => kind === 'focus').length, 3);
  assert.equal(callerFocus, 1);
  assert.equal(callerBlur, 1);
  assert.equal(callerLayout, 2);
});
