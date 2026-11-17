import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Execute the real component without importing the editor's native dependencies.
const source = ts.createSourceFile('editor.tsx',
  readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find((node) =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'TransitionTimingSheet');
assert.ok(component, 'TransitionTimingSheet must be available for runtime extraction');
const code = ts.transpileModule(component.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
const chrome = { text: 'text', muted: 'muted', accent: 'accent', hairline: 'hairline',
  surfaceRaised: 'surfaceRaised', radius: { md: 12 } };
const createElement = (type, props, ...children) => {
  const attributes = { ...props, children };
  return typeof type === 'function' ? type(attributes) : { type, props: attributes };
};
const render = runInNewContext(code + '\nTransitionTimingSheet;', {
  React: { createElement }, Modal: 'Modal', Pressable: 'Pressable', Text: 'Text', View: 'View',
  AdaptiveDialog: ({ footer, children, ...props }) =>
    createElement('AdaptiveDialog', props, children, footer),
  Action: ({ label, ...props }) => createElement('Action', props, label),
  chrome,
});

function all(node, type, found = []) {
  if (Array.isArray(node)) Array.from(node).forEach((child) => all(child, type, found));
  else if (node && typeof node === 'object') {
    if (node.type === type) found.push(node);
    all(node.props.children, type, found);
  }
  return found;
}
const labels = ['650 ms', '800 ms', '1 sec', '1.25 sec', '1.5 sec', '2 sec'];
const durations = [650, 800, 1000, 1250, 1500, 2000];
const choices = (tree) => all(tree, 'Pressable').filter((node) => all(node, 'Text').length === 1);
const label = (node) => Array.from(all(node, 'Text')[0].props.children).join('');

test('renders exactly six choices and selects each remaining duration in milliseconds', () => {
  for (const durationMs of durations) {
    const chosen = [];
    const tree = render({ visible: true, durationMs, onChoose: (ms) => chosen.push(ms), onClose() {} });
    const buttons = choices(tree);
    assert.deepEqual(Array.from(buttons, label), labels);
    assert.deepEqual(chosen, [], 'rendering must not choose a duration');
    const selected = buttons.filter((button) => button.props.style.borderWidth === 2);
    assert.deepEqual(Array.from(selected, label), [labels[durations.indexOf(durationMs)]]);
    assert.equal(selected[0].props.style.borderColor, chrome.accent);
    assert.equal(all(selected[0], 'Text')[0].props.style.color, chrome.accent);
    buttons.forEach((button) => button.props.onPress());
    assert.deepEqual(chosen, durations);
  }
});

test('Cancel, native close, and backdrop close retain their callbacks', () => {
  const chosen = [];
  let closes = 0;
  const onClose = () => closes++;
  const tree = render({ visible: true, durationMs: 1000, onChoose: (ms) => chosen.push(ms), onClose });
  assert.equal(tree.type, 'Modal');
  assert.equal(tree.props.visible, true);
  assert.equal(tree.props.onRequestClose, onClose);
  const cancel = all(tree, 'Action');
  assert.equal(cancel.length, 1);
  assert.deepEqual(Array.from(cancel[0].props.children), ['Cancel']);
  assert.equal(cancel[0].props.onPress, onClose);
  cancel[0].props.onPress();
  tree.props.onRequestClose();
  const backdrop = all(tree, 'Pressable')[0];
  assert.equal(backdrop.props.onPress, onClose);
  backdrop.props.onPress();
  assert.equal(closes, 3);
  assert.deepEqual(chosen, []);
  assert.equal(render({ visible: false, durationMs: 1000, onChoose() {}, onClose }).props.visible, false);
});

test('a loaded legacy 350 ms duration is not automatically replaced', () => {
  const chosen = [];
  const props = { visible: true, durationMs: 350, onChoose: (ms) => chosen.push(ms), onClose() {} };
  const tree = render(props);
  const buttons = choices(tree);
  assert.deepEqual(Array.from(buttons, label), labels);
  assert.equal(buttons.filter((button) => button.props.style.borderWidth === 2).length, 0);
  tree.props.onRequestClose();
  assert.deepEqual(chosen, []);
  assert.equal(props.durationMs, 350);
  buttons[0].props.onPress();
  assert.deepEqual(chosen, [650]);
});
