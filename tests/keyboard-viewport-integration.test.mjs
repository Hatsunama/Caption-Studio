import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const source = readFileSync(new URL('../src/components/editor/keyboard-viewport.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function render(props = {}, platform = 'android', bottomOverlap = 160) {
  const exports = {}; let enabled;
  const viewport = { frameRef: { current: null }, onLayout() {}, bottomOverlap };
  const jsx = (type, props) => ({ type, props });
  runInNewContext(compiled, { exports, require(id) {
    if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (id === 'react-native') return { KeyboardAvoidingView: 'KAV', View: 'View', Platform: { OS: platform } };
    if (id.endsWith('use-keyboard-viewport')) return { useKeyboardViewport(value) { enabled = value; return viewport; } };
    throw Error(id);
  } });
  return { root: exports.KeyboardViewport({ children: 'content', ...props }), viewport, get enabled() { return enabled; } };
}
test('the outer measured frame stays unshrunk while only content excludes covered space', () => {
  const h = render(); const frame = h.root.props.children; const content = frame.props.children;
  assert.equal(frame.props.ref, h.viewport.frameRef); assert.equal(frame.props.onLayout, h.viewport.onLayout);
  assert.equal(frame.props.style.marginBottom, undefined); assert.equal(content.props.style.marginBottom, 160);
  assert.equal(content.props.children, 'content'); assert.equal(h.root.props.behavior, undefined);
});
test('native-resized windows recover the complete content area', () => {
  const h = render({}, 'android', 0); assert.equal(h.root.props.children.props.children.props.style.marginBottom, 0);
});
test('iOS avoidance and editor-owned nested avoidance remain explicit', () => {
  const ios = render({}, 'ios', 0); assert.equal(ios.root.props.behavior, 'padding'); assert.equal(ios.root.props.enabled, true);
  const editor = render({ iosAvoidance: false }, 'ios', 0); assert.equal(editor.root.props.enabled, false);
  const disabled = render({ enabled: false }, 'android', 0); assert.equal(disabled.enabled, false);
});
test('the editor measured workspace lives inside the keyboard-bounded content without a remount key', () => {
  const editor = ts.createSourceFile('editor.tsx', readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let wrapper;
  function visit(node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(editor) === 'KeyboardViewport') wrapper = node;
    ts.forEachChild(node, visit);
  }
  visit(editor); assert.ok(wrapper);
  assert.equal(wrapper.openingElement.attributes.properties.some(a => a.name?.getText(editor) === 'key'), false);
  const root = wrapper.children.find(n => ts.isJsxElement(n) && n.openingElement.tagName.getText(editor) === 'View');
  assert.ok(root);
  const onLayout = root.openingElement.attributes.properties.find(a => a.name?.getText(editor) === 'onLayout');
  assert.ok(onLayout && ts.isJsxExpression(onLayout.initializer));
  const writes = [];
  runInNewContext('(' + onLayout.initializer.expression.getText(editor) + ')({ nativeEvent: { layout: { height: 170, width: 760 } } })',
    { setWorkspaceHeight: v => writes.push(['height', v]), setWorkspaceWidth: v => writes.push(['width', v]), width: 800 });
  assert.deepEqual(writes, [['height', 170], ['width', 760]]);
});
