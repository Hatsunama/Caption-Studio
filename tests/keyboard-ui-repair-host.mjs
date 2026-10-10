import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as draftHelpers from '../src/lib/dual-caption-drafts.ts';
import * as saveRecoveryHelpers from '../src/components/editor/caption-save-recovery.ts';
import { fontChoicePatch } from '../src/lib/font-style-choice.ts';
import { keyboardViewportHostProps } from './keyboard-viewport-host.mjs';
const source = readFileSync(process.env.DUAL_CAPTION_EDITOR_SOURCE
  ?? new URL('../src/components/editor/dual-caption-editor.tsx', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  fileName: 'dual-caption-editor.tsx',
});
const plain = (value) => JSON.parse(JSON.stringify(value));
export const pairs = (count = 3) => Array.from({ length: count }, (_, index) => ({
  trackId: 'zh', languageTag: 'zh-Hans', visible: true, timelineVisible: true,
  startMs: index * 1000, endMs: (index + 1) * 1000, style: { fontSize: 34 },
  source: { id: `cue-${index}`, text: `Source ${index}`, wordIds: [] },
  translation: { id: `translation-${index}`, text: `Translation ${index}`, status: 'translated' },
}));
const same = (left, right) => left && right && left.length === right.length
  && left.every((value, index) => Object.is(value, right[index]));
const shallow = (left, right) => left && right && same(Object.keys(left), Object.keys(right))
  && Object.keys(left).every((key) => Object.is(left[key], right[key]));

