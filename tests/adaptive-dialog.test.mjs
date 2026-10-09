import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync(new URL('../src/components/editor/adaptive-dialog.tsx', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function mount(props, insets, platform = 'android') {
  const exports = {};
  runInNewContext(compiled, { exports, require(id) {
    if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (id === 'react-native') return { Platform: { OS: platform }, ...Object.fromEntries(['KeyboardAvoidingView', 'Pressable', 'ScrollView', 'View'].map(key => [key, key])) };
    if (id === 'react-native-safe-area-context') return { useSafeAreaInsets: () => insets };
    if (id.endsWith('ui-theme')) return { chrome: { radius: { xl: 20 } } };
    throw Error('Unexpected dependency: ' + id);
  } });
  return exports.AdaptiveDialog(props);
}
function walk(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(n => walk(n, predicate));
  if (!node || typeof node !== 'object') return [];
  return [...(predicate(node) ? [node] : []), ...walk(node.props?.children, predicate)];
}
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
