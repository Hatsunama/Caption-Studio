import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as scriptMutations from '../src/lib/caption-script.ts';
import { applyStylePatch, resolveCaptionStyle } from '../src/lib/style-resolver.ts';
import { captionTransform } from '../src/lib/caption-transform.ts';
import { replaceVisibleCaptionScript } from '../src/lib/project-editor.ts';
import { decodeVersionTwoProject, serializeProjectSnapshot } from '../src/lib/project-schema.ts';
import { captionPreviewState } from '../src/lib/caption-preview.ts';
import { DEFAULT_CAPTION_STYLE } from '../src/types/project.ts';

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
const contentSizeEvent = (height, width = 240) => ({ nativeEvent: { contentSize: { width, height } } });
const plain = (value) => JSON.parse(JSON.stringify(value));

// Evaluate the real workspace expressions without loading its unrelated native
// services. This covers the parent selection and the layout the sheet receives.
const editorSource = readFileSync(process.env.CAPTION_EDITOR_SOURCE
  ?? new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
const editorAst = ts.createSourceFile('editor.tsx', editorSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const workspace = editorAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'EditorWorkspace');
const workspaceShell = workspace.body.statements.find(ts.isReturnStatement).expression.expression;
const workspaceRoot = workspaceShell.openingElement.tagName.getText(editorAst) === 'PersistedHorizontalScrollScope'
  ? workspaceShell.children.find(ts.isJsxElement)
  : workspaceShell;
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
    .flatMap((node) => [...node.declarationList.declarations]).find((node) => node.name.getText(editorAst) === name
      || (ts.isObjectBindingPattern(node.name) && node.name.elements.some((element) => element.name.getText(editorAst) === name)));
  const value = evaluate(declaration.initializer.getText(editorAst), { scriptEditorOpen: true, scriptKeyboardOpen: false,
    scriptEditingCaption: undefined, scriptCropActive: false, currentMs: 0, selectedCaptionId: undefined,
    useMemo: (fn) => fn(), captionPreviewState, project: { captions: cues },
    reconcileCaptionScriptDraft: scriptMutations.reconcileCaptionScriptDraft, ...context });
  if (!ts.isObjectBindingPattern(declaration.name)) return value;
  const element = declaration.name.elements.find((entry) => entry.name.getText(editorAst) === name);
  return value[(element.propertyName ?? element.name).getText(editorAst)];
}
function jsxProp(node, name, context) {
  const attribute = node.openingElement.attributes.properties.find((prop) => prop.name?.text === name);
  return attribute ? evaluate(attribute.initializer.expression.getText(editorAst), context) : undefined;
}

const crop = evaluate(editorAst.statements.find((node) => ts.isFunctionDeclaration(node)
  && node.name?.text === 'captionPreviewCrop')?.getText(editorAst) ?? 'undefined', {
  clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
});

