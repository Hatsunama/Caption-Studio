import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { CaptionGenerationCancelledError } from '../src/services/caption-generation-session.ts';

const editorSource = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
const editorAst = ts.createSourceFile('editor.tsx', editorSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function findNode(predicate) {
  let found;
  function visit(node) { if (!found && predicate(node)) found = node; ts.forEachChild(node, visit); }
  visit(editorAst);
  assert.ok(found);
  return found;
}

test('cancelling generation never publishes a failure banner through project commit', async () => {
  const node = findNode((node) => ts.isVariableDeclaration(node) && node.name.getText(editorAst) === 'commitEditorProject');
  const errors = [];
  const sandbox = {
    editorSession: { commit: async () => { throw new CaptionGenerationCancelledError(); } },
    workspaceMountedRef: { current: true },
    CaptionGenerationCancelledError,
    ProjectPersistenceError: class extends Error {},
    setError: (message) => errors.push(message), setPersistenceError() {}, trackSessionMedia() {},
  };
  runInNewContext(compile(`result = (${node.initializer.getText(editorAst)});`), sandbox);
  await assert.rejects(sandbox.result(() => ({})), CaptionGenerationCancelledError);
  assert.deepEqual(errors, []);
});

function foregroundHarness(interrupt) {
  const source = readFileSync(new URL('../src/hooks/use-foreground-operation.ts', import.meta.url), 'utf8');
  const slots = []; let cursor = 0; let listener; const effects = [];
  const exports = {};
  runInNewContext(compile(source), {
    exports,
    Error,
    require(name) {
      if (name === 'react-native') return { AppState: { addEventListener: (_event, callback) => { listener = callback; return { remove() {} }; } } };
      if (name === 'react') return {
        useRef: (initial) => { const index = cursor++; return slots[index] ??= { current: initial }; },
        useState: (initial) => { const index = cursor++; slots[index] ??= { value: initial }; return [slots[index].value, (value) => { slots[index].value = value; }]; },
        useCallback: (callback) => callback,
        useLayoutEffect: (callback) => callback(),
        useEffect: (callback) => { if (!listener) effects.push(callback); },
      };
      throw Error(name);
    },
  });
  const render = () => { cursor = 0; return exports.useForegroundOperation({ stage: 'downloading-model', interrupt }); };
  render(); effects.forEach((effect) => effect());
  return { change: (state) => listener(state), render };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('foreground interruption carries a resolved stop failure instead of claiming a saved pause', async () => {
  const h = foregroundHarness(async () => ({ interruptionError: 'native stop failed' }));
  h.change('background'); h.change('active'); await flush();
  assert.equal(h.render().interruption.interruptionError, 'native stop failed');
});

test('a synchronous stop failure is captured and does not escape the AppState callback', async () => {
  const h = foregroundHarness(() => { throw Error('synchronous stop failure'); });
  assert.doesNotThrow(() => h.change('background'));
  h.change('active'); await flush();
  assert.equal(h.render().interruption.interruptionError, 'synchronous stop failure');
});

test('foreground interruption is published only after the stop promise settles', async () => {
  let finish;
  const h = foregroundHarness(() => new Promise((resolve) => { finish = resolve; }));
  h.change('background'); await flush(); h.change('active'); await flush();
  assert.equal(h.render().interruption, undefined);
  finish(); await flush();
  assert.equal(h.render().interruption.stage, 'downloading-model');
});

const nativeModal = Symbol('native modal');
const nativeView = Symbol('view');
const fragment = Symbol('fragment');
const jsx = (type, props) => ({ type, props });
const componentSources = {
  '@/components/editor/adaptive-dialog': readFileSync(new URL('../src/components/editor/adaptive-dialog.tsx', import.meta.url), 'utf8'),
  '@/components/editor/keyboard-viewport': readFileSync(new URL('../src/components/editor/keyboard-viewport.tsx', import.meta.url), 'utf8'),
  '@/components/operation-overlay': readFileSync(new URL('../src/components/operation-overlay.tsx', import.meta.url), 'utf8'),
};
const mediaLoadingSource = readFileSync(new URL('../src/components/media-loading-overlay.tsx', import.meta.url), 'utf8');
function renderSource(source, extra = {}) {
  const modules = new Map();
  const backHandlers = new Set();
  const cleanups = [];
  const reveal = { viewportRef: { current: null }, focus() {}, blur() {}, onViewportLayout() {}, onScroll() {}, onScrollBeginDrag() {} };
  const chrome = { radius: { xl: 24, md: 13, pill: 999 } };
  const native = {
    Modal: nativeModal, View: nativeView, Text: 'text', Pressable: 'pressable', ActivityIndicator: 'spinner',
    KeyboardAvoidingView: 'keyboard-avoiding-view', ScrollView: 'scroll-view', Platform: { OS: 'android' },
    StyleSheet: { absoluteFill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } },
    BackHandler: {
      addEventListener(event, callback) {
        assert.equal(event, 'hardwareBackPress');
        backHandlers.add(callback);
        return { remove: () => backHandlers.delete(callback) };
      },
    },
  };
  function require(name) {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: fragment };
    if (name === 'react') return {
      createContext: value => ({ value, Provider: props => props.children }),
      useContext: context => context.value,
      useRef: value => ({ current: value }),
      useState: value => [typeof value === 'function' ? value() : value, () => {}],
      useCallback: callback => callback,
      useEffect(callback) {
        const cleanup = callback();
        if (typeof cleanup === 'function') cleanups.push(cleanup);
      },
    };
    if (name === 'react-native') return native;
    if (name === 'react-native-safe-area-context') return { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
    if (name === '@/lib/ui-theme') return { chrome };
    if (name === '@/hooks/use-focused-input-reveal') return { useFocusedInputReveal: () => [reveal.viewportRef, reveal] };
    if (name === '@/hooks/use-keyboard-viewport') return { useKeyboardViewport: () => ({ frameRef: { current: null }, onLayout() {}, bottomOverlap: 0 }) };
    if (Object.hasOwn(componentSources, name)) {
      if (!modules.has(name)) {
        const exports = {};
        modules.set(name, exports);
        runInNewContext(compile(componentSources[name]), { exports, require });
      }
      return modules.get(name);
    }
    throw Error(`Unexpected dependency ${name}`);
  }
  const sandbox = {
    exports: {}, result: undefined, ...native, chrome,
    AdaptiveDialog: require('@/components/editor/adaptive-dialog').AdaptiveDialog,
    OperationOverlay: require('@/components/operation-overlay').OperationOverlay,
    ...extra, require,
  };
  runInNewContext(compile(source), sandbox);
  sandbox.pressBack = () => {
    assert.equal(backHandlers.size, 1, 'visible operation must register one Android Back handler');
    return [...backHandlers][0]();
  };
  sandbox.dispose = () => { cleanups.splice(0).forEach((cleanup) => cleanup()); };
  return sandbox;
}

function renderTree(element) {
  if (element == null || typeof element === 'boolean') return null;
  if (Array.isArray(element)) return element.map(renderTree);
  if (typeof element !== 'object') return element;
  assert.ok(element.type, 'every element must have a defined component type');
  if (typeof element.type === 'function') return renderTree(element.type(element.props ?? {}));
  if (element.type === fragment) return renderTree(element.props?.children);
  return { ...element, props: { ...element.props, children: renderTree(element.props?.children) } };
}

function treeNodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(treeNodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...treeNodes(tree.props?.children)];
}

