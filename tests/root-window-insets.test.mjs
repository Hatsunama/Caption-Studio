import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('../src/app/_layout.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const chrome = { background: '#121212', text: '#fafafa' };
const plain = value => JSON.parse(JSON.stringify(value));

// Render the actual RootLayout with native/router boundaries mocked. Assertions
// cover emitted navigation options and hook lifecycle, not native pixel layout.
function mount({ window = { width: 844, height: 390 }, insets = { top: 0, bottom: 21, left: 47, right: 13 }, fontsLoaded = true, fontError = null } = {}) {
  const environment = { window, insets, fontsLoaded, fontError };
  const slots = [], calls = { cache: [], cleanup: 0, diagnostics: 0, fonts: 0 };
  let cursor = 0, effects = [], tree, resolveImports;
  const importedFonts = new Promise(resolve => { resolveImports = resolve; });
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous[i]))) effects.push(effect);
      slots[index] = dependencies;
    },
  };
  const Stack = Object.assign(function Stack() {}, { Screen: 'Stack.Screen' });
  const exports = {};
  const jsx = (type, props, key) => ({ type, props, key });
  runInNewContext(source, { exports, console, require(id) {
    if (id === 'react') return react;
    if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (id === 'react-native') return { useWindowDimensions: () => environment.window };
    if (id === 'react-native-safe-area-context') return { useSafeAreaInsets: () => environment.insets };
    if (id === 'expo-font') return { useFonts: () => [environment.fontsLoaded, environment.fontError] };
    if (id === 'expo-router/stack') return { Stack };
    if (id === 'expo-video') return { setVideoCacheSizeAsync: async size => { calls.cache.push(size); } };
    if (id === '@/lib/font-catalog') return { FONT_ASSETS: {} };
    if (id === '@/lib/ui-theme') return { chrome };
    if (id === '@/services/local-diagnostics') return { captureHistoricalProcessExits: async () => { calls.diagnostics++; } };
    if (id === '@/services/font-storage') return { loadFontLibrary: () => { calls.fonts++; return importedFonts; } };
    if (id === '@/services/storage-policy') return { cleanupObsoletePickerCache: async () => { calls.cleanup++; } };
    throw new Error(`Unexpected import: ${id}`);
  } });
  function render(next = {}) {
    Object.assign(environment, next);
    cursor = 0; effects = []; tree = exports.default();
    effects.forEach(effect => effect());
    return tree;
  }
  render();
  return {
    calls, render,
    get tree() { return tree; },
    async finishImports() {
      resolveImports([]);
      await new Promise(resolve => setImmediate(resolve));
      render();
    },
    options(name) {
      assert.equal(tree?.type, Stack, 'loaded RootLayout must render the actual Stack');
      const screen = tree.props.children.find(child => child.props.name === name);
      assert.ok(screen, `missing route: ${name}`);
      return { ...tree.props.screenOptions, ...screen.props.options };
    },
  };
}

function assertLateral(h, left, right, top = 0, bottom = 21) {
  for (const name of ['index', 'privacy', 'notices', 'thank-you']) {
    const style = h.options(name).contentStyle;
    assert.equal(style.paddingLeft, left, `${name} left safe inset`);
    assert.equal(style.paddingRight, right, `${name} right safe inset`);
    assert.equal(style.backgroundColor, chrome.background);
    assert.equal(style.paddingTop ?? 0, name === 'thank-you' ? top : 0, `${name} top safe inset ownership`);
    assert.equal(style.paddingBottom ?? 0, name === 'thank-you' ? bottom : 0, `${name} bottom safe inset ownership`);
  }
}

test('noneditor routes receive asymmetric window insets and update on the same mount', async () => {
  const h = mount();
  await h.finishImports();
  assertLateral(h, 47, 13);
  const stackType = h.tree.type;
  h.render({ insets: { top: 9, bottom: 24, left: 13, right: 47 } });
  assertLateral(h, 13, 47, 9, 24);
  assert.equal(h.tree.type, stackType);
  assert.equal(h.tree.key, undefined);
  assert.ok(h.tree.props.children.every(screen => screen.key === undefined));
  assert.deepEqual(h.calls, { cache: [128 * 1024 * 1024], cleanup: 1, diagnostics: 1, fonts: 1 });
});