function mount(overrides = {}, platform = 'android') {
  const slots = [];
  const timers = new Map();
  const keyboardListeners = new Map();
  let cursor = 0, dirty = false, effects = [], tree, now = 0, timerId = 0, recover, recoveryError;
  const calls = { seeks: [], selects: [], indices: [], offsets: [], drafts: [], keyboards: [], editing: [], focuses: [], alerts: [], saves: [], nativeLayouts: 0, focusCaptures: 0 };
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
        readEditorDraftJournal: () => ({ then: (callback) => { recover = callback; return { catch: (callback) => { recoveryError = callback; } }; } }),
        clearEditorDraftJournal: async () => { calls.journalClears = (calls.journalClears ?? 0) + 1; },
        writeEditorDraftJournal: async (...args) => { (calls.journals ??= []).push(plain(args)); },
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
    onEditingCaptionChange: (id) => calls.editing.push(id),
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
    action: (index, label) => act(() => walk(row(index), (node) => node.props?.label === label).props.onPress()),
    recover: (payload) => act(() => recover({ payload, baseRevision: 'revision' })),
    failRecovery: () => act(() => recoveryError(new Error('Read failed'))),
    restore: () => act(() => calls.alerts.at(-1)[2].find(({ text }) => text === 'Restore').onPress()),
    button: (label) => walk(tree, (node) => node.props?.accessibilityLabel === label).props,
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

test('drag seeks using cell-content coordinates and preserves native layout reporting', () => {
  const h = mount();
  h.fire('onScrollBeginDrag'); h.fire('onScroll', 292); h.fire('onScroll', 294);
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
  h.fire('onScrollBeginDrag'); h.fire('onScroll', 392);
  assert.deepEqual(h.calls.seeks, [3000]);
  h.update({ isPlaying: false }); h.fire('onScroll', 492);
  assert.deepEqual(h.calls.seeks, [3000, 4000]);
});

test('user momentum seeks across transport rerenders then releases ownership', () => {
  const h = mount();
  h.fire('onScrollBeginDrag'); h.fire('onScroll', 192); h.fire('onScrollEndDrag', 292);
  h.fire('onMomentumScrollBegin'); h.update({ currentMs: 2050, isPlaying: true });
  h.advance(400); h.fire('onScroll', 392); h.fire('onMomentumScrollEnd', 492);
  assert.deepEqual(h.calls.seeks, [1000, 2000, 3000, 4000]);
  h.fire('onScroll', 592); assert.equal(h.calls.seeks.length, 4);
});

test('end-drag without momentum releases across ticks; new gestures can revisit a cue', () => {
  const h = mount();
  h.fire('onScrollBeginDrag'); h.fire('onScrollEndDrag', 292);
  h.update({ currentMs: 2100 }); h.advance(150); h.fire('onScroll', 492);
  assert.deepEqual(h.calls.seeks, [2000]);
  h.fire('onScrollBeginDrag'); h.fire('onScroll', 292);
  assert.deepEqual(h.calls.seeks, [2000, 2000]);
});

test('playback follows changing cues without reverse seeks', () => {
  const h = mount({ isPlaying: true }); h.update({ currentMs: 3100 });
  assert.equal(h.calls.indices.at(-1)?.index, 3);
  h.fire('onScroll', 392); h.advance(2000); h.fire('onScroll', 342);
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
  for (const offset of [192, 292, 392]) {
    h.fire('onScroll', offset);
    h.update({ currentMs, isPlaying, initialCaptionId: selectedCaption.id });
    h.fire('onScroll', offset + 2);
  }
  h.fire('onScrollEndDrag', 392); h.advance(150);
  h.fire('onScroll', 492);
  assert.deepEqual(publications, [[1000, 'cue-1'], [2000, 'cue-2'], [3000, 'cue-3']]);
  assert.deepEqual(h.calls.indices, [], 'parent updates must not recenter a user scroll');
});

test('tapping during momentum hands navigation to the focused input before keyboard resize', () => {
  const h = mount();
  h.fire('onScrollBeginDrag'); h.fire('onScrollEndDrag', 292); h.fire('onMomentumScrollBegin');
  h.edit(4);
  h.calls.seeks.length = 0; h.calls.selects.length = 0; h.calls.indices.length = 0;
  h.keyboard('keyboardDidShow'); h.viewport(120); h.measure(4, 500, 200);
  h.fire('onScroll', 592); h.fire('onMomentumScrollEnd', 592); h.advance(200);
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
  h.act(() => h.input(3).onContentSizeChange(contentSizeEvent(230)));
  assert.equal(h.calls.indices.at(-1)?.index, 3);
  assert.equal(h.calls.indices.at(-1)?.viewPosition, 0);
  assert.equal(h.input(3).style.height, 230);
  assert.equal(h.input(3).style.maxHeight, undefined);
  assert.deepEqual(h.calls.seeks, []);
});

for (const platform of ['android', 'ios', 'web']) {
  test(`${platform} script input expands before focus and grows/shrinks with native wrapping`, () => {
    const text = 'A long sentence that must remain fully editable without clipping. '.repeat(12);
    const h = mount({ captions: [{ ...cues[0], text }, cues[1]] }, platform);
    assert.equal(h.input(0).value, text);
    assert.equal(h.input(0).multiline, true);
    assert.equal(h.input(0).style.maxHeight, undefined);
    // Native events include the first layout, narrower widths, font-scale
    // changes and deletion. Heights are not derived from character counts.
    for (const [height, width] of [[276.2, 240], [552.4, 120], [690, 120], [46, 240]]) {
      h.act(() => h.input(0).onContentSizeChange(contentSizeEvent(height, width)));
      assert.equal(h.input(0).style.height, Math.ceil(height));
      assert.equal(h.input(1).style.height, undefined, 'measurement belongs only to its caption');
      assert.equal(h.input(0).value, text, 'visual wrapping never inserts newlines');
    }
    assert.equal(h.input(0).maxLength, undefined, 'existing long captions must still accept typing');
    assert.deepEqual(h.calls.seeks, []);
    assert.deepEqual(h.calls.focuses, [], 'measurement before editing must not open the keyboard');
    h.edit(0); h.viewport(100);
    h.calls.seeks.length = 0; h.calls.selects.length = 0; h.calls.focuses.length = 0;
    h.act(() => h.input(0).onChangeText(`${text}\n\nAnother line\n`));
    h.act(() => h.input(0).onContentSizeChange(contentSizeEvent(805.3, 120)));
    h.measure(0, 120, 870);
    assert.equal(h.input(0).style.height, 806, 'typing may grow beyond the keyboard viewport');
    assert.equal(h.input(0).scrollEnabled, false);
    assert.equal(h.calls.indices.at(-1).index, 0);
    assert.equal(h.calls.indices.at(-1).viewPosition, 0);
    assert.deepEqual(h.calls.seeks, []);
    assert.deepEqual(h.calls.selects, []);
    assert.deepEqual(h.calls.focuses, [], 'resizing must not recreate or refocus the input');
    h.act(() => h.input(0).onChangeText('short'));
    h.act(() => h.input(0).onContentSizeChange(contentSizeEvent(23)));
    assert.equal(h.input(0).style.height, 23, 'deletion removes obsolete measured height');
    assert.equal(h.input(0).style.minHeight, 46, 'retain a usable editing touch target');
  });
}

test('script input retains explicit whitespace and metadata through typing, Backspace and Save', async () => {
  const original = {
    ...cues[0], text: '\nOriginal  line\r\n\nlast\n', textMode: 'automatic', timingMode: 'source',
    wordIds: ['word-0'], sourceAnchor: { clipId: 'clip', sourceStartMs: 100, sourceEndMs: 1100, wordIds: ['word-0'] },
    styleOverride: { fontSize: 37, textColor: '#abcdef', position: { x: 0.3, y: 0.8 }, maxWidth: 0.72 },
    timelineVisible: true,
  };
  const snapshot = structuredClone(original);
  const h = mount({ captions: [original, cues[1]] }); h.edit(0);
  h.calls.seeks.length = 0;
  assert.equal(h.input(0).value, original.text);
  for (const text of ['\n\nLeading  spaces\r\n\nnext\n', '\n\nLeading  spaces\r\n\nnext!\n', '  \n\t\n', 'final\n\n']) {
    h.act(() => h.input(0).onChangeText(text));
    h.act(() => h.input(0).onContentSizeChange(contentSizeEvent(138)));
    h.act(() => h.input(0).onSelectionChange({ nativeEvent: { selection: { start: 0, end: 0 } } }));
    h.act(() => h.input(0).onKeyPress?.({ nativeEvent: { key: 'Backspace' } }));
    assert.equal(h.list().data.length, 2, 'ordinary typing must never split or join timed cues');
    assert.equal(h.input(0).value, text);
    assert.deepEqual(plain(h.list().data[0]), { ...snapshot, text, textMode: 'manual' });
    assert.equal(h.list().data[1], cues[1]);
    assert.deepEqual(h.calls.drafts.at(-1)[0], { ...snapshot, text, textMode: 'manual' });
  }
  const done = h.find('KeyboardAvoidingView').props.children[0].props.children[2];
  h.act(() => done.props.onPress());
  await Promise.resolve();
  assert.deepEqual(h.calls.saves[0][0], { ...snapshot, text: 'final\n\n', textMode: 'manual' });
  assert.deepEqual(h.calls.seeks, []);
  assert.deepEqual(original, snapshot, 'authored caption must remain immutable');
});

test('typing delivered while Save is pending stays open for an explicit second save', async () => {
  let releaseSave;
  let closes = 0;
  const pendingSave = new Promise((resolve) => { releaseSave = resolve; });
  const h = mount({
    onSave: async (captions) => { h.calls.saves.push(plain(captions)); return pendingSave; },
    onCancel: () => { closes += 1; },
  });
  h.edit(0);
  h.act(() => h.input(0).onChangeText('first revision'));
  const done = h.find('KeyboardAvoidingView').props.children[0].props.children[2];
  h.act(() => done.props.onPress());
  assert.equal(h.input(0).editable, false, 'native editing is disabled while the snapshot persists');
  h.act(() => h.input(0).onChangeText('newer queued revision'));
  releaseSave(true);
  await Promise.resolve();
  await Promise.resolve();
  h.act(() => {});
  assert.equal(closes, 0, 'a save of an older snapshot must not close over newer text');
  assert.equal(h.input(0).value, 'newer queued revision');
  assert.equal(h.calls.saves[0][0].text, 'first revision');
});

test('script input measurements survive focus transfer, reject invalid events and reset on reopen', () => {
  const h = mount();
  h.act(() => h.input(0).onContentSizeChange(contentSizeEvent(345)));
  h.edit(0); h.edit(1);
  assert.equal(h.input(0).style.height, 345);
  for (const height of [0, -1, NaN, Infinity, 345]) {
    h.act(() => h.input(0).onContentSizeChange(contentSizeEvent(height)));
    assert.equal(h.input(0).style.height, 345);
  }
  h.update({ visible: false }); h.update({ visible: true });
  assert.equal(h.input(0).style.height, undefined, 'a new session must measure its own text and width');
  const restored = cues.map((cue) => ({ ...cue, text: `${cue.text}\n\n${'restored text '.repeat(30)}\n` }));
  h.recover(restored); h.restore();
  h.act(() => h.input(0).onContentSizeChange(contentSizeEvent(506)));
  assert.equal(h.input(0).value, restored[0].text);
  assert.equal(h.input(0).style.height, 506, 'recovery is measured without requiring focus');
});

test('split and merge navigation and scrolling use current draft identities and timings', () => {
  const h = mount(); h.edit(1);
  h.act(() => h.input(1).onSelectionChange({ nativeEvent: { selection: { start: 3, end: 3 } } }));
  h.action(1, 'Split here');
  const split = h.list().data[2];
  assert.notEqual(split.id, cues[2].id); assert.equal(h.calls.indices.at(-1)?.index, 2);
  h.measure(2, 300, 80); h.calls.seeks.length = 0;
  h.fire('onScrollBeginDrag'); h.fire('onScroll', 292);
  assert.deepEqual(h.calls.seeks, [split.startMs]);
  h.fire('onScrollEndDrag', 292); h.advance(150); h.edit(2);
  h.act(() => h.input(2).onSelectionChange({ nativeEvent: { selection: { start: 0, end: 0 } } }));
  h.action(2, 'Join previous');
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
  const h = mount(); h.fire('onScrollBeginDrag'); h.fire('onScroll', 192);
  h.update({ visible: false }); h.update({ visible: true, initialCaptionId: 'cue-4' });
  h.calls.indices.length = 0; h.viewport(200);
  assert.equal(h.calls.indices.at(-1)?.index, 4);
  h.calls.seeks.length = 0; h.fire('onScroll', 492); assert.deepEqual(h.calls.seeks, []);
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
    const scriptCrop = crop(16 / 9, 280, previewHeight - 8, { x: 0.5, y: 0.78 });
    const canvas = workspaceValue('canvasSize', {
      scriptCropActive: true, scriptCrop, previewHeight, fitRect, width: 360, project: { canvas: { aspectWidth: 16, aspectHeight: 9 } },
    });
    assert.ok(scriptCrop.viewport.height >= 48, 'preview must still fit the playback control');
    assert.ok(scriptCrop.viewport.height + 8 <= previewStyle.height, 'crop and controls must stay above the sheet');
    assert.ok(canvas.width >= 280, 'retain readable canvas scale while the keyboard resizes');
    const sheetHeight = availableHeight - previewStyle.height;
    const headerHeight = h.find('KeyboardAvoidingView').props.children[0].props.style.minHeight;
    const viewport = sheetHeight - headerHeight - 1;
    assert.ok(viewport >= 100, 'reserve two text lines and row insets above the keyboard');
    h.viewport(viewport); h.measure(4, 500, viewport + 80);
    const request = h.calls.indices.at(-1);
    assert.equal(request.index, 4); assert.equal(request.viewPosition, 0);
    assert.ok(h.input(4).style.minHeight >= 2 * h.input(4).style.lineHeight);
    const inputTop = previewStyle.height + headerHeight + request.viewOffset + 14;
    assert.ok(inputTop + h.input(4).style.lineHeight < availableHeight, 'the focused input starts above the keyboard; long text extends in the list');
    assert.equal(h.input(4).style.maxHeight, undefined, 'keyboard resize must never cap the text height');
    h.fire('onScroll', 500 - request.viewOffset);
  }
  assert.deepEqual(h.calls.seeks, [4000], 'resize and reveal must not seek away from the edited cue');
  assert.equal(workspaceValue('previewHeight', { scriptEditorOpen: false, workspaceHeight: 280, height: 800 }), 344);
  assert.equal(jsxProp(tools, 'style', { scriptEditorOpen: false }).display, 'flex');
});

