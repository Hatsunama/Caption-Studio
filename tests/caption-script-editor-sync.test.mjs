import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as scriptMutations from '../src/lib/caption-script.ts';

// Execute the complete component with deterministic hooks, native layout events,
// and timers. Native rendering and recovery storage are test doubles. The source
// override lets the same regressions run against an untouched baseline file.
const source = readFileSync(process.env.CAPTION_SCRIPT_EDITOR_SOURCE
  ?? new URL('../src/components/editor/script-editor.tsx', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  fileName: 'script-editor.tsx',
});
const cues = Array.from({ length: 6 }, (_, index) => ({
  id: `cue-${index}`, text: `caption ${index}`, startMs: index * 1000,
  endMs: (index + 1) * 1000, wordIds: [],
}));
const layoutEvent = (y, height) => ({ nativeEvent: { layout: { x: 0, y, width: 360, height } } });
const scrollEvent = (y) => ({ nativeEvent: { contentOffset: { x: 0, y } } });
const plain = (value) => JSON.parse(JSON.stringify(value));

// Evaluate the real workspace expressions without loading its unrelated native
// services. This covers the parent selection and the layout the sheet receives.
const editorSource = readFileSync(process.env.CAPTION_EDITOR_SOURCE
  ?? new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
const editorAst = ts.createSourceFile('editor.tsx', editorSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const workspace = editorAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'EditorWorkspace');
const workspaceRoot = workspace.body.statements.find(ts.isReturnStatement).expression.expression;
function evaluate(expression, context = {}) {
  const sandbox = { result: undefined, ...context };
  const compiled = ts.transpileModule(`result = (${expression});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  runInNewContext(compiled.outputText, sandbox);
  return sandbox.result;
}
function workspaceValue(name, context) {
  const declaration = workspace.body.statements.filter(ts.isVariableStatement)
    .flatMap((node) => [...node.declarationList.declarations]).find((node) => node.name.getText(editorAst) === name);
  return evaluate(declaration.initializer.getText(editorAst), { scriptEditorOpen: true, scriptKeyboardOpen: false, ...context });
}
function jsxProp(node, name, context) {
  const attribute = node.openingElement.attributes.properties.find((prop) => prop.name?.text === name);
  return attribute ? evaluate(attribute.initializer.expression.getText(editorAst), context) : undefined;
}

function mount(overrides = {}, platform = 'android') {
  const slots = [];
  const timers = new Map();
  const keyboardListeners = new Map();
  let cursor = 0, dirty = false, effects = [], tree, now = 0, timerId = 0, recover;
  const calls = { seeks: [], selects: [], indices: [], offsets: [], drafts: [], keyboards: [], focuses: [], alerts: [], saves: [], nativeLayouts: 0, focusCaptures: 0 };
  const sameDeps = (left, right) => left && right && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]));
  const memo = (factory, deps) => {
    const index = cursor++;
    if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { value: factory(), deps };
    return slots[index].value;
  };
  const react = {
    useRef: (value) => memo(() => ({ current: value }), []), useMemo: memo,
    useCallback: (callback, deps) => memo(() => callback, deps),
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (value) => {
        const next = typeof value === 'function' ? value(slots[index].value) : value;
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true; }
      }];
    },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) effects.push(() => {
        slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: callback() };
      });
    },
    createContext(value) { const context = { value }; context.Provider = { context }; return context; },
    useContext: (context) => context.value,
  };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const native = Object.fromEntries(['FlatList', 'KeyboardAvoidingView', 'Pressable', 'Text', 'TextInput', 'View'].map((name) => [name, name]));
  native.Platform = { OS: platform }; native.Alert = { alert: (...args) => calls.alerts.push(args) };
  native.Keyboard = { isVisible: () => false, addListener(name, callback) {
    keyboardListeners.set(name, callback);
    return { remove: () => keyboardListeners.delete(name) };
  } };
  const exports = {};
  runInNewContext(outputText, {
    exports,
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === 'react-native') return native;
      if (name === '@/lib/caption-script') return scriptMutations;
      if (name === '@/lib/ui-theme') return { chrome: { radius: { lg: 12, pill: 20 } } };
      if (name === '@/services/editor-draft-journal') return {
        readEditorDraftJournal: () => ({ then: (callback) => { recover = callback; return { catch: () => {} }; } }),
        clearEditorDraftJournal: async () => {}, writeEditorDraftJournal: async () => {},
      };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    setTimeout(callback, delay) { timers.set(++timerId, { callback, at: now + delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  const props = {
    visible: true, projectId: 'project', baseRevision: 'revision', captions: cues,
    words: [], currentMs: 0, isPlaying: false,
    onSelectCaption: (caption) => calls.selects.push(caption.id),
    onDraftChange: (captions) => calls.drafts.push(plain(captions)),
    onKeyboardChange: (open) => calls.keyboards.push(open),
    onSeekTimeline: (ms) => calls.seeks.push(ms), onCancel: () => {},
    onSave: async (captions) => { calls.saves.push(plain(captions)); }, ...overrides,
  };
  function walk(node, predicate) {
    if (!node || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) {
      for (const child of node) { const found = walk(child, predicate); if (found) return found; }
      return undefined;
    }
    if (node.type?.context) node.type.context.value = node.props.value;
    if (predicate(node)) return node;
    return walk(node.props?.children, predicate);
  }
  const find = (type, root = tree) => walk(root, (node) => node.type === type);
  function render() {
    let passes = 0;
    do {
      assert.ok(++passes < 30, 'component must settle without a render loop');
      dirty = false; cursor = 0; effects = [];
      tree = exports.ScriptEditor(props);
      const list = find('FlatList');
      if (list) list.props.ref.current = {
        scrollToIndex: (request) => calls.indices.push(plain(request)),
        scrollToOffset: (request) => calls.offsets.push(plain(request)),
      };
      if (list) list.props.data.forEach((item, index) => {
        const input = find('TextInput', list.props.renderItem({ item, index }));
        input?.props.ref?.({ focus: () => calls.focuses.push(item.id) });
      });
      for (const effect of effects) effect();
    } while (dirty);
  }
  function act(callback) { callback(); render(); }
  const list = () => find('FlatList').props;
  const row = (index) => list().renderItem({ item: list().data[index], index });
  const fire = (name, y = 0) => act(() => list()[name]?.(scrollEvent(y)));
  function measure(index, y = 100 + index * 100, height = 80) {
    act(() => {
      const cellProps = list();
      if (cellProps.CellRendererComponent) {
        const cell = cellProps.CellRendererComponent({
          item: cellProps.data[index], index, children: row(index),
          onLayout: () => { calls.nativeLayouts += 1; },
          onFocusCapture: () => { calls.focusCaptures += 1; },
        });
        cell.props.onLayout(layoutEvent(y, height));
        cell.props.onFocusCapture?.();
      } else {
        // RN's renderItem wrapper gives the child a local y=0, not content y.
        row(index).props.onLayout?.(layoutEvent(0, height));
      }
    });
  }
  const viewport = (height) => act(() => list().onLayout(layoutEvent(0, height)));
  function advance(ms) {
    const until = now + ms;
    let iterations = 0;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      assert.ok(++iterations < 100, 'timers must be bounded');
      timers.delete(next[0]); now = next[1].at; act(next[1].callback);
    }
    now = until;
  }
  render(); viewport(200);
  for (let index = 0; index < list().data.length; index += 1) measure(index);
  calls.indices.length = 0;
  return {
    calls, props, list, row, find, act, fire, measure, viewport, advance,
    keyboard: (name) => act(() => keyboardListeners.get(name)?.()),
    update: (values) => act(() => Object.assign(props, values)),
    edit: (index) => act(() => row(index).props.onPress()),
    input: (index) => find('TextInput', row(index)).props,
    recover: (payload) => act(() => recover({ payload, baseRevision: 'revision' })),
    restore: () => act(() => calls.alerts.at(-1)[2].find(({ text }) => text === 'Restore').onPress()),
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

test('drag seeks using cell-content coordinates and preserves native layout reporting', () => {
  const h = mount();
  h.fire('onScrollBeginDrag'); h.fire('onScroll', 240); h.fire('onScroll', 242);
  assert.deepEqual(h.calls.seeks, [2000]);
  assert.deepEqual(h.calls.selects, ['cue-2']);
  assert.equal(h.calls.nativeLayouts, cues.length);
});

test('programmatic initial and delayed scroll notifications never seek', () => {
  const h = mount({ initialCaptionId: 'cue-4' });
  h.advance(2000); h.fire('onScroll', 400); h.fire('onMomentumScrollBegin');
  h.fire('onScroll', 450); h.fire('onMomentumScrollEnd', 450);
  assert.deepEqual(h.calls.seeks, []);
  assert.deepEqual(h.calls.selects, []);
});

test('playback ticks cannot strand scroll ownership and a drag can seek during playback', () => {
  const h = mount({ isPlaying: true, currentMs: 1100 });
  h.update({ currentMs: 1150 }); h.update({ currentMs: 1200 }); h.advance(1000);
  h.fire('onScrollBeginDrag'); h.fire('onScroll', 340);
  assert.deepEqual(h.calls.seeks, [3000]);
  h.update({ isPlaying: false }); h.fire('onScroll', 440);
  assert.deepEqual(h.calls.seeks, [3000, 4000]);
});

test('user momentum seeks across transport rerenders then releases ownership', () => {
  const h = mount();
  h.fire('onScrollBeginDrag'); h.fire('onScroll', 140); h.fire('onScrollEndDrag', 240);
  h.fire('onMomentumScrollBegin'); h.update({ currentMs: 2050, isPlaying: true });
  h.advance(400); h.fire('onScroll', 340); h.fire('onMomentumScrollEnd', 440);
  assert.deepEqual(h.calls.seeks, [1000, 2000, 3000, 4000]);
  h.fire('onScroll', 540); assert.equal(h.calls.seeks.length, 4);
});

test('end-drag without momentum releases across ticks; new gestures can revisit a cue', () => {
  const h = mount();
  h.fire('onScrollBeginDrag'); h.fire('onScrollEndDrag', 240);
  h.update({ currentMs: 2100 }); h.advance(150); h.fire('onScroll', 440);
  assert.deepEqual(h.calls.seeks, [2000]);
  h.fire('onScrollBeginDrag'); h.fire('onScroll', 240);
  assert.deepEqual(h.calls.seeks, [2000, 2000]);
});

test('playback follows changing cues without reverse seeks', () => {
  const h = mount({ isPlaying: true }); h.update({ currentMs: 3100 });
  assert.equal(h.calls.indices.at(-1)?.index, 3);
  h.fire('onScroll', 340); h.advance(2000); h.fire('onScroll', 342);
  assert.deepEqual(h.calls.seeks, []);
  assert.deepEqual(h.calls.selects, [], 'following playback must not pause or select through the parent');
});

test('paused scroll publishes preview selection and time together across parent rerenders', () => {
  let selectedCaption = cues[0], currentMs = 0, isPlaying = false;
  const publications = [];
  const h = mount({
    initialCaptionId: selectedCaption.id,
    onSelectCaption: (caption) => { selectedCaption = caption; isPlaying = false; },
    onSeekTimeline: (ms) => {
      currentMs = ms;
      const activeCaption = cues.find((cue) => ms >= cue.startMs && ms < cue.endMs);
      const display = workspaceValue('displayCaption', { isPlaying, selectedCaption, activeCaption });
      publications.push([ms, display?.id]);
    },
  });
  h.fire('onScrollBeginDrag');
  for (const offset of [140, 240, 340]) {
    h.fire('onScroll', offset);
    h.update({ currentMs, isPlaying, initialCaptionId: selectedCaption.id });
    h.fire('onScroll', offset + 2);
  }
  h.fire('onScrollEndDrag', 340); h.advance(150);
  h.fire('onScroll', 440);
  assert.deepEqual(publications, [[1000, 'cue-1'], [2000, 'cue-2'], [3000, 'cue-3']]);
  assert.deepEqual(h.calls.indices, [], 'parent updates must not recenter a user scroll');
});

test('tapping during momentum hands navigation to the focused input before keyboard resize', () => {
  const h = mount();
  h.fire('onScrollBeginDrag'); h.fire('onScrollEndDrag', 240); h.fire('onMomentumScrollBegin');
  h.edit(4);
  h.calls.seeks.length = 0; h.calls.selects.length = 0; h.calls.indices.length = 0;
  h.keyboard('keyboardDidShow'); h.viewport(120); h.measure(4, 500, 200);
  h.fire('onScroll', 540); h.fire('onMomentumScrollEnd', 540); h.advance(200);
  assert.equal(h.input(4).value, 'caption 4');
  assert.equal(h.calls.indices.at(-1)?.index, 4);
  assert.equal(h.calls.indices.at(-1)?.viewPosition, 0);
  assert.deepEqual(h.calls.seeks, []); assert.deepEqual(h.calls.selects, []);
});

test('selecting an offscreen caption seeks it and keeps its input visible during playback', () => {
  const h = mount(); h.edit(4);
  assert.deepEqual(h.calls.selects, ['cue-4']); assert.deepEqual(h.calls.seeks, [4000]);
  assert.equal(h.calls.indices.at(-1)?.index, 4);
  h.calls.indices.length = 0;
  h.update({ isPlaying: true, currentMs: 1100 }); h.update({ currentMs: 2100 });
  assert.ok(h.calls.indices.every(({ index }) => index === 4));
  assert.equal(h.input(4).value, 'caption 4');
});

test('keyboard resize and growing input reveal the focused cue without seeking', () => {
  const h = mount(); h.edit(3); h.fire('onScroll', 350);
  h.calls.indices.length = 0; h.calls.seeks.length = 0;
  h.viewport(120); h.measure(3, 400, 180);
  h.act(() => h.input(3).onContentSizeChange?.());
  assert.equal(h.calls.indices.at(-1)?.index, 3);
  assert.equal(h.calls.indices.at(-1)?.viewPosition, 0);
  assert.ok(h.input(3).style.maxHeight <= 120);
  assert.deepEqual(h.calls.seeks, []);
});

test('split and merge navigation and scrolling use current draft identities and timings', () => {
  const h = mount(); h.edit(1); h.act(() => h.input(1).onChangeText('cap\ntion 1'));
  const split = h.list().data[2];
  assert.notEqual(split.id, cues[2].id); assert.equal(h.calls.indices.at(-1)?.index, 2);
  h.measure(2, 300, 80); h.calls.seeks.length = 0;
  h.fire('onScrollBeginDrag'); h.fire('onScroll', 240);
  assert.deepEqual(h.calls.seeks, [split.startMs]);
  h.fire('onScrollEndDrag', 240); h.advance(150); h.edit(2);
  h.act(() => h.input(2).onSelectionChange({ nativeEvent: { selection: { start: 0, end: 0 } } }));
  h.act(() => h.input(2).onKeyPress({ nativeEvent: { key: 'Backspace' } }));
  assert.equal(h.list().data.length, cues.length);
  assert.ok(!h.list().data.some(({ id }) => id === split.id));
  assert.equal(h.input(1).value, 'cap tion 1');
});

test('failed virtualized navigation is bounded and never seeks transport', () => {
  const h = mount(); h.edit(5); h.calls.seeks.length = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    h.act(() => h.list().onScrollToIndexFailed({ index: 5, averageItemLength: 100 }));
    h.fire('onScroll', 500); h.advance(100);
  }
  assert.ok(h.calls.offsets.length <= 3); assert.deepEqual(h.calls.seeks, []);
});

for (const interrupt of ['drag', 'close', 'unmount']) {
  test(`${interrupt} cancels pending virtualized navigation`, () => {
    const h = mount(); h.edit(5);
    h.act(() => h.list().onScrollToIndexFailed({ index: 5, averageItemLength: 100 }));
    if (interrupt === 'drag') h.fire('onScrollBeginDrag');
    if (interrupt === 'close') h.update({ visible: false });
    if (interrupt === 'unmount') h.unmount();
    h.calls.indices.length = 0; h.advance(1000); assert.deepEqual(h.calls.indices, []);
  });
}

test('reopening resets gestures and reveals the new initial cue', () => {
  const h = mount(); h.fire('onScrollBeginDrag'); h.fire('onScroll', 140);
  h.update({ visible: false }); h.update({ visible: true, initialCaptionId: 'cue-4' });
  h.calls.indices.length = 0; h.viewport(200);
  assert.equal(h.calls.indices.at(-1)?.index, 4);
  h.calls.seeks.length = 0; h.fire('onScroll', 440); assert.deepEqual(h.calls.seeks, []);
});

for (const platform of ['android', 'ios']) {
  test(`${platform} script fills reserved space independently of keyboard avoidance`, () => {
    const h = mount({}, platform), sheet = h.find('View');
    assert.equal(sheet.props.testID, 'caption-script-sheet');
    assert.equal(sheet.props.style.height, undefined); assert.equal(sheet.props.style.flex, 1);
    assert.notEqual(sheet.props.style.position, 'absolute'); assert.equal(sheet.props.style.minHeight, 0);
    assert.equal(sheet.props.style.overflow, 'hidden');
    const avoidance = h.find('KeyboardAvoidingView');
    assert.equal(avoidance.props.style.flex, 1); assert.notEqual(avoidance.props.behavior, 'height');
    assert.equal(avoidance.props.behavior, platform === 'ios' ? 'padding' : undefined);
    assert.equal(h.list().keyboardShouldPersistTaps, 'always');
    assert.equal(h.list().keyboardDismissMode, 'none');
    assert.equal(h.list().removeClippedSubviews, false);
  });
}

test('Android resized workspace keeps the video controls and focused input above the keyboard', () => {
  const h = mount(); h.edit(4); h.keyboard('keyboardDidShow');
  let workspaceHeight = 800;
  const onLayout = jsxProp(workspaceRoot, 'onLayout', { setWorkspaceHeight: (value) => { workspaceHeight = value; } });
  assert.equal(typeof onLayout, 'function', 'measure the usable root, not just the screen dimensions');
  const [preview, tools] = workspaceRoot.children.filter(ts.isJsxElement);
  const fitRect = evaluate(editorAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'fitRect').getText(editorAst));
  for (const availableHeight of [800, 360, 280, 240, 220, 440, 800]) {
    onLayout(layoutEvent(0, availableHeight));
    const context = { scriptEditorOpen: true, scriptKeyboardOpen: true, workspaceHeight, height: 800 };
    const previewHeight = workspaceValue('previewHeight', context);
    const previewStyle = jsxProp(preview, 'style', { previewHeight, scriptEditorOpen: true });
    assert.ok(previewStyle.height <= availableHeight * 0.45);
    assert.equal(jsxProp(tools, 'style', context).display, 'none', 'toolbar must not consume typing space');
    const canvas = workspaceValue('canvasSize', {
      previewHeight, fitRect, width: 360, project: { canvas: { aspectWidth: 16, aspectHeight: 9 } },
    });
    assert.ok(canvas.height >= 48, 'preview must still fit the playback control');
    assert.ok(canvas.height + 8 <= previewStyle.height, 'canvas and controls must stay above the sheet');
    const sheetHeight = availableHeight - previewStyle.height;
    const headerHeight = h.find('KeyboardAvoidingView').props.children[0].props.style.minHeight;
    const viewport = sheetHeight - headerHeight - 1;
    assert.ok(viewport >= 100, 'reserve two text lines and row insets above the keyboard');
    h.viewport(viewport); h.measure(4, 500, viewport + 80);
    const request = h.calls.indices.at(-1);
    assert.equal(request.index, 4); assert.equal(request.viewPosition, 0);
    assert.ok(h.input(4).style.minHeight >= 2 * h.input(4).style.lineHeight);
    const inputBottom = previewStyle.height + headerHeight + request.viewOffset + 14 + h.input(4).style.maxHeight;
    assert.ok(inputBottom < availableHeight, 'the focused input must end above the keyboard');
    h.fire('onScroll', 500 - request.viewOffset);
  }
  assert.deepEqual(h.calls.seeks, [4000], 'resize and reveal must not seek away from the edited cue');
  assert.equal(workspaceValue('previewHeight', { scriptEditorOpen: false, workspaceHeight: 280, height: 800 }), 344);
  assert.equal(jsxProp(tools, 'style', { scriptEditorOpen: false }).display, 'flex');
});

test('the leading edge seeks the first cue even when multiple short rows fit above the center guide', () => {
  const h = mount(); h.viewport(600);
  for (let index = 0; index < cues.length; index += 1) h.measure(index, 20 + index * 80, 72);
  h.fire('onScrollBeginDrag'); h.fire('onScroll', 0); h.fire('onScrollEndDrag', 0); h.advance(150);
  assert.deepEqual(h.calls.seeks, [0]);
  assert.deepEqual(h.calls.selects, ['cue-0']);
  h.calls.indices.length = 0;
  h.measure(0, 20, 72); h.viewport(580);
  assert.deepEqual(h.calls.indices, [], 'settled user scroll must survive later layout events');
});

test('tapping a visible or final short row aligns its editor at the top, including retry and resize', () => {
  const h = mount(); h.viewport(500);
  h.edit(1);
  assert.equal(h.calls.indices.at(-1)?.viewPosition, 0, 'visible rows must also move to the top');
  h.edit(5);
  h.act(() => h.list().onScrollToIndexFailed({ index: 5, averageItemLength: 100 }));
  h.advance(100); h.keyboard('keyboardDidShow'); h.viewport(140);
  assert.ok(h.calls.indices.filter(({ index }) => index === 5).every(({ viewPosition }) => viewPosition === 0));
  assert.ok(h.list().contentContainerStyle.paddingBottom >= 140, 'the final row needs enough trailing scroll space');
  h.fire('onScroll', 592); h.calls.indices.length = 0;
  h.act(() => h.input(5).onContentSizeChange());
  assert.deepEqual(h.calls.indices, [], 'already aligned input must not restart navigation');
});

test('dragging and tapping retain native inputs and focus without reopening a natively hidden keyboard', () => {
  const h = mount(); h.edit(1); h.keyboard('keyboardDidShow');
  assert.equal(h.calls.focusCaptures, cues.length, 'forward focus capture so native virtualization retains the focused cell');
  h.calls.indices.length = 0; h.calls.focuses.length = 0;
  h.fire('onScrollBeginDrag'); h.fire('onScroll', 340); h.fire('onScrollEndDrag', 340); h.advance(150);
  h.viewport(180); h.measure(1, 200, 160); h.act(() => h.input(1).onContentSizeChange());
  assert.equal(h.input(1).value, 'caption 1');
  assert.equal(h.input(1).scrollEnabled, true, 'the focused input stays editable while the list scrolls');
  assert.deepEqual(h.calls.indices, [], 'the old focused row must not reclaim a user scroll');
  assert.deepEqual(h.calls.focuses, [], 'list updates must not refocus the input');
  h.edit(4);
  assert.equal(h.input(1).value, 'caption 1', 'the previous native input must not unmount during focus transfer');
  assert.equal(h.input(4).scrollEnabled, true);
  assert.equal(h.input(4).submitBehavior, 'newline');
  assert.equal(h.calls.focuses.at(-1), 'cue-4');
  h.keyboard('keyboardDidHide'); h.calls.focuses.length = 0;
  h.viewport(500); h.fire('onScrollBeginDrag'); h.fire('onScrollEndDrag', 0); h.advance(150);
  assert.deepEqual(h.calls.focuses, [], 'native hide remains authoritative');
  assert.equal(h.calls.keyboards.at(-1), false);
});

test('draft text, empty text, splits, joins and recovery reach the actual parent preview selection before Save', () => {
  let scriptDraftCaptions = null, selectedCaptionId = cues[0].id, currentMs = 0;
  const h = mount({
    onDraftChange: (draft) => { scriptDraftCaptions = draft; },
    onSelectCaption: (caption) => { selectedCaptionId = caption.id; },
    onSeekTimeline: (ms) => { currentMs = ms; },
  });
  const display = (scriptEditorOpen = true, isPlaying = false) => {
    const previewCaptions = workspaceValue('previewCaptions', { scriptEditorOpen, scriptDraftCaptions, timelineCaptions: cues });
    const selectedCaption = workspaceValue('selectedCaption', { previewCaptions, selectedCaptionId });
    const activeCaption = workspaceValue('activeCaption', { previewCaptions, currentMs, useMemo: (fn) => fn() });
    return workspaceValue('displayCaption', { scriptEditorOpen, isPlaying, selectedCaption, activeCaption });
  };
  h.edit(1); h.act(() => h.input(1).onChangeText('live draft'));
  assert.equal(display().text, 'live draft');
  assert.equal(display(true, true).text, 'live draft', 'playback also uses drafts');
  h.act(() => h.input(1).onChangeText(''));
  assert.equal(display().text, '', 'empty text must not fall back to the saved cue');
  h.act(() => h.input(1).onChangeText('left\nright'));
  assert.equal(display().text, 'right');
  assert.equal(display().startMs, h.list().data[2].startMs);
  h.act(() => h.input(2).onSelectionChange({ nativeEvent: { selection: { start: 0, end: 0 } } }));
  h.act(() => h.input(2).onKeyPress({ nativeEvent: { key: 'Backspace' } }));
  assert.equal(display().text, 'left right');
  const recovered = cues.map((cue) => ({ ...cue, text: `restored ${cue.text}` }));
  h.recover(recovered); h.restore();
  assert.equal(display().text, 'restored caption 1');
  assert.equal(display(false).text, 'caption 1', 'closing returns preview to persisted captions');
  assert.equal(cues[1].text, 'caption 1');
  assert.deepEqual(h.calls.saves, [], 'preview publication never saves the project');
  h.update({ visible: false });
  assert.equal(scriptDraftCaptions, null);
  h.update({ visible: true });
  assert.equal(scriptDraftCaptions[1].text, 'caption 1');
  h.unmount(); assert.equal(scriptDraftCaptions, null);
});

test('workspace wires the draft channel and renders authored text while paused in the script editor', () => {
  const elements = [];
  const visit = (node) => { if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) elements.push(node); ts.forEachChild(node, visit); };
  visit(workspace);
  const script = elements.find((node) => node.tagName.getText(editorAst) === 'ScriptEditor');
  const attr = (node, name, context) => {
    const prop = node.attributes.properties.find((entry) => entry.name?.text === name);
    return evaluate(prop.initializer.expression.getText(editorAst), context);
  };
  const setScriptDraftCaptions = () => {}, setScriptKeyboardOpen = () => {};
  assert.equal(attr(script, 'onDraftChange', { setScriptDraftCaptions }), setScriptDraftCaptions);
  assert.equal(attr(script, 'onKeyboardChange', { setScriptKeyboardOpen }), setScriptKeyboardOpen);
  const overlay = elements.find((node) => node.tagName.getText(editorAst) === 'CaptionOverlay');
  assert.equal(attr(overlay, 'preserveLineBreaks', { scriptEditorOpen: true, isPlaying: false }), true);
  assert.equal(attr(overlay, 'preserveLineBreaks', { scriptEditorOpen: false, isPlaying: false }), false);
  assert.equal(attr(overlay, 'preserveLineBreaks', { scriptEditorOpen: true, isPlaying: true }), false);
});

test('opening and reopening never publish an empty or discarded previous draft', () => {
  const h = mount({ initialCaptionId: 'cue-4' });
  assert.ok(h.calls.drafts.filter(Boolean).every((draft) => draft.length === cues.length));
  h.edit(4); h.act(() => h.input(4).onChangeText('discard me'));
  h.update({ visible: false }); h.calls.drafts.length = 0;
  h.update({ visible: true });
  const publications = h.calls.drafts.filter(Boolean);
  assert.ok(publications.length > 0);
  assert.ok(publications.every((draft) => draft[4].text === 'caption 4'));
  h.update({ visible: false }); h.calls.drafts.length = 0;
  h.update({ visible: true });
  assert.ok(h.calls.drafts.filter(Boolean).length > 0, 'unchanged drafts still publish on reopen');
});

test('iOS keyboard avoidance uses the sheet screen position and compacts chrome for typing', () => {
  const h = mount({}, 'ios');
  const sheet = h.find('View');
  sheet.props.ref.current = { measureInWindow: (callback) => callback(0, 420, 360, 360) };
  h.act(() => sheet.props.onLayout());
  assert.equal(h.find('KeyboardAvoidingView').props.keyboardVerticalOffset, 420);
  h.keyboard('keyboardWillShow');
  assert.equal(h.find('KeyboardAvoidingView').props.children[0].props.style.minHeight, 44);
  h.edit(3); h.viewport(48);
  assert.ok(h.input(3).style.maxHeight < 48);
  h.keyboard('keyboardWillHide');
  assert.equal(h.find('KeyboardAvoidingView').props.children[0].props.style.minHeight, 76);
});

test('a fast fling waits for virtualized cells and resolves its final seek after momentum ends', () => {
  const captions = Array.from({ length: 100 }, (_, index) => ({ ...cues[0], id: `cue-${index}`, startMs: index * 1000, endMs: (index + 1) * 1000 }));
  const h = mount();
  // A new session clears measured cells. Simulate only the first batch mounting.
  h.update({ visible: false }); h.update({ visible: true, captions }); h.viewport(200);
  h.measure(0); h.measure(1);
  h.calls.seeks.length = 0;
  h.fire('onScrollBeginDrag'); h.fire('onScroll', 5040);
  h.fire('onScrollEndDrag', 5040); h.fire('onMomentumScrollBegin');
  h.fire('onMomentumScrollEnd', 5040);
  assert.deepEqual(h.calls.seeks, []);
  h.measure(49); assert.deepEqual(h.calls.seeks, []);
  h.measure(50); assert.deepEqual(h.calls.seeks, [50000]);
  assert.deepEqual(h.calls.selects, ['cue-50']);
  h.fire('onScroll', 5140); assert.deepEqual(h.calls.seeks, [50000]);
});