export function mountDual(overrides = {}, options = {}) {
  const focusCalls = [], blurCalls = [];
  const reveal = { viewportRef: { current: null }, focus(input) { focusCalls.push(input); }, blur(input) { blurCalls.push(input); }, onViewportLayout() {}, onScroll() {}, onScrollBeginDrag() {} };
  const instances = new Map(), timers = new Map(), inputIdentities = new Map();
  const calls = { alerts: [], reads: [], writes: [], clears: [], saves: [], refresh: [], skip: [], close: 0, cancel: 0, retry: 0, dismiss: 0, visibility: 0, remove: 0, renders: new Map() };
  let current, cursor, pending = [], changed = false, tree, now = 0, nextTimer = 0, windowStart = 0;
  const memoHook = (factory, deps) => {
    const index = cursor++;
    if (!current.slots[index] || !same(current.slots[index].deps, deps)) current.slots[index] = { value: factory(), deps };
    return current.slots[index].value;
  };
  const effect = (callback, deps) => {
    const instance = current, index = cursor++;
    if (!instance.slots[index] || !same(instance.slots[index].deps, deps)) pending.push(() => {
      instance.slots[index]?.cleanup?.();
      instance.slots[index] = { deps, cleanup: callback() };
    });
  };
  const react = {
    memo: (fn) => ({ fn }), useMemo: memoHook, useCallback: (fn, deps) => memoHook(() => fn, deps),
    useRef: (value) => memoHook(() => ({ current: value }), []),
    useEffect: effect, useLayoutEffect: effect,
    useState(initial) {
      const instance = current, index = cursor++;
      instance.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [instance.slots[index].value, (value) => {
        const next = typeof value === 'function' ? value(instance.slots[index].value) : value;
        if (!Object.is(next, instance.slots[index].value)) {
          instance.slots[index].value = next; instance.dirty = true; changed = true;
        }
      }];
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const instance = current;
      const slot = memoHook(() => ({ value: getSnapshot() }), []);
      slot.value = getSnapshot();
      effect(() => {
        const check = () => {
          if (!Object.is(slot.value, getSnapshot())) { instance.dirty = true; changed = true; }
        };
        const unsubscribe = subscribe(check); check(); return unsubscribe;
      }, [subscribe, getSnapshot]);
      return slot.value;
    },
  };
  const jsx = (type, props, key) => ({ type, props: keyboardViewportHostProps(type, props ?? {}, options.bottomInsetCovered), key });
  const exports = {};
  runInNewContext(`${outputText}\nexports.Store = typeof DualCaptionDraftStore === 'undefined' ? undefined : DualCaptionDraftStore;`, {
    exports,
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === '@/hooks/use-focused-input-reveal') return { useFocusedInputReveal: () => [reveal.viewportRef, reveal] };
if (name === '@/components/editor/keyboard-viewport') return { KeyboardViewport: 'KeyboardViewport' };
      if (name === 'react-native') return {
        ...Object.fromEntries(['ActivityIndicator', 'FlatList', 'Modal', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View', 'KeyboardAvoidingView'].map((type) => [type, type])),
        useWindowDimensions: () => options.window ?? { width: 390, height: 844 },
        Platform: { OS: options.platform ?? 'android' },
        Alert: { alert: (...args) => calls.alerts.push(args) },
      };
      if (name === 'react-native-safe-area-context') return { useSafeAreaInsets: () => options.insets ?? { top: 0, bottom: 24, left: 0, right: 0 } };
      if (name === '@/lib/ui-theme') return { chrome: { radius: { lg: 12, md: 8, pill: 20, xl: 20 } } };
      if (name === '@/lib/dual-caption-drafts') return draftHelpers;
      if (name === './caption-save-recovery') return saveRecoveryHelpers;
      if (name === '@/services/editor-draft-journal') return {
        archiveEditorDraftJournal: async () => {},
        readEditorDraftJournal: async (...args) => { calls.reads.push(args); return options.read ? options.read(...args) : options.journal; },
        writeEditorDraftJournal: async (...args) => { calls.writes.push(args); if (options.writeError) throw new Error('storage full'); },
        clearEditorDraftJournal: async (...args) => { calls.clears.push(args); if (options.clearError) throw new Error('clear failed'); },
      };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    setTimeout(callback, delay) { timers.set(++nextTimer, { callback, at: now + delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  });
  let props = {
    visible: true, projectId: 'project', baseRevision: 'r1', trackId: 'zh', pairs: pairs(),
    sourceLanguageLabel: 'English', targetLanguageLabel: 'Chinese', trackVisible: true,
    automaticTranslation: true, busy: false, retryErrorAvailable: false,
    onSave: async (edits) => { calls.saves.push(plain(edits)); return false; },
    onClose: () => { calls.close++; }, onRefresh: (ids) => calls.refresh.push(plain(ids)),
    onSkip: (...args) => calls.skip.push(args), onToggleVisibility: () => { calls.visibility++; },
    onRemove: () => { calls.remove++; }, onCancelBusy: () => { calls.cancel++; },
    onRetryError: () => { calls.retry++; }, onDismissError: () => { calls.dismiss++; }, ...overrides,
  };
  function renderNode(node, path, visited, inputs) {
    if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${path}/${child?.key ?? index}`, visited, inputs));
    if (!node || typeof node !== 'object') return node;
    const fn = node.type?.fn ?? (typeof node.type === 'function' ? node.type : undefined);
    if (fn) {
      const id = `${path}:${fn.name}:${node.key ?? ''}`;
      visited.add(id);
      let instance = instances.get(id);
      if (!instance) { instance = { slots: [], dirty: true }; instances.set(id, instance); }
      if (instance.dirty || !(node.type?.fn ? shallow(instance.props, node.props) : instance.props === node.props)) {
        current = instance; cursor = 0; instance.dirty = false; instance.props = node.props;
        const renderKey = fn.name === 'DualCaptionRow' ? `row:${node.props.pair.source.id}` : fn.name;
        calls.renders.set(renderKey, (calls.renders.get(renderKey) ?? 0) + 1);
        instance.output = fn(node.props);
      }
      return renderNode(instance.output, `${id}/output`, visited, inputs);
    }
    let children = node.props.children;
    if (node.type === 'FlatList') children = [node.props.ListHeaderComponent,
      ...node.props.data.slice(windowStart, windowStart + node.props.initialNumToRender)
        .map((item, index) => ({ ...node.props.renderItem({ item, index: windowStart + index }), key: node.props.keyExtractor(item) })),
      node.props.ListFooterComponent];
    if (node.type === 'TextInput') {
      const id = `${path}:${node.key ?? ''}`;
      inputs.add(id);
      if (!inputIdentities.has(id)) inputIdentities.set(id, {});
      if (node.props.ref) node.props.ref.current = inputIdentities.get(id);
      return { ...node, identity: inputIdentities.get(id) };
    }
    return { ...node, props: { ...node.props, children: renderNode(children, `${path}/children`, visited, inputs) } };
  }
  function render() {
    let passes = 0;
    do {
      assert.ok(++passes < 30, 'editor must settle without a render loop');
      changed = false; pending = [];
      const visited = new Set(), inputs = new Set();
      tree = renderNode(jsx(exports.DualCaptionEditor, props), 'root', visited, inputs);
      for (const [id, instance] of instances) if (!visited.has(id)) {
        instance.slots.forEach((slot) => slot?.cleanup?.()); instances.delete(id);
      }
      for (const id of inputIdentities.keys()) if (!inputs.has(id)) inputIdentities.delete(id);
      for (const callback of pending) callback();
    } while (changed);
  }
  function all(predicate, node = tree) {
    const walk = (value) => {
      if (Array.isArray(value)) return value.flatMap(walk);
      if (!value || typeof value !== 'object') return [];
      return [...(predicate(value) ? [value] : []), ...walk(value.props?.children)];
    };
    return walk(node);
  }
  function text(node) {
    if (Array.isArray(node)) return node.map(text).join('');
    return node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '');
  }
  const button = (label) => {
    const found = all((node) => node.type === 'Pressable'
      && (node.props.accessibilityLabel === label || text(node) === label))[0];
    assert.ok(found, `missing button: ${label}`); return found;
  };
  const input = (index, language = 'English') => {
    const found = all((node) => node.type === 'TextInput' && node.props.accessibilityLabel === `${language} subtitle ${index + 1} text`)[0];
    assert.ok(found, `missing ${language} input ${index}`); return found;
  };
  function act(callback) { callback(); render(); }
  async function flush() { for (let index = 0; index < 10; index++) { await Promise.resolve(); render(); } }
  render();
  return {
    calls, focusCalls, blurCalls, all, button, input, flush, act, Store: exports.Store,
    get props() { return props; },
    update(next) { props = { ...props, ...next }; render(); },
    scroll(index) { windowStart = index; render(); },
    edit(index, value, language = 'English') { const node = input(index, language); assert.equal(node.props.editable, true); act(() => node.props.onChangeText(value)); },
    press(label) { const node = button(label); assert.ok(!node.props.disabled, `disabled: ${label}`); act(() => node.props.onPress()); },
    choose(label) { const choice = calls.alerts.at(-1)?.[2].find((entry) => entry.text === label); assert.ok(choice, `missing alert choice: ${label}`); act(() => choice.onPress?.()); },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
      await flush();
    },
  };
}

const solid = { font: { id: 'solid', family: 'Solid', source: 'built-in' }, name: 'Bungee', mood: 'Clean', treatment: 'solid' };
const dual = { ...solid, font: { ...solid.font, id: 'dual' }, name: 'Dual', treatment: 'duotone-offset', colors: { primary: '#DFFF35', secondary: '#6A35FF' } };
const sources = Object.fromEntries(['font-browser', 'font-color-picker', 'watermark-sheet'].map((name) => [name, ts.transpileModule(
  readFileSync(new URL(`../src/components/editor/${name}.tsx`, import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } },
).outputText]));

export function mountFont(name, exportName, props, options = {}) {
  const focusCalls = [], blurCalls = [];
  const nativeRefs = new Map();
  const reveal = { viewportRef: { current: null }, focus(input) { focusCalls.push(input); }, blur(input) { blurCalls.push(input); }, onViewportLayout() {}, onScroll() {}, onScrollBeginDrag() {} };
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
      if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props: keyboardViewportHostProps(type, props, options.bottomInsetCovered) }), jsxs: (type, props) => ({ type, props: keyboardViewportHostProps(type, props, options.bottomInsetCovered) }) };
      if (id === 'react-native') return native;
      if (id === '@/hooks/use-focused-input-reveal') return { useFocusedInputReveal: () => [reveal.viewportRef, reveal] };
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
    if (node.type === 'TextInput' && node.props.ref) {
      if (!nativeRefs.has(path)) nativeRefs.set(path, {});
      node.props.ref.current = nativeRefs.get(path);
    }
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
  return { render, all, focusCalls, blurCalls, get: (type) => all((node) => node.type === type)[0] };
}