test('the leading edge seeks the first cue even when multiple short rows fit in the viewport', () => {
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
  assert.ok(h.list().ListFooterComponent.props.style.height >= 132, 'the final row needs enough trailing scroll space to reach the 8px anchor');
  h.fire('onScroll', 592); h.calls.indices.length = 0;
  h.act(() => h.input(5).onContentSizeChange(contentSizeEvent(69)));
  assert.deepEqual(h.calls.indices, [], 'already aligned input must not restart navigation');
});

test('dragging and tapping retain native inputs and focus without reopening a natively hidden keyboard', () => {
  const h = mount(); h.edit(1); h.keyboard('keyboardDidShow');
  assert.equal(h.calls.focusCaptures, cues.length, 'forward focus capture so native virtualization retains the focused cell');
  h.calls.indices.length = 0; h.calls.focuses.length = 0;
  h.fire('onScrollBeginDrag'); h.fire('onScroll', 392); h.fire('onScrollEndDrag', 392); h.advance(150);
  h.viewport(180); h.measure(1, 200, 160); h.act(() => h.input(1).onContentSizeChange(contentSizeEvent(92)));
  assert.equal(h.input(1).value, 'caption 1');
  assert.equal(h.input(1).scrollEnabled, false, 'the list scrolls the fully expanded input');
  assert.deepEqual(h.calls.indices, [], 'the old focused row must not reclaim a user scroll');
  assert.deepEqual(h.calls.focuses, [], 'list updates must not refocus the input');
  h.edit(4);
  assert.equal(h.input(1).value, 'caption 1', 'the previous native input must not unmount during focus transfer');
  assert.equal(h.input(4).scrollEnabled, false);
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
  assert.equal(display().text, 'left\nright');
  assert.equal(display().startMs, cues[1].startMs);
  h.act(() => h.input(1).onChangeText('left right'));
  h.act(() => h.input(1).onSelectionChange({ nativeEvent: { selection: { start: 4, end: 4 } } }));
  h.action(1, 'Split here');
  assert.equal(display().text, 'right');
  assert.equal(display().startMs, h.list().data[2].startMs);
  h.act(() => h.input(2).onSelectionChange({ nativeEvent: { selection: { start: 0, end: 0 } } }));
  h.action(2, 'Join previous');
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
  assert.equal(attr(overlay, 'editingPreview', { scriptEditorOpen: true, isPlaying: false }), true);
  assert.equal(attr(overlay, 'editingPreview', { scriptEditorOpen: false, isPlaying: false }), false);
  assert.equal(attr(overlay, 'editingPreview', { scriptEditorOpen: true, isPlaying: true }), false);
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

const migrationProject = () => JSON.parse(readFileSync(new URL('./fixtures/legacy-caption-layout.json', import.meta.url), 'utf8')).project;
const scriptTransform = { position: { x: 0.4, y: 0.3 }, rotation: 33, scale: 1.4, scaleX: 0.8, scaleY: 1.2,
  box: { width: 0.7, height: 0.2 } };
const settleSave = () => new Promise((resolve) => setImmediate(resolve));

for (const rejection of ['throw', 'false']) test(`rejected script save (${rejection}) retains the open editor and recovery journal`, async () => {
  let project = migrationProject(), closes = 0;
  const before = serializeProjectSnapshot(project);
  const parentSave = workspaceValue('commitCaptionScript', {
    commitEditorProject: async (mutation) => {
      const next = mutation(project);
      project = next;
      return { before: project, project: next };
    },
    replaceVisibleCaptionScript, editorSession: { isCurrent: () => true }, selectedCaptionId: 'c0',
    changedPrimaryCaptionTextIds: () => [], setSelectedCaptionId: () => {},
  });
  const h = mount({ captions: project.captions, onSave: rejection === 'false' ? async () => false : parentSave,
    onCancel: () => { closes++; } });
  const invalid = structuredClone(project.captions);
  invalid[0].endMs = invalid[0].startMs + 40;
  invalid[1].text = 'Keep this unsaved edit';
  h.recover(invalid); h.restore(); h.advance(1000);
  const journals = plain(h.calls.journals);
  assert.ok(journals.length > 0);
  h.act(() => h.button('Save all caption edits').onPress());
  await settleSave(); h.act(() => {});
  assert.equal(closes, 0);
  assert.equal(h.calls.journalClears ?? 0, 0);
  assert.deepEqual(h.calls.journals, journals);
  assert.deepEqual(plain(h.list().data), invalid);
  assert.equal(h.button('Save all caption edits').disabled, false);
  assert.equal(serializeProjectSnapshot(project), before);
  h.unmount();
});

for (const legacyDuration of [0, 1, 40, 79]) test(`script component restores and saves a journal containing a ${legacyDuration} ms legacy cue without losing edits`, async () => {
  let project = migrationProject(), closes = 0;
  project.captions[0].endMs = legacyDuration;
  project = decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(project)));
  const save = workspaceValue('commitCaptionScript', {
    commitEditorProject: async (mutation) => {
      const before = project;
      project = decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(mutation(before))));
      return { before, project };
    },
    replaceVisibleCaptionScript, editorSession: { isCurrent: () => true }, selectedCaptionId: 'c0',
    changedPrimaryCaptionTextIds: () => [], setSelectedCaptionId: () => {},
  });
  const h = mount({ captions: project.captions, onSave: save, onCancel: () => {
    assert.equal(project.captions[1].text, 'Durable separate edit'); closes++;
  } });
  const recovery = structuredClone(project.captions);
  recovery[1].text = 'Recovered journal text';
  h.recover(recovery);
  assert.equal(h.calls.alerts.at(-1)[0], 'Restore unsaved caption edits?');
  // Even an edit dispatched while the prompt is pending cannot overwrite it.
  h.act(() => h.input(1).onChangeText('Before recovery decision')); h.advance(1000);
  assert.equal(h.calls.journals, undefined);
  assert.equal(h.calls.journalClears, undefined);
  h.restore();
  assert.equal(h.input(1).value, 'Recovered journal text');
  h.edit(1); h.act(() => h.input(1).onChangeText('Durable separate edit')); h.advance(1000);
  assert.equal(h.calls.journals.at(-1)[3][0].endMs, legacyDuration);
  assert.equal(h.calls.journals.at(-1)[3][1].text, 'Durable separate edit');
  h.act(() => h.button('Save all caption edits').onPress());
  await settleSave();
  assert.equal(closes, 1);
  assert.equal(h.calls.journalClears, 1);
  assert.equal(project.captions[0].endMs, legacyDuration);
  h.unmount();
});