test('portrait zero lateral insets clear prior landscape padding', async () => {
  const h = mount();
  await h.finishImports();
  assertLateral(h, 47, 13);
  h.render({ window: { width: 390, height: 844 }, insets: { top: 59, bottom: 34, left: 0, right: 0 } });
  assertLateral(h, 0, 0, 59, 34);
});

test('hidden-header thank-you receives tall vertical safe insets without adding them to other routes', async () => {
  const h = mount({
    window: { width: 390, height: 844 },
    insets: { top: 87, bottom: 52, left: 11, right: 31 },
  });
  await h.finishImports();
  assertLateral(h, 11, 31, 87, 52);
  assert.equal(h.options('thank-you').headerShown, false);
  assert.deepEqual(plain(h.options('thank-you').contentStyle), {
    backgroundColor: chrome.background,
    paddingLeft: 11, paddingRight: 31, paddingTop: 87, paddingBottom: 52,
  });
  assert.equal(h.tree.props.screenOptions.contentStyle.paddingTop, undefined);
  assert.equal(h.tree.props.screenOptions.contentStyle.paddingBottom, undefined);
  assert.deepEqual(plain(h.options('editor').contentStyle), {
    backgroundColor: chrome.background, paddingLeft: 0, paddingRight: 0,
  });
  h.render({ insets: { top: 0, bottom: 0, left: 31, right: 11 } });
  assertLateral(h, 31, 11, 0, 0);
});

test('editor overrides shared content padding so its workspace owns safe insets once', async () => {
  const h = mount();
  await h.finishImports();
  for (const insets of [{ top: 0, bottom: 21, left: 47, right: 13 }, { top: 59, bottom: 34, left: 0, right: 0 }]) {
    h.render({ insets });
    assert.deepEqual(plain(h.options('editor').contentStyle), {
      backgroundColor: chrome.background, paddingLeft: 0, paddingRight: 0,
    });
  }
});

test('only editor header follows the existing wide-window threshold; theme and route options persist', async () => {
  const h = mount();
  await h.finishImports();
  for (const [width, height, editorHeader] of [[844, 390, false], [390, 844, true], [639, 390, true], [640, 390, false], [720, 600, true]]) {
    h.render({ window: { width, height } });
    const shared = plain(h.tree.props.screenOptions);
    assert.deepEqual(shared.headerStyle, { backgroundColor: chrome.background });
    assert.equal(shared.headerTintColor, chrome.text);
    assert.equal(shared.headerShadowVisible, false);
    assert.equal(shared.headerShown, undefined);
    assert.deepEqual(plain(h.tree.props.children.map(screen => screen.props.name)), ['index', 'thank-you', 'privacy', 'notices', 'editor']);
    for (const [name, expected] of [
      ['index', { title: 'Caption Studio' }], ['thank-you', {
        headerShown: false,
        contentStyle: {
          backgroundColor: chrome.background,
          paddingLeft: 47, paddingRight: 13, paddingTop: 0, paddingBottom: 21,
        },
      }],
      ['privacy', { title: 'Privacy policy' }], ['notices', { title: 'Open-source notices' }],
    ]) {
      assert.deepEqual(plain(h.tree.props.children.find(screen => screen.props.name === name).props.options), expected);
    }
    const editor = h.options('editor');
    assert.equal(editor.title, 'Editor');
    assert.equal(editor.headerShown, editorHeader);
    assert.equal(editor.headerBackButtonDisplayMode, 'minimal');
  }
});

test('font readiness gates Stack while maintenance and imported-font restoration run only once', async () => {
  const h = mount({ fontsLoaded: false });
  assert.equal(h.tree, null);
  h.render({ window: { width: 390, height: 844 } });
  assert.equal(h.tree, null);
  await h.finishImports();
  assert.equal(h.tree, null, 'bundled fonts must finish or report an error');
  h.render({ fontError: new Error('Unavailable font') });
  assert.ok(h.tree, 'existing font-error fallback still permits navigation');
  h.render({ fontsLoaded: true, fontError: null });
  assert.ok(h.tree);
  assert.deepEqual(h.calls, { cache: [128 * 1024 * 1024], cleanup: 1, diagnostics: 1, fonts: 1 });
  const waiting = mount();
  assert.equal(waiting.tree, null, 'bundled-font readiness must still wait for imported fonts');
  await waiting.finishImports();
  assert.ok(waiting.tree);
});
