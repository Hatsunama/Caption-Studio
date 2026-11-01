import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// A coverage guard, not proof of native physics: every current scrolling entry
// point must use the shared adapter while retaining its original layout/handlers.
const scrollFiles = [
  'app/editor.tsx', 'app/privacy.tsx', 'app/thank-you.tsx', 'app/notices.tsx',
  'components/editor/adaptive-dialog.tsx', 'components/editor/extract-audio-source-sheet.tsx',
  'components/editor/dual-language-picker.tsx', 'components/editor/font-color-picker.tsx',
  'components/editor/persisted-horizontal-scroll.tsx', 'components/editor/watermark-sheet.tsx',
  'components/editor/layer-timeline.tsx', 'components/editor/dual-caption-editor.tsx',
];
const listFiles = ['app/index.tsx', 'components/editor/font-browser.tsx',
  'components/editor/script-editor.tsx', 'components/editor/dual-caption-editor.tsx'];
function source(file) { return readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'); }
function ast(file) { return ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); }
function imports(tree, exported, local = exported) {
  return tree.statements.some(n => ts.isImportDeclaration(n)
    && n.moduleSpecifier.text === '@/components/spring-scroll-view'
    && n.importClause?.namedBindings?.elements?.some(e => e.name.text === local && (e.propertyName?.text ?? e.name.text) === exported));
}
for (const file of scrollFiles) test(`${file}: scroll content uses the shared spring adapter`, () => {
  assert.ok(imports(ast(file), 'SpringScrollView', 'ScrollView'), `${file} bypasses spring scrolling`);
});
for (const file of listFiles) test(`${file}: virtualized lists retain virtualization and use spring scroll rendering`, () => {
  const tree = ast(file); assert.ok(imports(tree, 'renderSpringScrollView'));
  let count = 0;
  function visit(n) {
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText(tree) === 'FlatList') {
      count++;
      const prop = n.attributes.properties.find(p => p.name?.text === 'renderScrollComponent');
      assert.equal(prop?.initializer?.expression?.getText(tree), 'renderSpringScrollView');
    }
    ts.forEachChild(n, visit);
  }
  visit(tree); assert.ok(count > 0);
});

function timelineHost() {
  const native = Symbol('NativeScrollView'), spring = Symbol('SpringScrollView'), detector = Symbol('GestureDetector');
  const code = ts.transpileModule(source('components/editor/timeline-native-gesture.tsx'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  runInNewContext(code, { exports, require(id) {
    if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }) };
    if (id === 'react') return { createContext: value => ({ value }) };
    if (id === 'react-native') return { Platform: { OS: 'android' }, ScrollView: native, View: 'View' };
    if (id === 'react-native-gesture-handler') return { GestureDetector: detector, Gesture: { Native: () => ({}) }, State: {} };
    if (id === 'react-native-reanimated' || id === 'react-native-worklets' || id === './timeline-native-pan') return {};
    if (id === '@/components/spring-scroll-view') return { SpringScrollView: spring };
    throw new Error(`Unexpected integration import ${id}`);
  } });
  return { ...exports, spring };
}
test('timeline keeps one native gesture and the actual ref, scroll callbacks, and layout props', () => {
  const h = timelineHost();
  for (const ref of [{ current: null }, () => {}]) for (const horizontal of [false, true]) {
    const gesture = {}, onScroll = () => {}, onLayout = () => {}, onScrollEndDrag = () => {};
    const style = { flex: 1 }, contentContainerStyle = { gap: 10 }, springOffset = { value: 0 };
    const props = { ref, horizontal, nativeGesture: gesture, onScroll, onLayout, onScrollEndDrag, style,
      contentContainerStyle, scrollEnabled: false, nestedScrollEnabled: true, springOffset, children: 'rows' };
    const tree = h.TimelineNativeScrollView(props);
    assert.equal(tree.type, h.spring, 'do not double-wrap the adapter with another Native recognizer');
    for (const [name, value] of Object.entries(props)) assert.equal(tree.props[name], value, name);
  }
});
test('timeline label and item columns share one vertical presentation spring', () => {
  const tree = ast('components/editor/layer-timeline.tsx'); const values = [];
  function visit(n) {
    if (ts.isJsxOpeningElement(n) && n.tagName.getText(tree) === 'TimelineNativeScrollView') {
      const horizontal = n.attributes.properties.some(p => p.name?.text === 'horizontal');
      if (!horizontal) values.push(n.attributes.properties.find(p => p.name?.text === 'springOffset')?.initializer?.expression?.getText(tree));
    }
    ts.forEachChild(n, visit);
  }
  visit(tree); assert.equal(values.length, 2); assert.ok(values[0]); assert.equal(values[0], values[1]);
});

test('timeline item gestures include the newly native parent scroll owners', () => {
  const tree = ast('components/editor/layer-timeline.tsx');
  assert.ok(imports(tree, 'SpringScrollGestureContext'));
  let readsParent = false, combinesParent = false;
  function visit(n) {
    if (ts.isCallExpression(n) && n.expression.getText(tree) === 'useContext'
      && n.arguments[0]?.getText(tree) === 'SpringScrollGestureContext') readsParent = true;
    if (ts.isArrayLiteralExpression(n)) {
      const values = n.elements.filter(ts.isSpreadElement).map(e => e.expression.getText(tree));
      if (values.includes('nativeScrollGestures') && values.includes('ancestorScrollGestures')) combinesParent = true;
    }
    ts.forEachChild(n, visit);
  }
  visit(tree); assert.ok(readsParent); assert.ok(combinesParent);
});