test('an undecodable recovery journal stays protected from the next debounced edit', () => {
  const h = mount();
  h.recover([{ ...cues[0], wordIds: 'invalid' }]);
  h.act(() => h.input(1).onChangeText('Do not replace unread recovery'));
  h.advance(2000);
  assert.equal(h.calls.journals, undefined);
  assert.equal(h.calls.journalClears, undefined);
  h.unmount();
});

test('a failed recovery read cannot authorize overwriting the unread journal', () => {
  const h = mount();
  h.failRecovery();
  h.act(() => h.input(1).onChangeText('Preserve unread recovery'));
  h.advance(2000);
  assert.equal(h.calls.journals, undefined);
  assert.equal(h.calls.journalClears, undefined);
  h.unmount();
});

test('zero-duration recovery survives editing another cue and a second journal restore', () => {
  const project = migrationProject();
  project.captions[0].endMs = project.captions[0].startMs;
  const original = decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(project)));
  const recovery = structuredClone(original.captions);
  recovery[1].text = 'Previously unsaved words';
  const h = mount({ captions: original.captions });
  h.recover(recovery); h.restore();
  h.act(() => h.input(0).onChangeText('Next edit in zero cue')); h.advance(1000);
  const payload = h.calls.journals.at(-1)[3];
  assert.equal(payload[0].endMs, payload[0].startMs);
  assert.equal(payload[0].text, 'Next edit in zero cue');
  assert.equal(payload[1].text, 'Previously unsaved words');
  h.unmount();
  const reopened = mount({ captions: original.captions });
  reopened.recover(payload);
  assert.equal(reopened.calls.alerts.at(-1)[0], 'Restore unsaved caption edits?');
  reopened.restore();
  assert.deepEqual(plain(reopened.list().data), payload);
  reopened.unmount();
});

