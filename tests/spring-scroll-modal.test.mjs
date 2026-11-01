import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const url = new URL('../src/components/spring-scroll-modal.tsx', import.meta.url);
for (const platform of ['android', 'ios', 'web']) test(`${platform}: modal preserves native lifecycle, children and layout boundary`, () => {
  const output = ts.transpileModule(readFileSync(url, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports = {};
  runInNewContext(output, { exports, require(id) {
    if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }) };
    if (id === 'react-native') return { Modal: 'NativeModal', Platform: { OS: platform } };
    if (id === 'react-native-gesture-handler') return { GestureHandlerRootView: 'GestureRoot' };
    throw Error(id);
  }});
  const children = { type: 'KeyboardViewport', props: { style: { flex: 1 }, children: 'unchanged controls' } };
  const props = { visible: true, transparent: true, animationType: 'fade', presentationStyle: 'fullScreen',
    onShow() {}, onDismiss() {}, onRequestClose() {}, children };
  const tree = exports.SpringScrollModal(props);
  assert.equal(tree.type, 'NativeModal');
  for (const [key, value] of Object.entries(props)) if (key !== 'children') assert.equal(tree.props[key], value);
  if (platform === 'android') {
    assert.equal(tree.props.children.type, 'GestureRoot');
    assert.deepEqual(JSON.parse(JSON.stringify(tree.props.children.props.style)), { flex: 1 });
    assert.equal(tree.props.children.props.children, children);
  } else assert.equal(tree.props.children, children);
});
for (const file of ['app/editor.tsx','components/editor/dual-caption-editor.tsx',
  'components/editor/dual-language-picker.tsx','components/editor/extract-audio-source-sheet.tsx',
  'components/editor/font-browser.tsx','components/editor/scope-sheet.tsx',
  'components/editor/video-tools.tsx','components/editor/watermark-sheet.tsx']) {
  test(`${file}: scroll-enabled modal owns the shared native gesture boundary`, () => {
    const tree=ts.createSourceFile(file,readFileSync(new URL('../src/'+file,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    assert.ok(tree.statements.some(n => ts.isImportDeclaration(n)
      && n.moduleSpecifier.text === '@/components/spring-scroll-modal'
      && n.importClause?.namedBindings?.elements?.some(e => e.name.text === 'Modal' && e.propertyName?.text === 'SpringScrollModal')));
  });
}
