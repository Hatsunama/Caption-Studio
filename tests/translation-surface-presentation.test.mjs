import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as captionTextBreaks from '../src/lib/caption-text-breaks.ts';

const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const code = compile('../src/components/editor/dual-caption-editor.tsx');
const backgroundCode = compile('../src/components/refract-background.tsx');
const themeCode = compile('../src/lib/ui-theme.ts');
const draftsCode = compile('../src/lib/dual-caption-drafts.ts');
const queueCode = compile('../src/components/editor/caption-save-recovery.ts');
function evaluate(source, dependencies, globals = {}) {
  const exports = {};
  runInNewContext(source, { exports, ...globals, require(id) {
    assert.ok(Object.hasOwn(dependencies, id), `Missing runtime stub: ${id}`);
    return dependencies[id];
  } });
  return exports;
}
const { chrome } = evaluate(themeCode, {});
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const text = node => Array.isArray(node) ? node.map(text).join('')
  : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '');
const walk = (node, predicate) => Array.isArray(node) ? node.flatMap(child => walk(child, predicate))
  : !node || typeof node !== 'object' ? [] : [...(predicate(node) ? [node] : []), ...walk(node.props?.children, predicate)];
const style = value => Object.assign({}, ...[value].flat(Infinity).filter(Boolean));