for (const recovered of [false, true]) test(`script component split -> transform -> ${recovered ? 'delayed recovery -> ' : ''}save -> reopen uses current geometry`, async () => {
  let project = migrationProject(), closes = 0;
  // Execute the workspace's real save transaction, with the project fetched at
  // commit time. The sheet still owns its pre-transform draft and split IDs.
  const save = workspaceValue('commitCaptionScript', {
    commitEditorProject: async (mutation) => {
      const before = project;
      project = mutation(before);
      return { before, project };
    },
    replaceVisibleCaptionScript, editorSession: { isCurrent: () => true }, selectedCaptionId: 'c0',
    changedPrimaryCaptionTextIds: () => [], setSelectedCaptionId: () => {},
  });
  const h = mount({ captions: project.captions, onSave: save, onCancel: () => { closes++; } });
  h.edit(0);
  h.act(() => h.input(0).onSelectionChange({ nativeEvent: { selection: { start: 6, end: 6 } } }));
  h.action(0, 'Split here');
  const draft = plain(h.list().data);
  assert.equal(draft.length, 3);
  project = applyStylePatch(project, 'c1', 'caption', scriptTransform);
  project.captions[0].styleOverride = { italic: false, textColor: '#FFFFFF' };
  h.update({ captions: project.captions, baseRevision: 'after-transform' });
  if (recovered) { h.recover(draft); h.restore(); }
  const preview = workspaceValue('previewCaptions', {
    project, timelineCaptions: project.captions, scriptDraftCaptions: h.list().data,
  });
  for (const cue of preview) assert.deepEqual(captionTransform(resolveCaptionStyle(project.projectStyle, cue)), scriptTransform);
  h.act(() => h.button('Save all caption edits').onPress());
  await settleSave();
  assert.equal(closes, 1);
  assert.equal(h.calls.journalClears ?? 0, recovered ? 1 : 0, 'saving before recovery finishes must retain the unread journal');
  project = decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(project)));
  assert.deepEqual(project.captions.map(({ id, text, startMs, endMs, wordIds }) => ({ id, text, startMs, endMs, wordIds })),
    draft.map(({ id, text, startMs, endMs, wordIds }) => ({ id, text, startMs, endMs, wordIds })));
  for (const cue of project.captions) assert.deepEqual(captionTransform(resolveCaptionStyle(project.projectStyle, cue)), scriptTransform);
  assert.equal(project.captions[0].styleOverride.italic, false);
  assert.equal(project.captions[1].styleOverride.italic, true, 'new split keeps authored non-geometry appearance');
});

test('cancel after a transform preserves project and clears only the script recovery; stale restore cannot cross sessions', async () => {
  let project = migrationProject(), closes = 0;
  const h = mount({ captions: project.captions, onCancel: () => { closes++; } });
  h.recover(project.captions.map((cue) => ({ ...cue, text: 'Recovered ' + cue.text })));
  const staleRestore = h.calls.alerts.at(-1)[2].find((action) => action.text === 'Restore').onPress;
  h.restore();
  project = applyStylePatch(project, 'c0', 'caption', scriptTransform);
  h.update({ captions: project.captions, baseRevision: 'transformed' });
  const snapshot = serializeProjectSnapshot(project);
  h.act(() => h.button('Cancel caption edits').onPress());
  assert.equal(h.calls.alerts.at(-1)[0], 'Discard unsaved caption edits?');
  h.act(() => h.calls.alerts.at(-1)[2].find((action) => action.text === 'Discard').onPress());
  await settleSave();
  assert.equal(closes, 1);
  assert.equal(h.calls.journalClears, 1);
  assert.deepEqual(h.calls.saves, []);
  assert.equal(serializeProjectSnapshot(project), snapshot);
  h.update({ visible: false }); h.update({ visible: true });
  h.act(staleRestore);
  assert.deepEqual(plain(h.list().data), project.captions);
});