function assertOperationTree(element) {
  const nodes = treeNodes(renderTree(element));
  assert.ok(nodes.length > 0, 'visible operation must render a tree');
  for (const node of nodes) assert.notEqual(node.type, nativeModal, 'native Modal must not appear anywhere in the rendered operation tree');
  assert.ok(nodes.some((node) => node.type === nativeView && node.props.accessibilityViewIsModal), 'actual OperationOverlay must render');
  assert.ok(nodes.some((node) => node.props.testID === 'adaptive-dialog-frame'), 'actual AdaptiveDialog frame must render');
  assert.ok(nodes.some((node) => node.props.testID === 'adaptive-dialog-body'), 'actual AdaptiveDialog body must render');
  return nodes;
}

function cancelButton(nodes, label) {
  const button = nodes.find((node) => node.type === 'pressable' && node.props.accessibilityLabel === label);
  assert.ok(button, `${label} must remain reachable in the rendered tree`);
  assert.notEqual(button.props.disabled, true);
  assert.equal(typeof button.props.onPress, 'function');
  return button;
}

test('media import progress is rendered without opening a competing Android dialog', () => {
  const module = renderSource(mediaLoadingSource);
  assertOperationTree(module.exports.MediaLoadingOverlay({ progress: { detail: 'Copying', total: 1 } }));
  module.dispose();
});