function mount(overrides = {}, options = {}) {
  const instances = new Map(), listeners = new Set(), timers = new Map();
  const calls = { cancel: 0, dismiss: 0, retry: 0, subscriptions: 0, removals: 0, alerts: [] };
  let current, cursor, dirty = true, pending = [], tree, timerId = 0;
  let dimensions = options.dimensions ?? { width: 390, height: 844 };
  let covered = false;
  const memo = (factory, deps) => {
    const index = cursor++;
    if (!same(current.slots[index]?.deps, deps)) current.slots[index] = { value: factory(), deps };
    return current.slots[index].value;
  };
  const effect = (callback, deps) => {
    const instance = current, index = cursor++;
    if (!same(instance.slots[index]?.deps, deps)) {
      const previous = instance.slots[index];
      const slot = instance.slots[index] = { deps };
      pending.push(() => { previous?.cleanup?.(); slot.cleanup = callback(); });
    }
  };
  const react = {
    memo: fn => fn, useMemo: memo, useCallback: (fn, deps) => memo(() => fn, deps),
    useRef: initial => memo(() => ({ current: initial }), []), useEffect: effect, useLayoutEffect: effect,
    useState(initial) {
      const instance = current, index = cursor++;
      instance.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      const slot = instance.slots[index];
      return [slot.value, next => {
        const value = typeof next === 'function' ? next(slot.value) : next;
        if (!Object.is(slot.value, value)) { slot.value = value; dirty = true; }
      }];
    },
    useSyncExternalStore(subscribe, snapshot) {
      const value = snapshot();
      effect(() => subscribe(() => { dirty = true; }), [subscribe]);
      return value;
    },
  };
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const runtime = { jsx, jsxs: jsx };
  const appState = {
    currentState: options.appState ?? 'active',
    addEventListener(event, callback) {
      assert.equal(event, 'change'); calls.subscriptions++; listeners.add(callback);
      return { remove() { calls.removals++; listeners.delete(callback); } };
    },
  };
  const native = {
    ...Object.fromEntries(['ActivityIndicator', 'FlatList', 'Modal', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View'].map(name => [name, name])),
    AppState: appState, Platform: { OS: options.platform ?? 'android' },
    useWindowDimensions: () => dimensions,
    Alert: { alert: (...args) => calls.alerts.push(args) },
  };
  const background = evaluate(backgroundCode, {
    'react/jsx-runtime': runtime, 'react-native': native,
    expo: { requireNativeView(name) { assert.equal(name, 'CaptionRefract'); return 'CaptionRefract'; } },
  });
  const reveal = { focus() {}, blur() {}, onScroll() {}, onScrollBeginDrag() {}, onViewportLayout() {} };
  const editor = evaluate(code, {
    react, 'react/jsx-runtime': runtime, 'react-native': native,
    'react-native-safe-area-context': { useSafeAreaInsets: () => options.insets ?? { top: 24, bottom: 20, left: 0, right: 0 } },
    '@/components/refract-background': background,
    '@/components/editor/keyboard-viewport': { KeyboardViewport: 'KeyboardViewport' },
    '@/hooks/use-focused-input-reveal': { useFocusedInputReveal: () => [{ current: null }, reveal] },
    '@/lib/ui-theme': { chrome }, '@/lib/dual-caption-drafts': evaluate(draftsCode, {
      '@/lib/caption-text-breaks': captionTextBreaks,
    }),
    './caption-save-recovery': evaluate(queueCode, {}),
    '@/services/editor-draft-journal': {
      readEditorDraftJournal: async () => undefined, archiveEditorDraftJournal: async () => {},
      clearEditorDraftJournal: async () => {}, writeEditorDraftJournal: async () => {},
    },
  }, { setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id) });
  let props = {
    visible: true, projectId: 'project', baseRevision: 'r1', trackId: 'zh',
    sourceLanguageLabel: 'English', targetLanguageLabel: 'Chinese', trackVisible: true,
    automaticTranslation: true, busy: true, translationActive: true, retryErrorAvailable: true,
    pairs: [{ source: { id: 'cue-1', text: 'Hello' }, translation: { text: 'Bonjour', status: 'translated' }, startMs: 0 }],
    onSave: async () => true, onClose() {}, onRefresh() {}, onSkip() {}, onToggleVisibility() {}, onRemove() {},
    onCancelBusy: () => { calls.cancel++; }, onDismissError: () => { calls.dismiss++; }, onRetryError: () => { calls.retry++; },
    ...overrides,
  };
  function renderNode(node, path, visited) {
    if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${path}/${child?.key ?? index}`, visited));
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      const id = `${path}:${node.type.name}:${node.key ?? ''}`;
      visited.add(id);
      if (!instances.has(id)) instances.set(id, { slots: [] });
      current = instances.get(id); cursor = 0;
      return renderNode(node.type(node.props), `${id}/out`, visited);
    }
    let children = node.props.children;
    if (node.type === 'KeyboardViewport' && typeof children === 'function') children = children({ safeAreaBottom: covered ? 0 : node.props.safeAreaBottom });
    if (node.type === 'FlatList') children = [node.props.ListHeaderComponent,
      ...node.props.data.slice(0, node.props.initialNumToRender).map((item, index) => node.props.renderItem({ item, index }))];
    return { ...node, props: { ...node.props, children: renderNode(children, `${path}/children`, visited) } };
  }
  function render() {
    let passes = 0;
    do {
      assert.ok(++passes < 30, 'render/effects must settle');
      dirty = false; pending = [];
      const visited = new Set();
      tree = renderNode(jsx(editor.DualCaptionEditor, props), 'root', visited);
      for (const [id, instance] of instances) if (!visited.has(id)) {
        instance.slots.forEach(slot => slot?.cleanup?.()); instances.delete(id);
      }
      pending.forEach(callback => callback());
    } while (dirty);
  }
  render();
  return {
    calls, listeners, timers,
    all: predicate => walk(tree, predicate),
    one(predicate) { const found = walk(tree, predicate); assert.equal(found.length, 1); return found[0]; },
    button(label) { return this.one(node => node.type === 'Pressable' && (node.props.accessibilityLabel === label || text(node) === label)); },
    update(next) { props = { ...props, ...next }; render(); },
    state(next) { appState.currentState = next; [...listeners].forEach(listener => listener(next)); render(); },
    rotate(next, keyboardCovered = false) { dimensions = next; covered = keyboardCovered; render(); },
    async settle() { for (let i = 0; i < 12; i++) { await Promise.resolve(); if (dirty) render(); } },
  };
}

function rgba(color) {
  if (color.startsWith('#')) return [...color.slice(1).match(/../g).map(v => parseInt(v, 16)), 1];
  const values = color.match(/[\d.]+/g).map(Number);
  assert.equal(values.length, 4, `Expected explicit RGBA: ${color}`);
  return values;
}
function over(front, back) { return front.slice(0, 3).map((v, i) => v * front[3] + back[i] * (1 - front[3])); }
function contrast(a, b) {
  const luminance = rgb => rgb.slice(0, 3).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const values = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (values[1] + 0.05) / (values[0] + 0.05);
}

test('one shared native background stays behind normal and busy content, with readable translucent layers', () => {
  const host = mount();
  const root = host.one(node => node.props.testID === 'dual-caption-root');
  const background = host.one(node => node.type === 'CaptionRefract');
  assert.equal(root.props.children[0], background, 'background precedes content');
  assert.equal(background.props.pointerEvents, 'none');
  assert.equal(style(background.props.style).position, 'absolute');
  assert.equal(style(background.props.style).inset, 0);
  const overlay = host.one(node => node.props.accessibilityViewIsModal);
  const card = walk(overlay, node => node.type === 'ScrollView')[0];
  const scrim = rgba(style(overlay.props.style).backgroundColor);
  const surface = rgba(style(card.props.style).backgroundColor);
  assert.ok(scrim[3] <= 0.45, 'busy scrim must reveal the shared background');
  assert.ok(surface[3] >= 0.8 && surface[3] < 1, 'readable card also transmits the background');
  const explanation = host.one(node => node.type === 'Text' && text(node).startsWith('Translations are happening locally'));
  assert.equal(style(explanation.props.style).fontSize, 16);
  assert.equal(style(explanation.props.style).lineHeight, 22);
  const explanationColor = rgba(style(explanation.props.style).color);
  assert.ok(explanationColor[1] > explanationColor[0] && explanationColor[2] > explanationColor[0], 'soft mint/cyan explanation');
  const cancel = host.button('Cancel');
  const cancelText = walk(cancel, node => node.type === 'Text')[0];
  for (const pixel of [[0, 0, 0], [255, 255, 255]]) {
    const cardPixel = over(surface, over(scrim, pixel));
    assert.ok(contrast(explanationColor, cardPixel) >= 4.5);
    assert.ok(contrast(rgba(style(cancelText.props.style).color), over(rgba(style(cancel.props.style).backgroundColor), cardPixel)) >= 4.5);
  }
  const warning = host.one(node => node.type === 'Text' && text(node).startsWith('Turn off battery saver'));
  assert.equal(style(warning.props.style).color, '#E8EF8D');
  const cardChildren = card.props.children.filter(Boolean);
  assert.ok(cardChildren.indexOf(explanation) > cardChildren.findIndex(node => walk(node, child => child === cancel).length));
  host.update({ busy: false, translationActive: false });
  assert.equal(host.all(node => node.type === 'CaptionRefract').length, 1);
  assert.equal(host.all(node => node.props.accessibilityViewIsModal).length, 0);
  host.update({ visible: false });
});

test('background runs only while visible and foreground, and removes listeners on close and remount', () => {
  const host = mount({}, { appState: 'background' });
  const active = () => host.one(node => node.type === 'CaptionRefract').props.active;
  assert.equal(active(), false);
  assert.equal(host.listeners.size, 1);
  host.state('active'); assert.equal(active(), true);
  host.state('inactive'); assert.equal(active(), false);
  host.state('background'); assert.equal(active(), false);
  host.state('active'); assert.equal(active(), true);
  host.update({ busy: false, translationActive: false }); assert.equal(active(), true);
  assert.equal(host.calls.subscriptions, 1, 'rerenders must not stack animation listeners');
  host.update({ visible: false });
  assert.equal(host.all(node => node.type === 'CaptionRefract').length, 0);
  assert.equal(host.listeners.size, 0);
  assert.equal(host.calls.removals, 1);
  host.state('background'); host.update({ visible: true }); assert.equal(active(), false);
  assert.equal(host.listeners.size, 1);
  host.update({ trackId: 'fr' });
  assert.equal(host.listeners.size, 1, 'session replacement cleans the old listener');
  host.update({ visible: false });
  assert.equal(host.calls.removals, host.calls.subscriptions);
  assert.equal(host.timers.size, 0);
});

test('Cancel, system back, error retry/dismiss and warning dismissal retain their callbacks', async () => {
  let back;
  const host = mount({ onBackRequestChange: request => { back = request; } });
  await host.settle();
  host.button('Cancel').props.onPress(); assert.equal(host.calls.cancel, 1);
  back(); assert.equal(host.calls.cancel, 2);
  host.one(node => node.type === 'Modal').props.onRequestClose(); assert.equal(host.calls.cancel, 3);
  host.update({ errorMessage: 'Interrupted' });
  host.button('Retry interrupted translation').props.onPress(); assert.equal(host.calls.retry, 1);
  host.button('Close').props.onPress(); back(); assert.equal(host.calls.dismiss, 2);
  assert.equal(host.all(node => node.type === 'Text' && text(node).startsWith('Translations are happening locally')).length, 0);
  host.update({ busy: false, errorMessage: undefined, warningMessage: 'Please review' });
  host.button('Close').props.onPress(); assert.equal(host.calls.dismiss, 3);
  host.update({ visible: false }); assert.equal(back, undefined);
});

test('portrait, landscape and keyboard-covered panes preserve virtualization, safe areas and bounded busy scrolling', async () => {
  const host = mount({}, { insets: { top: 24, bottom: 20, left: 16, right: 12 } });
  await host.settle();
  for (const [dimensions, covered] of [[{ width: 390, height: 844 }, false], [{ width: 844, height: 240 }, true]]) {
    host.rotate(dimensions, covered);
    const root = host.one(node => node.props.testID === 'dual-caption-root');
    root.props.onLayout({ nativeEvent: { layout: dimensions } });
    host.rotate(dimensions, covered);
    assert.equal(style(root.props.style).paddingTop, 24);
    assert.equal(style(root.props.style).paddingLeft, 16);
    const list = host.one(node => node.type === 'FlatList');
    assert.equal(list.props.initialNumToRender, 6);
    assert.equal(list.props.maxToRenderPerBatch, 6);
    assert.equal(list.props.windowSize, 5);
    assert.equal(list.props.removeClippedSubviews, false);
    assert.equal(list.props.keyboardShouldPersistTaps, 'handled');
    const overlay = host.one(node => node.props.accessibilityViewIsModal);
    assert.equal(style(overlay.props.style).paddingBottom, covered ? 8 : 20);
    const card = walk(overlay, node => node.type === 'ScrollView')[0];
    assert.equal(style(card.props.style).maxHeight, '100%');
    assert.equal(style(card.props.style).flexShrink, 1);
    assert.equal(card.props.keyboardShouldPersistTaps, 'handled');
    assert.ok(walk(card, node => node === host.button('Cancel')).length);
  }
  host.update({ visible: false });
});

test('non-Android background retains its noninteractive fallback', () => {
  const host = mount({}, { platform: 'ios' });
  const root = host.one(node => node.props.testID === 'dual-caption-root');
  const background = root.props.children[0];
  assert.equal(background.type, 'View');
  assert.equal(background.props.pointerEvents, 'none');
  assert.equal(style(background.props.style).position, 'absolute');
  host.update({ visible: false });
});