test('appearance-only project updates do not create a dirty script or cancel pending recovery', async () => {
  let project = migrationProject(), closes = 0;
  const h = mount({ captions: project.captions, onCancel: () => { closes++; } });
  project = applyStylePatch(project, 'c0', 'caption', scriptTransform);
  h.update({ captions: project.captions, baseRevision: 'transformed' });
  h.recover(null);
  h.advance(1000);
  assert.equal(h.calls.journals, undefined);
  h.act(() => h.button('Cancel caption edits').onPress());
  await settleSave();
  assert.equal(closes, 1);
  assert.deepEqual(h.calls.alerts, []);
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
  assert.equal(h.input(3).style.maxHeight, undefined);
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
  h.fire('onScrollBeginDrag'); h.fire('onScroll', 5092);
  h.fire('onScrollEndDrag', 5092); h.fire('onMomentumScrollBegin');
  h.fire('onMomentumScrollEnd', 5092);
  assert.deepEqual(h.calls.seeks, []);
  h.measure(49); assert.deepEqual(h.calls.seeks, []);
  h.measure(50); assert.deepEqual(h.calls.seeks, [50000]);
  assert.deepEqual(h.calls.selects, ['cue-50']);
  h.fire('onScroll', 5192); assert.deepEqual(h.calls.seeks, [50000]);
});

for (const viewport of [120, 300, 600]) {
  for (const heights of [[72, 72, 72, 72, 72, 72], [340, 72, 180, 90, 240, 72]]) {
    test(`first, second and final cues reach the same anchor with ${viewport}px viewport and ${heights[0]}px first row`, () => {
      const h = mount(); h.viewport(viewport);
      const header = h.list().ListHeaderComponent.props;
      const leading = header.style.minHeight;
      const trailing = h.list().ListFooterComponent.props.style.height;
      const gap = h.list().ItemSeparatorComponent().props.style.height;
      h.act(() => header.onLayout(layoutEvent(0, leading)));
      assert.ok(leading > 8, 'first cue has real scroll travel below the anchor');
      assert.ok(trailing >= viewport - 8, 'final cue has explicit trailing travel');
      let nextY = leading;
      const positions = heights.map((rowHeight, index) => {
        const y = nextY;
        h.measure(index, y, rowHeight); nextY += rowHeight + gap;
        return y;
      });
      const maximumOffset = Math.max(0, nextY - gap + trailing - viewport);
      h.fire('onScrollBeginDrag'); h.fire('onScroll', 0);
      h.fire('onScroll', leading - 8); h.fire('onScrollEndDrag', leading - 8); h.advance(150);
      assert.deepEqual(h.calls.seeks, [0], 'leading space and the exact first anchor must never select cue 2');
      for (const index of [0, 1, 5]) {
        h.calls.indices.length = 0; h.edit(index);
        // An already aligned row may need no native request.
        const request = h.calls.indices.at(-1) ?? { index, viewPosition: 0, viewOffset: 8 };
        assert.equal(request.index, index); assert.equal(request.viewPosition, 0);
        const requestedOffset = positions[index] - request.viewOffset;
        const nativeOffset = Math.max(0, Math.min(maximumOffset, requestedOffset));
        assert.equal(positions[index] - nativeOffset, 8, 'native clamping must not prevent top alignment');
        h.calls.seeks.length = 0; h.calls.selects.length = 0;
        h.fire('onScroll', nativeOffset);
        assert.deepEqual(h.calls.seeks, [], 'programmatic alignment must not seek transport');
        h.fire('onScrollBeginDrag'); h.fire('onScroll', nativeOffset);
        h.fire('onScrollEndDrag', nativeOffset); h.advance(150);
        assert.deepEqual(h.calls.seeks, [cues[index].startMs]);
        assert.deepEqual(h.calls.selects, [cues[index].id]);
      }
    });
  }
}

test('unmeasured first cue owns the leading edge, including overscroll and delayed second-cell layout', () => {
  const h = mount(); h.update({ visible: false }); h.update({ visible: true }); h.viewport(500);
  h.measure(1, 176, 72);
  h.calls.seeks.length = 0; h.calls.selects.length = 0;
  h.fire('onScrollBeginDrag'); h.fire('onScroll', -18); h.fire('onScroll', 0);
  h.measure(1, 176, 72); h.measure(0, 96, 72);
  h.fire('onScrollEndDrag', 0); h.advance(150);
  assert.deepEqual(h.calls.seeks, [0]); assert.deepEqual(h.calls.selects, ['cue-0']);
});

test('forward scrolling stays user-owned across keyboard resize and late layouts without reverse seeks', () => {
  const h = mount(); h.edit(0); h.keyboard('keyboardDidShow');
  h.calls.seeks.length = 0; h.calls.indices.length = 0;
  h.fire('onScrollBeginDrag'); h.fire('onScroll', 192);
  h.fire('onScroll', 292); h.viewport(140); h.measure(0, 100, 180);
  h.fire('onScrollEndDrag', 292); h.advance(150); h.measure(1, 200, 80);
  assert.deepEqual(h.calls.seeks, [1000, 2000]);
  assert.deepEqual(h.calls.indices, []);
  assert.equal(h.calls.editing.at(-1), undefined, 'a user scroll releases the old input camera target');
  h.edit(2); assert.equal(h.calls.editing.at(-1), 'cue-2');
});

test('offscreen retry includes measured leading space and the top editing anchor', () => {
  const h = mount();
  h.act(() => h.list().ListHeaderComponent.props.onLayout(layoutEvent(0, 148)));
  h.edit(5); h.act(() => h.list().onScrollToIndexFailed({ index: 5, averageItemLength: 100 }));
  assert.equal(h.calls.offsets.at(-1).offset, 148 + 500 - 8);
  h.advance(100);
  assert.equal(h.calls.indices.at(-1).viewOffset, 8);
});