test('caption progress is rendered without opening a competing Android dialog', () => {
  const node = findNode((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'ProgressOverlay');
  const sandbox = renderSource(`${node.getText(editorAst)}; result = ProgressOverlay;`, {
    displayTranscriptionProgress: () => 50, stageTitle: () => 'Downloading', palette: {},
  });
  let cancelled = 0;
  const nodes = assertOperationTree(sandbox.result({ progress: { stage: 'downloading-model', progress: 0.5 }, cancelling: false, onCancel() { cancelled++; } }));
  cancelButton(nodes, 'Cancel caption generation').props.onPress();
  assert.equal(cancelled, 1);
  assert.equal(sandbox.pressBack(), true);
  assert.equal(cancelled, 2);
  sandbox.dispose();
});

test('caption cancellation stays disabled while the stop is settling', () => {
  const node = findNode((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'ProgressOverlay');
  const sandbox = renderSource(`${node.getText(editorAst)}; result = ProgressOverlay;`, {
    displayTranscriptionProgress: () => 50, stageTitle: () => 'Downloading', palette: {},
  });
  let cancelled = 0;
  const nodes = assertOperationTree(sandbox.result({ progress: { stage: 'downloading-model', progress: 0.5 }, cancelling: true, onCancel() { cancelled++; } }));
  const button = nodes.find((node) => node.type === 'pressable' && node.props.accessibilityLabel === 'Cancel caption generation');
  assert.ok(button);
  assert.equal(button.props.disabled, true);
  assert.equal(sandbox.pressBack(), true);
  assert.equal(cancelled, 0);
  sandbox.dispose();
});

test('audio extraction progress does not compete with its failure alert', () => {
  const node = findNode((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'ExtractAudioBusyOverlay');
  const sandbox = renderSource(`${node.getText(editorAst)}; result = ExtractAudioBusyOverlay;`);
  assertOperationTree(sandbox.result({ visible: true }));
  sandbox.dispose();
});

test('export progress does not compete with publication alerts or Android sharing', () => {
  const node = findNode((node) => ts.isConditionalExpression(node) && node.condition.getText(editorAst) === 'exporting');
  for (const exportKind of ['subtitle', 'video']) {
    let cancelled = 0;
    const sandbox = renderSource(`result = (${node.getText(editorAst)});`, {
      exporting: true, exportKind, exportProgress: undefined, palette: {},
      cancelProjectVideoExport() { cancelled++; },
    });
    const nodes = assertOperationTree(sandbox.result);
    if (exportKind === 'video') {
      cancelButton(nodes, 'Cancel video export').props.onPress();
      assert.equal(cancelled, 1);
    }
    assert.equal(sandbox.pressBack(), true);
    assert.equal(cancelled, exportKind === 'video' ? 2 : 0);
    sandbox.dispose();
  }
});

test('operation tree inspection detects native Modal descendants in dialog bodies and footers', () => {
  for (const placement of ['body', 'footer']) {
    const sandbox = renderSource('');
    const NestedModal = () => jsx(nativeModal, { children: 'unexpected dialog' });
    const nested = jsx(NestedModal, {});
    const element = jsx(sandbox.OperationOverlay, {
      visible: true,
      children: jsx(sandbox.AdaptiveDialog, {
        children: placement === 'body' ? nested : 'progress',
        footer: placement === 'footer' ? nested : undefined,
      }),
    });
    assert.throws(() => assertOperationTree(element), /native Modal must not appear anywhere/);
    sandbox.dispose();
  }
});

