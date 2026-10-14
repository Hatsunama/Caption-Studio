import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const requireLocal = createRequire(import.meta.url);
function mount(textLayerSelected) {
  const exports = {};
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const output = ts.transpileModule(readFileSync(new URL('../src/components/editor/animation-browser.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  runInNewContext(output, { exports, require(name) {
    if (name === 'react') return { useState: (initial) => [initial, () => {}], useMemo: (factory) => factory() };
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'react-native') return { Pressable: 'Pressable', Text: 'Text', View: 'View' };
    if (name === '@react-native-community/slider') return { default: 'Slider' };
    if (name.includes('persisted-horizontal-scroll')) return { PersistedHorizontalScroll: 'HorizontalScroll' };
    if (name.startsWith('@/lib/')) return requireLocal('../src/lib/' + name.slice(6) + '.ts');
    throw new Error(name);
  } });
  const calls = [];
  const props = { selected: 'none', textLayerSelected, scope: 'caption', hasSelectedCaption: !textLayerSelected,
    lineHeight: 1, onScopeChange() {}, onSelect() { calls.push('animation'); }, onLineHeightStart() { calls.push('start'); },
    onLineHeightChange(value) { calls.push(value); }, onLineHeightEnd() { calls.push('end'); } };
  function expand(node) {
    if (Array.isArray(node)) return node.flatMap(expand);
    if (!node || typeof node !== 'object') return [];
    if (typeof node.type === 'function') return expand(node.type(node.props));
    return [node, ...expand(node.props.children)];
  }
  return { nodes: expand(exports.AnimationBrowser(props)), calls };
}

test('authored text has spacing controls but no animation or scope actions', () => {
  const { nodes, calls } = mount(true);
  assert.equal(nodes.filter((node) => node.props.onPress).length, 0);
  const slider = nodes.find((node) => node.props.accessibilityLabel === 'Line spacing');
  assert.ok(slider, 'removing animation must not remove text line spacing');
  slider.props.onSlidingStart(); slider.props.onValueChange(0.8); slider.props.onSlidingComplete();
  assert.deepEqual(calls, ['start', 0.8, 'end']);
});

test('caption animation choices and line spacing remain available', () => {
  const { nodes, calls } = mount(false);
  assert.ok(nodes.filter((node) => node.props.onPress).length > 5);
  assert.ok(nodes.some((node) => node.props.accessibilityLabel === 'Line spacing'));
  for (const choice of nodes.filter((node) => node.props.onPress)) choice.props.onPress();
  assert.ok(calls.includes('animation'));
});