for (const aspect of [9 / 16, 16 / 9, 1]) {
  test(`keyboard crop retains canvas scale, caption position and video context at aspect ${aspect}`, () => {
    for (const viewportHeight of [64, 104, 136, 172]) {
      for (const position of [{ x: 0.1, y: 0.08 }, { x: 0.5, y: 0.5 }, { x: 0.9, y: 0.92 }]) {
        const result = crop(aspect, 280, viewportHeight, position);
        assert.ok(result.canvas.width >= 280, 'never contain the whole frame in a thumbnail');
        assert.ok(Math.abs(result.canvas.width / result.canvas.height - aspect) < 1e-9);
        assert.ok(result.canvas.height >= viewportHeight);
        assert.ok(result.x <= 0 && result.y <= 0);
        assert.ok(result.x + result.canvas.width >= result.viewport.width - 1e-9);
        assert.ok(result.y + result.canvas.height >= result.viewport.height - 1e-9);
        const captionX = position.x * result.canvas.width + result.x;
        const captionY = position.y * result.canvas.height + result.y;
        assert.ok(captionX >= 0 && captionX <= 280);
        assert.ok(captionY >= 0 && captionY <= viewportHeight);
        assert.ok(Math.min(captionY, viewportHeight - captionY) >= Math.min(viewportHeight / 2, result.canvas.height * 0.08) - 1e-9,
          'retain visible canvas context on both sides of the caption center');
      }
    }
    const top = crop(aspect, 280, 64, { x: 0.5, y: 0.2 });
    const bottom = crop(aspect, 280, 64, { x: 0.5, y: 0.8 });
    assert.deepEqual(plain(top.canvas), plain(bottom.canvas), 'selection pans without rescaling the composition');
    assert.ok(top.y > bottom.y, 'different authored positions produce different crops');
    const a = crop(aspect, 280, 64, { x: 0.5, y: 0.5 });
    const b = crop(aspect, 280, 64, { x: 0.5, y: 0.5001 });
    assert.ok(Math.abs(a.y - b.y) < 0.1, 'small position edits cannot jump between crop presets');
  });
}

test('crop clamps invalid dimensions and positions without NaN or exposed canvas edges', () => {
  for (const aspect of [0, -1, NaN, Infinity]) {
    const result = crop(aspect, 280, 100, { x: NaN, y: Infinity });
    assert.equal(result.canvas.width, result.canvas.height);
    assert.ok(Number.isFinite(result.x) && Number.isFinite(result.y));
  }
  const empty = crop(1, -20, NaN, { x: -10, y: 10 });
  assert.equal(empty.viewport.width, 0); assert.equal(empty.viewport.height, 0);
  const low = crop(1, 280, 100, { x: -10, y: -10 });
  const high = crop(1, 280, 100, { x: 10, y: 10 });
  assert.equal(Math.abs(low.y), 0); assert.equal(high.y, -180);
});

test('crop uses current draft overrides and editing, paused selection, playback timing, and gap fallback', () => {
  const previewCaptions = cues.map((cue, index) => ({ ...cue, styleOverride: { position: { y: 0.15 + index * 0.13 } } }));
  const selectedCaption = previewCaptions[1];
  const activeAt = (currentMs) => workspaceValue('activeCaption', { previewCaptions, currentMs, useMemo: (fn) => fn() });
  const editing = workspaceValue('scriptEditingCaption', { previewCaptions, scriptKeyboardOpen: true, scriptEditingCaptionId: 'cue-0' });
  const resolveCrop = (displayCaption) => {
    const cropCaptionStyle = workspaceValue('cropCaptionStyle', { displayCaption, project: { projectStyle: DEFAULT_CAPTION_STYLE }, resolveCaptionStyle });
    return workspaceValue('scriptCrop', {
      captionPreviewCrop: crop, width: 360, previewHeight: 112, cropCaptionStyle,
      lastCropPosition: { x: 0.5, y: 0.78 },
      project: { canvas: { aspectWidth: 9, aspectHeight: 16 } },
    });
  };
  const focusedDisplay = workspaceValue('displayCaption', { scriptEditingCaption: editing, selectedCaption, activeCaption: activeAt(3100), isPlaying: true });
  assert.equal(focusedDisplay.id, 'cue-0', 'an actively edited input remains the camera target during playback');
  const pausedDisplay = workspaceValue('displayCaption', { selectedCaption, activeCaption: activeAt(3100), isPlaying: false });
  assert.equal(pausedDisplay.id, 'cue-1');
  const playingDisplay = workspaceValue('displayCaption', { selectedCaption, activeCaption: activeAt(3100), isPlaying: true });
  assert.equal(playingDisplay.id, 'cue-3');
  assert.ok(resolveCrop(focusedDisplay).y > resolveCrop(pausedDisplay).y);
  assert.ok(resolveCrop(pausedDisplay).y > resolveCrop(playingDisplay).y);
  previewCaptions[1].styleOverride.position.y = 0.9;
  assert.ok(resolveCrop(pausedDisplay).y < resolveCrop(playingDisplay).y, 'live position overrides retarget the crop');
  const gapDisplay = workspaceValue('displayCaption', { selectedCaption, activeCaption: activeAt(9000), isPlaying: true });
  assert.equal(gapDisplay, undefined);
  assert.deepEqual(plain(resolveCrop(gapDisplay)), plain(crop(9 / 16, 280, 104, { x: 0.5, y: 0.78 })));
});

test('crop animation retargets on the native driver and cancels stale motion on exit', () => {
  const effect = workspace.body.statements.find((node) => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression) && node.expression.expression.getText(editorAst) === 'useEffect'
    && node.getText(editorAst).includes('Animated.timing(cropOffset'));
  const calls = [];
  const cropOffset = { setValue: (value) => calls.push(['set', plain(value)]) };
  const Animated = { timing: (value, config) => {
    assert.equal(value, cropOffset); calls.push(['target', plain(config)]);
    return { start: () => calls.push(['start']), stop: () => calls.push(['stop']) };
  } };
  const run = (scriptCropActive, scriptCrop) => evaluate(effect.expression.arguments[0].getText(editorAst), { cropOffset, Animated, scriptCropActive, scriptCrop })();
  const cancelFirst = run(true, { x: 0, y: -100 }); cancelFirst();
  const cancelNext = run(true, { x: 0, y: -300 }); cancelNext(); run(false, { x: 0, y: -300 });
  assert.deepEqual(calls.map(([kind]) => kind), ['target', 'start', 'stop', 'target', 'start', 'stop', 'set']);
  assert.equal(calls[0][1].useNativeDriver, true); assert.equal(calls[0][1].isInteraction, false);
  assert.equal(calls[0][1].duration, 180);
  assert.deepEqual(calls[3][1].toValue, { x: 0, y: -300 });
  assert.deepEqual(calls.at(-1), ['set', { x: 0, y: 0 }]);
});

