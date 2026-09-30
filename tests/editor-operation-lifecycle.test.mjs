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
const jsx = (type, props) => ({ type, props });
const operationOverlay = Symbol('operation overlay');
function renderSource(source, extra = {}) {
  const sandbox = {
    exports: {}, result: undefined, ...extra,
    require(name) {
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === 'react-native') return { Modal: nativeModal, View: nativeView, Text: 'text', Pressable: 'pressable', ActivityIndicator: 'spinner' };
      if (name === '@/components/operation-overlay') return { OperationOverlay: operationOverlay };
      if (name === '@/lib/ui-theme') return { chrome: { radius: { xl: 24 } } };
      throw Error(name);
    },
  };
  runInNewContext(compile(source), sandbox);
  return sandbox;
}

test('media import progress is rendered without opening a competing Android dialog', () => {
  const source = readFileSync(new URL('../src/components/media-loading-overlay.tsx', import.meta.url), 'utf8');
  const module = renderSource(source);
  const rendered = module.exports.MediaLoadingOverlay({ progress: { detail: 'Copying', total: 1 } });
  assert.notEqual(rendered.type, nativeModal);
});

test('caption progress is rendered without opening a competing Android dialog', () => {
  const node = findNode((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'ProgressOverlay');
  const sandbox = renderSource(`${node.getText(editorAst)}; result = ProgressOverlay;`, {
    Modal: nativeModal, OperationOverlay: operationOverlay, View: nativeView, Text: 'text', Pressable: 'pressable', ActivityIndicator: 'spinner',
    displayTranscriptionProgress: () => 50, stageTitle: () => 'Downloading', palette: {}, chrome: { radius: {} },
  });
  assert.notEqual(sandbox.result({ progress: { stage: 'downloading-model', progress: 0.5 }, cancelling: false, onCancel() {} }).type, nativeModal);
});

test('audio extraction progress does not compete with its failure alert', () => {
  const node = findNode((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'ExtractAudioBusyOverlay');
  const sandbox = renderSource(`${node.getText(editorAst)}; result = ExtractAudioBusyOverlay;`, {
    Modal: nativeModal, OperationOverlay: operationOverlay, View: nativeView, Text: 'text', ActivityIndicator: 'spinner', chrome: { radius: {} },
  });
  assert.notEqual(sandbox.result({ visible: true }).type, nativeModal);
});

test('export progress does not compete with publication alerts or Android sharing', () => {
  const node = findNode((node) => ts.isConditionalExpression(node) && node.condition.getText(editorAst) === 'exporting');
  const sandbox = renderSource(`result = (${node.getText(editorAst)});`, {
    exporting: true, exportKind: 'subtitle', exportProgress: undefined,
    Modal: nativeModal, OperationOverlay: operationOverlay, View: nativeView, Text: 'text', ActivityIndicator: 'spinner', palette: {},
  });
  assert.notEqual(sandbox.result.type, nativeModal);
});