test('video and caption overlays share the cropped canvas while playback controls stay outside it', () => {
  const nodes = [];
  const visit = (node) => { if (ts.isJsxElement(node)) nodes.push(node); ts.forEachChild(node, visit); };
  visit(workspaceRoot);
  const byId = (id) => nodes.find((node) => node.openingElement.attributes.properties.some((prop) => prop.name?.text === 'testID' && prop.initializer?.text === id));
  const viewport = byId('script-preview-viewport'), canvas = byId('script-preview-canvas');
  assert.equal(canvas.parent, viewport);
  assert.equal(canvas.openingElement.tagName.getText(editorAst), 'Animated.View');
  const canvasSource = canvas.getText(editorAst);
  assert.ok(canvasSource.includes('<VideoView')); assert.ok(canvasSource.includes('<CaptionOverlay'));
  const play = nodes.find((node) => node.openingElement.attributes.properties.some((prop) => prop.name?.text === 'accessibilityLabel'
    && prop.initializer?.expression?.getText(editorAst).includes("'Pause video'")));
  assert.equal(play.parent, viewport.parent, 'playback stays outside the moving and clipped canvas');
  const scriptCrop = crop(9 / 16, 280, 104, { x: 0.5, y: 0.78 });
  assert.equal(jsxProp(viewport, 'style', { scriptCropActive: true, scriptCrop }).overflow, 'hidden');
  const style = jsxProp(play, 'style', { scriptCropActive: true, scriptCrop });
  assert.equal(style.width, 48); assert.equal(style.height, 48);
  assert.ok(style.bottom >= 0 && style.bottom + style.height <= scriptCrop.viewport.height);
});

test('keyboard exit restores full preview with a persistent transform and independent layout owner', () => {
  const nodes = [];
  const visit = (node) => { if (ts.isJsxElement(node)) nodes.push(node); ts.forEachChild(node, visit); };
  visit(workspaceRoot);
  const byId = (id) => nodes.find((node) => node.openingElement.attributes.properties.some((prop) => prop.name?.text === 'testID' && prop.initializer?.text === id));
  const canvas = byId('script-preview-canvas');
  const layout = byId('editor-preview-layout');
  const viewport = byId('script-preview-viewport');
  const fitRect = evaluate(editorAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'fitRect').getText(editorAst));
  const effect = workspace.body.statements.find((node) => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression) && node.expression.expression.getText(editorAst) === 'useEffect'
    && node.getText(editorAst).includes('Animated.timing(cropOffset'));
  const x = { value: 0 }, y = { value: 0 };
  const cropOffset = {
    getTranslateTransform: () => [{ translateX: x }, { translateY: y }],
    setValue: (value) => { x.value = value.x; y.value = value.y; },
  };
  let stopped = 0;
  const Animated = { timing: (_offset, config) => ({
    start: () => cropOffset.setValue(config.toValue), stop: () => { stopped++; },
  }) };
  assert.ok(layout, 'plain View must own preview dimensions outside native Animated props');
  assert.equal(layout.openingElement.tagName.getText(editorAst), 'View');
  assert.equal(layout.parent, canvas);
  assert.equal(canvas.parent, viewport);
  for (const aspect of [9 / 16, 16 / 9]) {
    const h = mount(); h.edit(4); h.keyboard('keyboardDidShow');
    let cleanup;
    for (const [open, keyboard, workspaceHeight, height] of [
      [true, true, 240, 440], [false, true, 240, 440], [false, false, 700, 800],
      [true, true, 280, 480], [true, false, 700, 800], [false, false, 700, 800],
    ]) {
      h.update({ visible: open });
      if (!keyboard) h.keyboard('keyboardDidHide');
      const scriptCropActive = workspaceValue('scriptCropActive', { scriptEditorOpen: open, scriptKeyboardOpen: keyboard });
      const previewHeight = workspaceValue('previewHeight', { scriptEditorOpen: open, scriptKeyboardOpen: keyboard, workspaceHeight, height });
      const scriptCrop = crop(aspect, 280, previewHeight - 8, { x: 0.5, y: 0.78 });
      const size = workspaceValue('canvasSize', { scriptCropActive, scriptCrop, previewHeight, fitRect, width: 360, project: { canvas: { aspectWidth: aspect, aspectHeight: 1 } } });
      const context = { scriptCropActive, cropOffset, canvasWidth: size.width, canvasHeight: size.height, project: { canvas: { backgroundColor: '#000' } } };
      const animatedStyle = jsxProp(canvas, 'style', context);
      assert.equal(animatedStyle.transform[0].translateX, x, 'exit must not detach the native crop graph');
      assert.equal(animatedStyle.transform[1].translateY, y);
      assert.equal(animatedStyle.height, undefined);
      assert.equal(animatedStyle.width, undefined);
      cleanup?.();
      cleanup = evaluate(effect.expression.arguments[0].getText(editorAst), { cropOffset, Animated, scriptCropActive, scriptCrop })();
      const layoutStyle = jsxProp(layout, 'style', context);
      assert.equal(layoutStyle.height, size.height);
      if (!open) {
        assert.ok(previewHeight >= 280);
        assert.ok(layoutStyle.height > 180, 'normal preview must not remain a keyboard strip');
        assert.equal(x.value, 0); assert.equal(y.value, 0);
        assert.equal(h.calls.keyboards.at(-1), false, 'closing cannot depend on receiving keyboard hide');
      }
    }
    h.unmount();
  }
  assert.equal(stopped, 4, 'each keyboard crop animation stops before restoration');
});
