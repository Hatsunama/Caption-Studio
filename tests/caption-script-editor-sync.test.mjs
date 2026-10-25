import assert from 'node:assert/strict';
import { editorWorkspaceLayout } from '../src/lib/adaptive-workspace.ts';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
import * as scriptMutations from '../src/lib/caption-script.ts';
import { captionAtTimelinePosition } from '../src/lib/caption-timeline-anchor.ts';
import * as saveRecoveryHelpers from '../src/components/editor/caption-save-recovery.ts';
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
const requireModule = createRequire(import.meta.url);

const selectionEvent = (start, end = start) => ({ nativeEvent: { selection: { start, end } } });
const keyEvent = (key) => ({ nativeEvent: { key } });

// Evaluate the real workspace expressions without loading its unrelated native
// services. This covers the parent selection and the layout the sheet receives.
const editorSource = readFileSync(process.env.CAPTION_EDITOR_SOURCE
  ?? new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
const editorAst = ts.createSourceFile('editor.tsx', editorSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const workspace = editorAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'EditorWorkspace');
const workspaceShell = workspace.body.statements.find(ts.isReturnStatement).expression.expression;
let workspaceRoot = workspaceShell;
while (['PersistedHorizontalScrollScope', 'KeyboardViewport'].includes(workspaceRoot.openingElement.tagName.getText(editorAst))) {
  workspaceRoot = workspaceRoot.children.find(ts.isJsxElement);
}
function evaluate(expression, context = {}) {
  const sandbox = { result: undefined, workspaceLayout: { sideBySide: false }, previewPaneWidth: 360, insets: { left: 0, right: 0 }, ...context };
  const compiled = ts.transpileModule(`result = (${expression});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  runInNewContext(compiled.outputText, sandbox);
  return sandbox.result;
}
function workspaceValue(name, context) {
  context = { ...context, workspaceLayout: editorWorkspaceLayout({ width: context.width ?? 360, height: context.workspaceHeight ?? 800, windowHeight: context.height ?? 800, scriptEditorOpen: context.scriptEditorOpen ?? true, keyboardOpen: context.scriptKeyboardOpen ?? false }), previewPaneWidth: context.previewPaneWidth ?? context.width ?? 360 };
  const declaration = workspace.body.statements.filter(ts.isVariableStatement)
    .flatMap((node) => [...node.declarationList.declarations]).find((node) => node.name.getText(editorAst) === name
      || (ts.isObjectBindingPattern(node.name) && node.name.elements.some((element) => element.name.getText(editorAst) === name)));
  const value = evaluate(declaration.initializer.getText(editorAst), { scriptEditorOpen: true, scriptKeyboardOpen: false,
    scriptEditingCaption: undefined, scriptCropActive: false, currentMs: 0, selectedCaptionId: undefined,
    captionAtTimelinePosition, captionTimelineMsRef: { current: context.currentMs ?? 0 }, timelineCaptions: cues,
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

// Physical positions are independent of RN's last delivered cell metrics and
// the editor's own layout cache. A JS index request cannot establish alignment.
class NativeGeometry {
  cells = new Map();
  viewportHeight = 0;
  contentHeight = 0;
  offset = 0;
  pendingOffset = undefined;
  constructor(scrollRefReady = true) { this.scrollRefReady = scrollRefReady; }
  commitCell(id, index, y, height) { this.cells.set(id, { index, y, height }); }
  guideY(id) { return this.cells.get(id).y - this.offset; }
}

function mount(overrides = {}, platform = 'android', storage = {}, nativeReadiness, nativeInputs) {
  const slots = [];
  const timers = new Map();
  const keyboardListeners = new Map();
  const inputInstances = new Map(), inputProps = new Map();
  let cursor = 0, dirty = false, effects = [], tree, now = 0, timerId = 0, recover, recoveryError;
  const calls = { seeks: [], selects: [], indices: [], offsets: [], drafts: [], keyboards: [], editing: [], focuses: [], alerts: [], saves: [], nativeLayouts: 0, focusCaptures: 0 };
  // Opt in only for positioning regressions; preserve the original harness's
  // event ordering and request assertions for every existing scenario.
  // RN 0.86.3 VirtualizedList fails an unmeasured index synchronously, using
  // highestMeasuredCellIndex=0 and averageItemLength=0 before the first cell.
  // CaptionCell must forward RN's measurement before reporting to the editor.
  // https://github.com/facebook/react-native/blob/v0.86.3/packages/virtualized-lists/Lists/VirtualizedList.js
  // https://github.com/facebook/react-native/blob/v0.86.3/packages/virtualized-lists/Lists/ListMetricsAggregator.js
  const nativePosition = new NativeGeometry(nativeReadiness?.scrollRefReady ?? true);
  const listMetrics = new Map();
  calls.nativeFailures = [];
  calls.nativePositions = [];
  const nativeScrollEvents = [];
  function notifyNativeScroll(offset) {
    const onScroll = list().onScroll;
    const notify = () => onScroll?.(scrollEvent(offset));
    if (nativeReadiness?.queueScrollEvents) nativeScrollEvents.push(notify);
    else notify();
  }
  function applyNativeOffset(offset) {
    if (!nativePosition.scrollRefReady) return;
    // Android retains requests when content has zero dimensions. Once it has
    // nonzero dimensions, even a short old footer clears that pending request.
    // https://github.com/facebook/react-native/blob/v0.86.3/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/scroll/ReactScrollView.java
    nativePosition.pendingOffset = nativePosition.contentHeight > 0 ? undefined : offset;
    nativePosition.offset = Math.max(0, Math.min(offset,
      Math.max(0, nativePosition.contentHeight - nativePosition.viewportHeight)));
    calls.nativePositions.push(nativePosition.offset);
    notifyNativeScroll(nativePosition.offset);
  }
  const nativeListRef = {
    scrollToIndex(request) {
      calls.indices.push(plain(request));
      if (!nativeReadiness) return;
      const frames = [...listMetrics.values()];
      const highestMeasuredFrameIndex = Math.max(0, ...frames.map(frame => frame.index));
      if (request.index > highestMeasuredFrameIndex) {
        const failure = { index: request.index, highestMeasuredFrameIndex,
          averageItemLength: frames.length ? frames.reduce((sum, frame) => sum + frame.height, 0) / frames.length : 0 };
        calls.nativeFailures.push(failure);
        list().onScrollToIndexFailed?.(failure);
        return;
      }
      const measured = listMetrics.get(list().data[request.index]?.id);
      // getCellMetricsApprox falls back to average * index when the key's
      // stored index differs and this index is not above the highest measured.
      const average = frames.length ? frames.reduce((sum, frame) => sum + frame.height, 0) / frames.length : 0;
      const frame = measured?.index === request.index ? measured : { y: average * request.index, height: average };
      applyNativeOffset(Math.max(0, frame.y - (request.viewPosition ?? 0)
        * (nativePosition.viewportHeight - frame.height)) - (request.viewOffset ?? 0));
    },
    scrollToOffset(request) {
      calls.offsets.push(plain(request));
      if (nativeReadiness) applyNativeOffset(request.offset);
    },
  };
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
        slots[index]?.cleanup?.(); slots[index] = { deps, setup: callback, cleanup: callback() };
      });
    },
    useLayoutEffect(callback, deps) { react.useEffect(callback, deps); },
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
      if (name === '@/lib/caption-timeline-anchor') return requireModule('../src/lib/caption-timeline-anchor.ts');
      if (name === './caption-save-recovery') return saveRecoveryHelpers;
      if (name === '@/lib/ui-theme') return { chrome: { radius: { lg: 12, pill: 20 } } };
      if (name === '@/services/editor-draft-journal') return {
        readEditorDraftJournal: () => {
          calls.journalReads = (calls.journalReads ?? 0) + 1;
          return { then: (callback) => { recover = callback; return { catch: (callback) => { recoveryError = callback; } }; } };
        },
        archiveEditorDraftJournal: async () => { calls.journalArchives = (calls.journalArchives ?? 0) + 1; },
        clearEditorDraftJournal: async () => {
          calls.journalClears = (calls.journalClears ?? 0) + 1;
          if (storage.clearError) throw new Error('recovery cleanup failed');
        },
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
      if (list) {
        if (typeof list.props.ref === 'function') list.props.ref(nativeListRef);
        else list.props.ref.current = nativeListRef;
      }
      if (list) list.props.data.forEach((item, index) => {
        const input = find('TextInput', list.props.renderItem({ item, index }));
        const host = nativeInputs?.attach(item.id, input.props);
        if (nativeInputs && !host) { input.props.ref?.(null); return; }
        inputProps.set(item.id, input.props);
        let instance = inputInstances.get(item.id);
        if (!instance || instance.host !== host) {
          instance = { host, ref: { focus: () => { calls.focuses.push(item.id); host?.focus(); },
          setNativeProps: (value) => {
            (calls.placements ??= []).push({ id: item.id, ...plain(value) });
            host?.setNativeProps(value);
            if (!nativeInputs && value.selection) {
              // The legacy host delivered neither callback. Structural placement
              // now owns selection until native focus and selection acknowledge it.
              inputProps.get(item.id).onFocus();
              inputProps.get(item.id).onSelectionChange(selectionEvent(value.selection.start, value.selection.end));
            }
          } } };
          inputInstances.set(item.id, instance);
        }
        input?.props.ref?.(instance.ref);
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
      if (nativeReadiness) nativePosition.commitCell(cellProps.data[index].id, index, y, height);
      if (cellProps.CellRendererComponent) {
        const cell = cellProps.CellRendererComponent({
          item: cellProps.data[index], index, children: row(index),
          onLayout: () => {
            calls.nativeLayouts += 1;
            if (nativeReadiness) {
              const id = cellProps.data[index].id;
              const previous = listMetrics.get(id);
              // Exact RN 0.86.3 notifyCellLayout responsibility: a key's
              // index alone does not replace its metric or raise the highest
              // measured index when offset and length are unchanged.
              if (!previous || previous.y !== y || previous.height !== height) {
                listMetrics.set(id, { index, y, height });
              }
            }
          },
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
  const viewport = (height) => act(() => {
    nativePosition.viewportHeight = height;
    // RN Android onLayout calls scrollTo(currentOffset), which reclamps against
    // the new viewport and the still-committed content. JS scroll delivery is
    // independent of layout delivery; existing scenarios retain their ordering.
    if (nativeReadiness?.clampOnViewport) applyNativeOffset(nativePosition.offset);
    list().onLayout(layoutEvent(0, height));
  });
  const nativeContentSize = (height) => act(() => {
    nativePosition.contentHeight = height;
    if (nativePosition.pendingOffset !== undefined) applyNativeOffset(nativePosition.pendingOffset);
    // VirtualizedList updates its content metrics and forwards this real prop.
    // It only performs its own initial reveal for an initialScrollIndex prop.
    list().onContentSizeChange?.(360, height);
  });
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
  function replayEffects() {
    const mountedEffects = slots.filter(slot => slot?.setup);
    for (const slot of mountedEffects) slot.cleanup?.();
    for (const slot of mountedEffects) slot.cleanup = slot.setup();
  }
  render();
  if (storage.strictReplay) { replayEffects(); render(); }
  // Most scenarios begin after a successful empty-journal read. Explicitly
  // deferred scenarios below exercise the unread and failed-read boundary.
  if (!storage.deferRecovery) { recover(null); render(); }
  if (!nativeReadiness) {
    viewport(200);
    for (let index = 0; index < list().data.length; index += 1) measure(index);
    calls.indices.length = 0;
  }
  return {
    calls, props, list, row, find, act, fire, measure, viewport, advance,
    nativePosition, nativeContentSize, listMetrics,
    commitNativeCell: (index, y, height) => nativePosition.commitCell(list().data[index].id, index, y, height),
    flushNativeScrollEvents: () => act(() => {
      for (const notify of nativeScrollEvents.splice(0)) notify();
    }),
    resetNativePosition() {
      nativePosition.cells.clear();
      listMetrics.clear();
      Object.assign(nativePosition, { viewportHeight: 0, contentHeight: 0, offset: 0, pendingOffset: undefined });
    },
    replayEffects: () => act(replayEffects),
    captureRecovery: () => recover,
    captureRecoveryFailure: () => recoveryError,
    hasPendingRender: () => dirty,
    async flush() { await new Promise(setImmediate); render(); },
    keyboard: (name) => act(() => keyboardListeners.get(name)?.()),
    update: (values) => act(() => Object.assign(props, values)),
    edit: (index) => act(() => row(index).props.onPress()),
    input: (index) => find('TextInput', row(index)).props,
    hasAction: (index, label) => !!walk(row(index), (node) => node.props?.label === label),
    actionProps: (index, label) => walk(row(index), (node) => node.props?.label === label)?.props,
    action: (index, label) => act(() => walk(row(index), (node) => node.props?.label === label).props.onPress()),
    recover: (payload) => act(() => recover(payload === null ? null : {
      payload,
      baseRevision: scriptMutations.captionScriptRevision([...props.captions].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)),
    })),
    failRecovery: () => act(() => recoveryError(new Error('Read failed'))),
    restore: () => act(() => calls.alerts.at(-1)[2].find(({ text }) => text === 'Restore').onPress()),
    button: (label) => walk(tree, (node) => node.props?.accessibilityLabel === label).props,
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

test('StrictMode initial effect replay replaces the cancelled recovery read and accepts native editing', () => {
  const h = mount({}, 'android', { strictReplay: true, deferRecovery: true });
  h.recover(null);
  assert.equal(h.input(1).editable, true, 'the replayed recovery read must complete');
  h.edit(1);
  h.act(() => {
    h.input(1).onChangeText('replayed words');
    h.input(1).onSelectionChange(selectionEvent(4));
  });
  assert.equal(h.input(1).value, 'replayed words', 'the current input session must own events after replay');
  h.action(1, 'Split here');
  assert.deepEqual(plain(h.list().data.slice(1, 3).map(cue => cue.text)), ['repl', 'ayed words']);
  h.unmount();
});

for (const restored of [false, true]) test(`effect replay preserves ${restored ? 'recovered' : 'edited'} text and caret while replacing recovery ownership`, () => {
  const h = mount({}, 'android', { deferRecovery: true });
  if (restored) { h.recover(cues.map(cue => ({ ...cue, text: `restored ${cue.text}` }))); h.restore(); }
  else h.recover(null);
  h.edit(1);
  if (!restored) h.act(() => h.input(1).onChangeText('edited words'));
  h.act(() => h.input(1).onSelectionChange(selectionEvent(3)));
  const before = plain(h.list().data), placements = plain(h.calls.placements ?? []);
  const staleRecovery = h.captureRecovery();
  h.replayEffects();
  assert.deepEqual(plain(h.list().data), before, 'replay cannot initialize the draft again');
  assert.deepEqual(plain(h.calls.placements ?? []), placements, 'replay cannot reset the caret');
  const alerts = h.calls.alerts.length;
  h.act(() => staleRecovery({ payload: cues, baseRevision: 'obsolete' }));
  assert.equal(h.calls.alerts.length, alerts, 'the cancelled read must stay inactive');
  h.recover(null);
  h.action(1, 'Split here');
  assert.deepEqual(plain(h.list().data.slice(1, 3).map(cue => cue.text)), [before[1].text.slice(0, 3), before[1].text.slice(3)]);
  const input = h.input(2), publications = h.calls.drafts.length;
  h.unmount();
  const afterUnmount = h.calls.drafts.length;
  input.onChangeText('unmounted input'); input.onSubmitEditing({ nativeEvent: {} });
  assert.deepEqual(plain(h.list().data.slice(1, 3).map(cue => cue.text)), [before[1].text.slice(0, 3), before[1].text.slice(3)]);
  assert.equal(h.calls.drafts.length, afterUnmount);
  assert.ok(afterUnmount > publications, 'real unmount still clears the parent preview');
});

test('a visible project change starts its own recovery and rejects captured input and read callbacks', () => {
  const h = mount(); h.edit(1);
  h.act(() => h.input(1).onChangeText('previous project draft'));
  const stale = h.input(1), staleRecovery = h.captureRecovery();
  const captions = cues.map(cue => ({ ...cue, text: `new ${cue.text}` }));
  h.update({ projectId: 'new-project', captions });
  assert.deepEqual(plain(h.list().data), captions);
  assert.equal(h.input(1).editable, false, 'the new project waits for its recovery read');
  const alerts = h.calls.alerts.length;
  h.act(() => { stale.onChangeText('old delivery'); staleRecovery({ payload: cues, baseRevision: 'obsolete' }); });
  assert.equal(h.calls.alerts.length, alerts);
  h.recover(null); h.edit(1);
  h.act(() => h.input(1).onChangeText('new project edit'));
  assert.equal(h.input(1).value, 'new project edit');
  h.unmount();
});

test('authoritative paused time wins over stale initial identity on open, follow, recovery and reopen', () => {
  const h = mount({ initialCaptionId: 'cue-0', currentMs: 3500 });
  h.viewport(180);
  assert.equal(400 - h.calls.offsets.at(-1)?.offset, 8);
  h.update({ currentMs: 4500 });
  assert.equal(500 - h.calls.offsets.at(-1)?.offset, 8);
  const restored = cues.map(cue => ({ ...cue, text: `Recovered\n${cue.text}` }));
  h.recover(restored); h.restore();
  assert.equal(h.input(4).value, restored[4].text);
  assert.equal(500 - h.calls.offsets.at(-1)?.offset, 8);
  h.edit(2); h.act(() => h.input(2).onPressIn());
  h.act(() => h.input(2).onFocus()); h.viewport(120); h.measure(2);
  assert.deepEqual(h.calls.seeks, []);
  h.update({ visible: false }); h.update({ visible: true, currentMs: 1500 });
  h.viewport(180);
  assert.equal(h.calls.indices.at(-1)?.index, 1);
  assert.deepEqual(h.calls.seeks, []);
});

// Five blocks at an unchanged 0:10 playhead select the final cue without
// requiring input focus. Their native cell coordinates include real gaps.
const initialPositionCues = cues.slice(0, 5).map((cue, index) => ({
  ...cue, startMs: index * 2500, endMs: (index + 1) * 2500,
}));
const initialPositionY = (index) => 96 + index * 108;
const initialPositionOffset = initialPositionY(4) - 8;
const initialPositionContent = (footer) => initialPositionY(4) + 100 + footer;
function measureInitialPositionCells(h, count = 5) {
  for (let index = 0; index < count; index += 1) h.measure(index, initialPositionY(index), 100);
}
function assertInitialPosition(h) {
  assert.equal(h.props.currentMs, 10000, 'readiness must not advance the paused playhead');
  assert.deepEqual(h.calls.seeks, [], 'native positioning must never seek the timeline');
  assert.deepEqual(h.calls.selects, [], 'reveal must not invoke the parent edit-selection command');
  assert.deepEqual(h.calls.focuses, [], 'opening and native readiness must not focus an input');
  assert.equal(h.calls.editing.at(-1), undefined);
  assert.equal(h.nativePosition.offset, initialPositionOffset,
    'the final cue must actually reach the 8px guide after native readiness, not merely receive a scroll request');
  assert.equal(initialPositionY(4) - h.nativePosition.offset, 8);
}

// Source-proven cache disagreement, not a reconstruction of the cold-device
// trace: recovery can insert a preceding block while wrapping changes preserve
// the target cell's coordinates. RN keeps its old index if y/length do not
// change; CaptionCell still reports the new index to the editor. scrollToIndex
// then rejects a genuinely measured target. Test both sides of RN's predicate.
for (const targetShift of [0, 1]) {
  test(`Primary RN reindexed target with ${targetShift}px geometry change reaches the actual guide after recovery`, () => {
    const h = mount({ captions: initialPositionCues, currentMs: 10000 },
      'android', { deferRecovery: true }, {});
    try {
      h.nativeContentSize(initialPositionContent(48));
      h.viewport(300);
      for (let index = 0; index < 5; index++) {
        // RN's CellRenderer includes its trailing separator in the metric.
        h.measure(index, initialPositionY(index), index === 4 ? 100 : 108);
      }
      h.advance(400);
      assert.notEqual(h.nativePosition.guideY('cue-4'), 8, 'old footer physically clamps the initial request');

      const restored = initialPositionCues.flatMap((cue, index) => index === 3 ? [
        { ...cue, endMs: 8750 },
        { ...cue, id: 'recovered-insert', startMs: 8750, text: 'Recovered preceding block' },
      ] : [{ ...cue }]);
      h.recover(restored); h.restore();
      assert.equal(h.list().data[5].id, 'cue-4');
      const targetY = initialPositionY(4) + targetShift;
      const precedingSpan = (targetY - 96) / 5;
      // Native wrapping has already shrunk the five preceding cells. Commit
      // contiguous physical geometry independently of delayed layout delivery.
      for (let index = 0; index < 5; index++) {
        h.commitNativeCell(index, 96 + index * precedingSpan, precedingSpan);
      }
      // The target's real CellRenderer callback comes before preceding cells'
      // new callbacks, then the native footer commits. No synthetic cache poke.
      h.measure(5, targetY, 100);
      assert.equal(h.nativePosition.cells.get('cue-4').index, 5);
      assert.equal(h.listMetrics.get('cue-4').index, targetShift ? 5 : 4,
        'RN must retain its source-defined independent metric behavior');
      h.nativeContentSize(targetY + 100 + h.list().ListFooterComponent.props.style.height);
      for (let index = 0; index < 5; index++) {
        h.measure(index, 96 + index * precedingSpan, precedingSpan);
      }
      h.advance(1000);
      const settledRequests = h.calls.indices.length, settledOffsets = h.calls.offsets.length;
      h.advance(1000);
      assert.equal(h.calls.indices.length, settledRequests, 'retry budget must remain bounded');
      assert.equal(h.calls.offsets.length, settledOffsets, 'measured requests must also settle');
      assert.equal(h.props.currentMs, 10000);
      assert.deepEqual(h.calls.seeks, []);
      assert.deepEqual(h.calls.selects, []);
      assert.deepEqual(h.calls.focuses, []);
      assert.equal(h.calls.editing.at(-1), undefined);
      assert.ok(targetY - 8 <= h.nativePosition.contentHeight - h.nativePosition.viewportHeight,
        'native content has enough travel for the measured target');
      assert.equal(h.nativePosition.guideY('cue-4'), 8,
        'the physically measured target must reach the guide despite a stale RN index; requests and editor cache are insufficient');
    } finally { h.unmount(); }
  });
}

// Separate native geometry from JS event delivery. In RN 0.86.3 Android,
// ReactScrollView.onLayout replays scrollTo(currentOffset); super.scrollTo
// clamps to contentHeight - viewportHeight and clears pending offsets once
// content is nonzero. Its scroll event need not reach JS before content layout.
// https://github.com/facebook/react-native/blob/v0.86.3/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/scroll/ReactScrollView.java
// This is a layout-order regression, not a claim that the device screenshot
// establishes which native events occurred. All sizes are logical pixels.
function mountBeforePrimaryViewportExpansion() {
  const readiness = { clampOnViewport: true, queueScrollEvents: false };
  const h = mount({ captions: initialPositionCues, currentMs: 10000, initialCaptionId: 'cue-0' },
    'android', { deferRecovery: true }, readiness);
  // Commit the actual initial footer prop, not an invented content extent.
  h.nativeContentSize(initialPositionContent(h.list().ListFooterComponent.props.style.height));
  h.viewport(48);
  measureInitialPositionCells(h);
  h.advance(400);
  assertInitialPosition(h);
  readiness.queueScrollEvents = true;
  h.viewport(300);
  assert.equal(h.nativePosition.offset, initialPositionContent(48) - 300,
    'the expanded native viewport clamps against the old committed footer');
  assert.equal(h.list().ListFooterComponent.props.style.height, 292,
    'React has requested the final footer before its native commit');
  return { h, readiness };
}

for (const order of ['content before scroll', 'scroll before content', 'recovery then content before scroll']) {
  test(`Primary queued-clamp ${order} must settle the selected last cue on the guide`, () => {
    const { h, readiness } = mountBeforePrimaryViewportExpansion();
    try {
      const contentFromAttachedView = h.list().onContentSizeChange;
      const layouts = h.calls.nativeLayouts;
      if (order.startsWith('recovery')) h.recover(null);
      if (order === 'scroll before content') h.flushNativeScrollEvents();
      // Commit the current rendered footer. Keep the previously attached
      // content callback across recovery's input epoch, as native delivery can.
      h.nativePosition.contentHeight = initialPositionContent(h.list().ListFooterComponent.props.style.height);
      h.act(() => contentFromAttachedView(360, h.nativePosition.contentHeight));
      readiness.queueScrollEvents = false;
      h.flushNativeScrollEvents();
      h.advance(1000);
      assert.equal(h.calls.nativeLayouts, layouts, 'footer growth must not invent another target-cell layout');
      assert.ok(initialPositionY(4) - h.nativePosition.offset + 100 <= 300,
        'the last cue is entirely visible even in the broken state');
      assertInitialPosition(h);
    } finally { h.unmount(); }
  });
}

for (const interrupt of ['drag', 'close']) {
  test(`Primary queued-clamp ${interrupt} retains ownership across late content and scroll delivery`, () => {
    const { h, readiness } = mountBeforePrimaryViewportExpansion();
    try {
      h.recover(null);
      const staleContent = h.list().onContentSizeChange;
      if (interrupt === 'drag') {
        h.fire('onScrollBeginDrag');
        h.fire('onScrollEndDrag', h.nativePosition.offset);
        h.advance(150);
      } else h.update({ visible: false });
      const requests = h.calls.indices.length, offsets = h.calls.offsets.length;
      const seeks = [...h.calls.seeks], selects = [...h.calls.selects];
      h.nativePosition.contentHeight = initialPositionContent(292);
      h.act(() => staleContent(360, h.nativePosition.contentHeight));
      readiness.queueScrollEvents = false;
      h.flushNativeScrollEvents();
      h.advance(1000);
      assert.equal(h.calls.indices.length, requests, 'late callbacks cannot reclaim cancelled navigation');
      assert.equal(h.calls.offsets.length, offsets);
      assert.equal(h.nativePosition.offset, initialPositionContent(48) - 300);
      assert.deepEqual(h.calls.seeks, seeks);
      assert.deepEqual(h.calls.selects, selects);
      assert.deepEqual(h.calls.focuses, []);
    } finally { h.unmount(); }
  });
}

test('Primary cold footer readiness before delayed empty recovery needs no later native event', () => {
  const h = mount({ captions: initialPositionCues, currentMs: 10000 },
    'android', { deferRecovery: true }, {});
  try {
    assert.equal(h.input(4).editable, false, 'journal read is still pending');
    h.nativeContentSize(initialPositionContent(48));
    h.viewport(300); measureInitialPositionCells(h); h.advance(400);
    h.nativeContentSize(initialPositionContent(h.list().ListFooterComponent.props.style.height));
    assertInitialPosition(h);
    const layouts = h.calls.nativeLayouts;
    // Resolve the cold empty read only after the final native content event.
    // No cell, viewport, content, focus, or reopen event follows completion.
    h.recover(null); h.advance(1000);
    assert.equal(h.input(4).editable, true);
    assert.equal(h.calls.nativeLayouts, layouts);
    assertInitialPosition(h);
  } finally { h.unmount(); }
});

test('Primary content readiness from the same native view survives a completed recovery read', () => {
  const h = mount({ captions: initialPositionCues, currentMs: 10000 },
    'android', { deferRecovery: true }, {});
  try {
    h.nativeContentSize(initialPositionContent(48));
    h.viewport(300); measureInitialPositionCells(h); h.advance(400);
    const contentFromStillAttachedView = h.list().onContentSizeChange;
    assert.notEqual(h.nativePosition.offset, initialPositionOffset);
    // Reading recovery renews text-delivery ownership, but does not detach the
    // native list or invalidate its real content measurement for this session.
    h.recover(null);
    h.nativePosition.contentHeight = initialPositionContent(292);
    h.act(() => contentFromStillAttachedView?.(360, initialPositionContent(292)));
    h.advance(1000);
    assertInitialPosition(h);
  } finally { h.unmount(); }
});

test('Primary late target-cell readiness recovers after zero-metric index retries are exhausted', () => {
  const h = mount({ captions: initialPositionCues, currentMs: 10000, initialCaptionId: 'cue-0' },
    'android', { deferRecovery: true }, {});
  try {
    h.nativeContentSize(initialPositionContent(292));
    h.viewport(300);
    h.advance(400);
    assert.ok(h.calls.nativeFailures.some(({ index, averageItemLength }) => index === 4 && averageItemLength === 0));
    const attempts = h.calls.indices.length;
    h.advance(400);
    assert.equal(h.calls.indices.length, attempts, 'failed-index retries must stop while no cells are measured');
    measureInitialPositionCells(h, 4);
    assert.notEqual(h.nativePosition.offset, initialPositionOffset, 'earlier cells cannot stand in for the target measurement');
    h.measure(4, initialPositionY(4), 100);
    h.recover(null);
    h.advance(1000);
    assertInitialPosition(h);
    assert.equal(h.calls.nativeLayouts, 5, 'the real CaptionCell forwards each native layout');
  } finally { h.unmount(); }
});

for (const session of ['opening', 'restored draft', 'persistent reopen']) {
  test(`Primary ${session} re-reveals after the native footer grows at unchanged time and cell positions`, () => {
    const h = mount({ captions: initialPositionCues, currentMs: 10000, initialCaptionId: 'cue-0' },
      'android', { deferRecovery: true }, {});
    try {
      if (session === 'persistent reopen') {
        h.recover(null);
        h.nativeContentSize(initialPositionContent(292)); h.viewport(300);
        measureInitialPositionCells(h);
        assertInitialPosition(h);
        h.update({ visible: false }); h.resetNativePosition();
        h.update({ visible: true });
      }
      if (session === 'restored draft') {
        const restored = initialPositionCues.map(cue => ({ ...cue, text: `Recovered ${cue.text}` }));
        h.recover(restored); h.restore();
        assert.equal(h.input(4).value, restored[4].text);
      } else h.recover(null);

      // The first committed footer is 48px (viewport state starts at zero).
      // Native rows can already exist while their JS measurement events wait.
      // onLayout publishes the 300px viewport and React requests a 292px footer;
      // its native content layout is a later event, with unchanged cell frames.
      h.nativeContentSize(initialPositionContent(48));
      h.viewport(300); h.advance(400);
      measureInitialPositionCells(h);
      h.advance(400);
      assert.equal(h.calls.indices.at(-1)?.index, 4, 'the requested target is already correct');
      assert.equal(h.nativePosition.offset, initialPositionContent(48) - 300,
        'native scrolling clamps to the old nonzero content extent');
      assert.notEqual(h.nativePosition.offset, initialPositionOffset);
      const layouts = h.calls.nativeLayouts;
      h.nativeContentSize(initialPositionContent(292));
      h.advance(1000);
      assert.equal(h.calls.nativeLayouts, layouts, 'footer readiness does not manufacture another cell layout');
      assertInitialPosition(h);
    } finally { h.unmount(); }
  });
}

for (const interrupt of ['drag', 'close', 'unmount']) {
  test(`Primary ${interrupt} cancels zero-metric retries before late native readiness`, () => {
    const h = mount({ captions: initialPositionCues, currentMs: 10000 },
      'android', { deferRecovery: true }, {});
    let unmounted = false;
    try {
      h.recover(null);
      h.nativeContentSize(initialPositionContent(48)); h.viewport(300);
      assert.ok(h.calls.nativeFailures.length > 0, 'the actual ref must deliver the failed-index callback');
      const staleContentSize = h.list().onContentSizeChange;
      if (interrupt === 'drag') {
        h.fire('onScrollBeginDrag'); h.fire('onScrollEndDrag', 0); h.advance(150);
      }
      if (interrupt === 'close') h.update({ visible: false });
      if (interrupt === 'unmount') { h.unmount(); unmounted = true; }
      const requests = h.calls.indices.length, offsets = h.calls.offsets.length, seeks = [...h.calls.seeks];
      if (interrupt === 'drag') {
        measureInitialPositionCells(h);
        h.nativeContentSize(initialPositionContent(292));
      } else {
        // A queued native event may retain the old callback after detachment.
        // Do not render a detached component merely to deliver that event.
        staleContentSize?.(360, initialPositionContent(292));
      }
      h.advance(1000);
      assert.equal(h.calls.indices.length, requests, 'late readiness cannot restart cancelled navigation');
      assert.equal(h.calls.offsets.length, offsets);
      assert.deepEqual(h.calls.seeks, seeks, 'late readiness cannot create another timeline seek');
      assert.deepEqual(h.calls.focuses, []);
    } finally { if (!unmounted) h.unmount(); }
  });
}

test('native submit uses latest controlled text and caret once; literal and pasted line breaks remain text', () => {
  const h = mount(); h.edit(1);
  assert.equal(h.input(1).submitBehavior, 'submit');
  assert.equal(typeof h.input(1).onSubmitEditing, 'function');
  const input = h.input(1);
  h.act(() => {
    input.onChangeText('helloworld');
    input.onSelectionChange(selectionEvent(2));
    input.onKeyPress?.(keyEvent('Enter'));
    input.onSubmitEditing({ nativeEvent: { text: 'stale native text' } });
  });
  assert.deepEqual(plain(h.list().data.slice(1, 3).map(cue => cue.text)), ['he', 'lloworld']);
  const id = h.list().data[2].id;
  assert.deepEqual(h.calls.placements, [{ id, selection: { start: 0, end: 0 } }]);
  assert.equal(h.input(2).selection, undefined);
  h.act(() => h.input(2).onSelectionChange(selectionEvent(2)));
  h.act(() => h.input(2).onChangeText('ll\n\noworld\r\n'));
  h.viewport(120); h.measure(2); h.update({ currentMs: 1700 });
  assert.equal(h.list().data.length, 7);
  assert.equal(h.input(2).value, 'll\n\noworld\r\n');
  assert.equal(h.calls.placements.length, 1, 'ordinary renders must not reset the native caret');
  assert.deepEqual(h.calls.seeks, []);
});

// Persistent native input state, independent of the component's selection cache.
// Every imperative selection is applied, and its actual callback is delivered.
// Only the newly focused input receives a default end-selection initialization;
// repeated focus requests do not manufacture further initialization events.
// These schedules are hypotheses for the proven native end-caret observation,
// not a trace of Gboard/RN ordering. No product helper or callback is replaced.
function androidSplitInputs(initialization, eventOrder = 'focus then selection') {
  const inputs = new Map(), pending = [];
  let focusedId;
  function select(input, selection) {
    input.selection = plain(selection);
    input.props.onSelectionChange(selectionEvent(selection.start, selection.end));
  }
  return {
    inputs,
    blockNew: false,
    get focusedId() { return focusedId; },
    attach(id, props) {
      let input = inputs.get(id);
      if (!input && this.blockNew) return null;
      if (!input) {
        input = { selection: { start: props.value.length, end: props.value.length } };
        inputs.set(id, input);
      }
      input.props = props;
      // Honor a future narrowly controlled selection as well as imperative
      // commands; ordinary uncontrolled rerenders leave the native caret alone.
      if (props.selection) input.selection = plain(props.selection);
      return input.host ??= {
        focus() {
          if (focusedId === id) return;
          focusedId = id;
          const end = input.props.value.length;
          const complete = () => {
            const initial = input.props.selection ?? { start: end, end };
            if (eventOrder === 'selection then focus') select(input, initial);
            input.props.onFocus();
            if (eventOrder === 'focus then selection') select(input, initial);
          };
          if (initialization === 'before placement') complete();
          else pending.push(complete);
        },
        setNativeProps(value) { if (value.selection) select(input, value.selection); },
      };
    },
    completeFocus() { for (const complete of pending.splice(0)) complete(); },
    detach(id) { inputs.delete(id); if (focusedId === id) focusedId = undefined; },
    moveCaret(id, offset) { select(inputs.get(id), { start: offset, end: offset }); },
    type(id, text) {
      const input = inputs.get(id), { start, end } = input.selection;
      input.props.onChangeText(input.props.value.slice(0, start) + text + input.props.value.slice(end));
      select(input, { start: start + text.length, end: start + text.length });
    },
  };
}

function mountAndroidMiddleWordSplit(initialization, eventOrder, complete = true) {
  const nativeInputs = androidSplitInputs(initialization, eventOrder);
  const h = mount({ captions: [{ ...cues[0], text: 'Hello 👩🏽‍💻✨' }, ...cues.slice(1, 5)] },
    'android', {}, undefined, nativeInputs);
  h.edit(0);
  h.act(() => nativeInputs.completeFocus());
  h.act(() => nativeInputs.moveCaret('cue-0', 2));
  h.act(() => h.input(0).onSubmitEditing({ nativeEvent: { text: 'Hello 👩🏽‍💻✨' } }));
  const rightId = h.list().data[1].id;
  assert.equal(h.list().data.length, 6);
  assert.equal(h.input(0).value, 'He');
  assert.equal(h.input(1).value, 'llo 👩🏽‍💻✨');
  assert.equal(h.input(1).value.length, 12, 'native offsets use UTF-16, including the complete emoji');
  assert.equal(nativeInputs.focusedId, rightId);
  // A controlled placement can complete during synchronous focus, making the
  // old imperative-command precondition redundant. Assert actual native state.
  assert.deepEqual(nativeInputs.inputs.get(rightId).selection, { start: 0, end: 0 },
    'the host must actually honor that command before delivering initialization');
  if (complete) h.act(() => nativeInputs.completeFocus());
  assert.equal(h.calls.editing.at(-1), rightId);
  assert.equal(h.input(1).editable, true);
  assert.deepEqual(h.calls.saves, [], 'no Save participates in the reproduction');
  assert.deepEqual(h.calls.seeks, []);
  return { h, nativeInputs, rightId };
}

for (const order of ['focus then selection', 'selection then focus']) {
  test(`Android split caret survives new-input end initialization after placement: ${order}`, () => {
    const { h, nativeInputs, rightId } = mountAndroidMiddleWordSplit('after placement', order);
    try {
      // Independent native-state assertion, before Backspace, Save or typing.
      assert.deepEqual(nativeInputs.inputs.get(rightId).selection, { start: 0, end: 0 },
        'the focused right tail must settle at its start after native initialization');
    } finally { h.unmount(); }
  });
}

test('Android split caret cache preserves immediate Backspace-at-start Join after late initialization', () => {
  const { h } = mountAndroidMiddleWordSplit('after placement', 'focus then selection');
  try {
    // Do not inject another selection(0): that would hide the ownership bug.
    // The real key callback reads selectionRef, independently of native state.
    h.act(() => h.input(1).onKeyPress(keyEvent('Backspace')));
    assert.equal(h.list().data.length, 5, 'Backspace must join the newly split right tail at its initial caret');
    assert.equal(h.input(0).value, 'He llo 👩🏽‍💻✨');
    assert.deepEqual(h.calls.saves, []);
  } finally { h.unmount(); }
});

test('Android split caret initialization before placement honors subsequent user caret and IME text', () => {
  const { h, nativeInputs, rightId } = mountAndroidMiddleWordSplit('before placement');
  try {
    assert.deepEqual(nativeInputs.inputs.get(rightId).selection, { start: 0, end: 0 });
    h.act(() => nativeInputs.type(rightId, 'X'));
    assert.equal(h.input(1).value, 'Xllo 👩🏽‍💻✨');
    h.act(() => nativeInputs.moveCaret(rightId, h.input(1).value.length));
    h.act(() => nativeInputs.type(rightId, '!'));
    h.viewport(120); h.measure(1); h.update({ currentMs: 500 }); h.advance(1000);
    assert.equal(h.input(1).value, 'Xllo 👩🏽‍💻✨!');
    assert.deepEqual(nativeInputs.inputs.get(rightId).selection, { start: 14, end: 14 },
      'completed structural placement cannot keep pinning real user typing to zero');
    h.act(() => h.input(1).onKeyPress(keyEvent('Backspace')));
    assert.equal(h.list().data.length, 6, 'a user-moved end caret must retain ordinary native Backspace');
    assert.deepEqual(h.calls.saves, []);
  } finally { h.unmount(); }
});

for (const order of ['focus then selection', 'selection then focus']) {
  test(`structural selection handoff releases for hardware/accessibility selection after ${order}`, () => {
    const { h, nativeInputs, rightId } = mountAndroidMiddleWordSplit('after placement', order);
    try {
      assert.equal(h.input(1).selection, undefined, 'native acknowledgment releases controlled selection immediately');
      h.act(() => nativeInputs.moveCaret(rightId, 4));
      h.viewport(100); h.measure(1); h.replayEffects();
      assert.deepEqual(nativeInputs.inputs.get(rightId).selection, { start: 4, end: 4 });
      h.act(() => h.input(1).onKeyPress(keyEvent('Backspace')));
      assert.equal(h.list().data.length, 6);
      h.act(() => nativeInputs.type(rightId, 'X'));
      assert.equal(h.input(1).value, 'llo X👩🏽‍💻✨');
    } finally { h.unmount(); }
  });
}

test('structural selection is a committed render snapshot until the release commits', () => {
  const { h } = mountAndroidMiddleWordSplit('after placement', 'focus then selection', false);
  try {
    const committed = h.list(), item = committed.data[1];
    const committedInput = () => h.find('TextInput', committed.renderItem({ item, index: 1 })).props;
    assert.deepEqual(plain(committedInput().selection), { start: 0, end: 0 });
    // Deliver real intent without flushing queued React state. VirtualizedList
    // may still invoke the committed renderItem during this interval.
    committedInput().onPressIn();
    assert.equal(h.hasPendingRender(), true);
    assert.deepEqual(plain(committedInput().selection ?? null), { start: 0, end: 0 },
      'releasing imperative ownership cannot mutate an existing render snapshot');
    h.act(() => {});
    assert.equal(h.input(1).selection, undefined, 'the next commit releases control');
    assert.deepEqual(plain(committedInput().selection), { start: 0, end: 0 },
      'even a retained old render callback keeps its immutable projection');
  } finally { h.unmount(); }
});

test('effect replay releases a pending structural projection and keeps renewed input editable', () => {
  const { h, nativeInputs, rightId } = mountAndroidMiddleWordSplit('after placement', 'focus then selection', false);
  try {
    assert.deepEqual(plain(h.input(1).selection), { start: 0, end: 0 });
    h.replayEffects();
    assert.equal(h.input(1).selection, undefined, 'replay cleanup must release React control with its imperative owner');
    h.recover(null);
    h.act(() => nativeInputs.completeFocus());
    h.act(() => nativeInputs.moveCaret(rightId, 4));
    h.act(() => nativeInputs.type(rightId, 'IME'));
    assert.equal(h.input(1).value, 'llo IME👩🏽‍💻✨');
    assert.equal(h.input(1).selection, undefined);
    assert.equal(h.input(1).editable, true);
  } finally { h.unmount(); }
});

for (const outcome of ['empty', 'failed', 'undecodable']) {
  test(`pending structural projection releases on ${outcome} recovery epoch renewal`, () => {
    const { h } = mountAndroidMiddleWordSplit('after placement', 'focus then selection', false);
    try {
      const stale = h.input(1);
      assert.deepEqual(plain(stale.selection), { start: 0, end: 0 });
      if (outcome === 'failed') h.failRecovery();
      else h.recover(outcome === 'empty' ? null : [{ ...cues[0], wordIds: 'invalid' }]);
      assert.equal(h.input(1).selection, undefined);
      h.act(() => {
        stale.onFocus(); stale.onSelectionChange(selectionEvent(0));
        stale.onKeyPress(keyEvent('Backspace')); stale.onChangeText('obsolete text');
      });
      assert.equal(h.input(1).value, 'llo 👩🏽‍💻✨');
      assert.equal(h.list().data.length, 6);
      h.act(() => h.input(1).onChangeText('current IME text'));
      assert.equal(h.input(1).value, 'current IME text', 'renewal preserves current native text delivery');
      h.recover(null);
      assert.equal(h.input(1).editable, true);
      assert.equal(h.input(1).selection, undefined, 'restored editability cannot resurrect the projection');
      assert.equal(h.input(1).value, 'current IME text');
    } finally { h.unmount(); }
  });
}

for (const intent of ['press', 'key', 'text', 'drag', 'blur']) {
  test(`pending structural selection yields promptly to ${intent} before focus acknowledgment`, () => {
    const { h, nativeInputs, rightId } = mountAndroidMiddleWordSplit('after placement', 'focus then selection', false);
    try {
      assert.deepEqual(plain(h.input(1).selection), { start: 0, end: 0 });
      if (intent === 'press') h.act(() => h.input(1).onPressIn());
      if (intent === 'key') h.act(() => h.input(1).onKeyPress(keyEvent('ArrowRight')));
      if (intent === 'text') h.act(() => nativeInputs.type(rightId, 'X'));
      if (intent === 'drag') h.fire('onScrollBeginDrag');
      if (intent === 'blur') h.act(() => h.input(1).onBlur());
      assert.equal(h.input(1).selection, undefined);
      h.act(() => nativeInputs.moveCaret(rightId, 3));
      h.viewport(130); h.measure(1); h.update({ currentMs: 250 });
      assert.deepEqual(nativeInputs.inputs.get(rightId).selection, { start: 3, end: 3 });
      h.act(() => h.input(1).onKeyPress(keyEvent('Backspace')));
      assert.equal(h.list().data.length, 6);
      assert.equal(h.input(1).value, intent === 'text' ? 'Xllo 👩🏽‍💻✨' : 'llo 👩🏽‍💻✨');
    } finally { h.unmount(); }
  });
}

test('structural focus waits for a virtualized input ref and then settles its actual native selection', () => {
  const nativeInputs = androidSplitInputs('after placement', 'selection then focus');
  const h = mount({ captions: [{ ...cues[0], text: 'Hello 👩🏽‍💻✨' }, ...cues.slice(1, 5)] },
    'android', {}, undefined, nativeInputs);
  try {
    h.edit(0); h.act(() => nativeInputs.completeFocus());
    h.act(() => nativeInputs.moveCaret('cue-0', 2));
    nativeInputs.blockNew = true;
    h.act(() => h.input(0).onSubmitEditing({ nativeEvent: {} }));
    const rightId = h.list().data[1].id;
    assert.equal(nativeInputs.inputs.has(rightId), false);
    assert.equal(nativeInputs.focusedId, 'cue-0');
    nativeInputs.blockNew = false;
    h.measure(1);
    h.act(() => nativeInputs.completeFocus());
    assert.equal(nativeInputs.focusedId, rightId);
    assert.deepEqual(nativeInputs.inputs.get(rightId).selection, { start: 0, end: 0 });
    assert.equal(h.input(1).selection, undefined);
    h.act(() => h.input(1).onKeyPress(keyEvent('Backspace')));
    assert.equal(h.list().data.length, 5);
    assert.equal(h.input(0).value, 'He llo 👩🏽‍💻✨');
  } finally { h.unmount(); }
});

test('Join next places the seam on an already focused input and releases ordinary selection', () => {
  const nativeInputs = androidSplitInputs('before placement');
  const h = mount({}, 'android', {}, undefined, nativeInputs);
  try {
    h.edit(0); h.action(0, 'Join next');
    assert.equal(h.list().data.length, 5);
    assert.equal(h.input(0).value, 'caption 0 caption 1');
    assert.deepEqual(nativeInputs.inputs.get('cue-0').selection, { start: 10, end: 10 });
    assert.equal(h.input(0).selection, undefined);
    h.act(() => nativeInputs.moveCaret('cue-0', 3));
    h.act(() => nativeInputs.type('cue-0', 'X'));
    assert.equal(h.input(0).value, 'capXtion 0 caption 1');
  } finally { h.unmount(); }
});

test('a pending structural selection reattaches to a replacement native input without losing text', () => {
  const { h, nativeInputs, rightId } = mountAndroidMiddleWordSplit('after placement', 'selection then focus', false);
  try {
    h.act(() => h.input(1).onFocus());
    assert.deepEqual(plain(h.input(1).selection), { start: 0, end: 0 }, 'focus alone cannot acknowledge placement');
    h.input(1).ref(null);
    nativeInputs.detach(rightId);
    h.viewport(120);
    assert.equal(nativeInputs.focusedId, rightId, 'replacement ref must receive focus without a draft mutation');
    h.act(() => nativeInputs.completeFocus());
    assert.deepEqual(nativeInputs.inputs.get(rightId).selection, { start: 0, end: 0 });
    assert.equal(h.input(1).selection, undefined);
    assert.equal(h.input(1).value, 'llo 👩🏽‍💻✨');
    h.act(() => nativeInputs.type(rightId, 'X'));
    assert.equal(h.input(1).value, 'Xllo 👩🏽‍💻✨');
  } finally { h.unmount(); }
});

test('saving during structural handoff preserves queued composition text and releases selection', async () => {
  const { h } = mountAndroidMiddleWordSplit('after placement', 'focus then selection', false);
  let finish;
  try {
    h.update({ onSave: () => new Promise(resolve => { finish = resolve; }) });
    const queued = h.input(1);
    h.act(() => h.button('Save all caption edits').onPress());
    assert.equal(h.input(1).selection, undefined);
    h.act(() => queued.onChangeText('IME llo 👩🏽‍💻✨'));
    finish(false); await h.flush();
    assert.equal(h.input(1).value, 'IME llo 👩🏽‍💻✨');
    assert.equal(h.list().data.length, 6);
    assert.equal(h.input(1).selection, undefined);
    assert.equal(h.button('Save all caption edits').disabled, false);
  } finally { h.unmount(); }
});

for (const boundary of ['close/reopen', 'project', 'unmount']) {
  test(`pending structural selection cannot cross ${boundary} or accept its stale callbacks`, () => {
    const { h, nativeInputs } = mountAndroidMiddleWordSplit('after placement', 'focus then selection', false);
    const stale = h.input(1);
    try {
      if (boundary === 'unmount') h.unmount();
      else if (boundary === 'project') h.update({ projectId: 'another-project' });
      else { h.update({ visible: false }); h.update({ visible: true }); }
      if (boundary !== 'unmount') h.recover(null);
      const before = plain(h.list().data), focuses = h.calls.focuses.length;
      stale.onFocus(); stale.onSelectionChange(selectionEvent(12)); stale.onBlur();
      stale.onChangeText('stale'); stale.onKeyPress(keyEvent('Backspace'));
      if (boundary !== 'unmount') {
        h.viewport(120);
        assert.equal(h.input(0).selection, undefined);
      }
      assert.deepEqual(plain(h.list().data), before);
      assert.equal(h.calls.focuses.length, focuses);
      assert.deepEqual(h.calls.saves, []);
    } finally { if (boundary !== 'unmount') h.unmount(); }
  });
}

test('Backspace at collapsed zero joins at the normalized seam and preserves paired translation provenance', () => {
  const primary = { ...cues[0], text: '  left \n  side  ', mergeProvenance: {
    fragments: [{ captionId: 'original-left', primaryText: 'left side', translations: { spanish: 'izquierda' } }],
  } };
  const h = mount({ captions: [primary, { ...cues[1], text: ' right  side ' }, cues[2]] });
  h.edit(1); h.act(() => h.input(1).onSelectionChange(selectionEvent(0)));
  h.act(() => h.input(1).onKeyPress?.(keyEvent('Backspace')));
  assert.equal(h.list().data.length, 2);
  assert.equal(h.input(0).value, 'left side right side');
  assert.deepEqual(h.calls.placements, [{ id: primary.id, selection: { start: 10, end: 10 } }]);
  assert.equal(h.list().data[0].mergeProvenance.fragments[0].translations.spanish, 'izquierda');
  assert.equal(h.list().data[0].mergeProvenance.fragments[1].captionId, cues[1].id);
  h.act(() => h.input(0).onSelectionChange(selectionEvent(4)));
  h.action(0, 'Split here');
  assert.equal(h.list().data[0].mergeProvenance.aliasesRetired, true);
  assert.equal(h.list().data[1].mergeProvenance, undefined);
  assert.deepEqual(h.calls.seeks, []);
});

test('selected-range Backspace, ordinary Backspace and first-cue zero retain native editing', () => {
  const h = mount();
  for (const [index, start, end] of [[1, 0, 2], [1, 2, 2], [0, 0, 0]]) {
    h.edit(index); h.act(() => h.input(index).onSelectionChange(selectionEvent(start, end)));
    const before = plain(h.list().data);
    h.act(() => h.input(index).onKeyPress?.(keyEvent('Backspace')));
    assert.deepEqual(plain(h.list().data), before);
  }
  assert.equal(h.calls.placements, undefined);
});

test('native Enter preserves complete graphemes at interior UTF-16 caret positions', () => {
  for (const cluster of ['e\u0301', '\u{1F469}\u{1F3FD}\u200D\u{1F4BB}', '\u{1F1FA}\u{1F1F8}',
    '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}']) {
    const original = { ...cues[0], text: `a${cluster}z` };
    const h = mount({ captions: [original] }); h.edit(0);
    h.act(() => h.input(0).onSelectionChange(selectionEvent(cluster.includes('\u{E0067}') ? 5 : 2)));
    h.act(() => h.input(0).onSubmitEditing({ nativeEvent: { text: original.text } }));
    assert.equal(h.list().data.length, 2);
    assert.equal(h.list().data.map(cue => cue.text).join(''), original.text);
    assert.ok(h.list().data.some(cue => cue.text.includes(cluster)));
    assert.deepEqual(h.calls.placements.at(-1).selection, { start: 0, end: 0 });
  }
});

test('failed Enter preserves tiny cues, selected ranges and edge text without inventing durations', () => {
  for (const [duration, start, end] of [[159, 2, 2], [1000, 0, 0], [1000, 5, 5], [1000, 1, 3]]) {
    const caption = { ...cues[0], text: 'hello', endMs: duration };
    const h = mount({ captions: [caption] }); h.edit(0);
    h.act(() => h.input(0).onSelectionChange(selectionEvent(start, end)));
    h.act(() => h.input(0).onSubmitEditing?.({ nativeEvent: { text: 'hello' } }));
    assert.deepEqual(plain(h.list().data), [caption]);
    assert.equal(h.calls.placements, undefined);
    assert.deepEqual(h.calls.seeks, []);
  }
});

for (const state of ['unread', 'failed', 'saving', 'closing']) test(`${state} guard preserves owned transient delivery and blocks structural handlers`, async () => {
  let finish;
  let actions = [];
  const h = mount({ onSave: () => new Promise(resolve => { finish = resolve; }) }, 'android', { deferRecovery: true });
  if (state === 'failed') h.failRecovery();
  if (state === 'saving' || state === 'closing') {
    h.recover(null); h.edit(1);
    actions = ['Split here', 'Join previous', 'Join next'].map(label => h.actionProps(1, label));
    if (state === 'saving') h.act(() => h.button('Save all caption edits').onPress());
    else h.act(() => h.button('Cancel caption edits').onPress());
  }
  const before = plain(h.list().data), focuses = h.calls.focuses.length;
  h.act(() => {
    const input = h.input(1);
    input.onSelectionChange(selectionEvent(0)); input.onFocus(); input.onPressIn();
    input.onChangeText('blocked'); input.onSubmitEditing?.({ nativeEvent: { text: 'blocked' } });
    input.onKeyPress?.(keyEvent('Backspace'));
    h.row(1).props.onPress();
    for (const action of actions) action.onPress();
  });
  assert.deepEqual(plain(h.list().data), state !== 'closing'
    ? before.map((cue, index) => index === 1 ? { ...cue, text: 'blocked', textMode: 'manual' } : cue)
    : before);
  assert.equal(h.calls.focuses.length, focuses);
  assert.equal(h.input(1).editable, false);
  assert.deepEqual(h.calls.seeks, []);
  h.advance(1000); await h.flush();
  assert.equal(h.calls.journals, undefined);
  assert.equal(h.calls.journalClears, state === 'closing' ? 1 : undefined);
  finish?.(false); await h.flush(); h.unmount();
});

for (const state of ['unread', 'failed', 'undecodable']) for (const text of ['Current typing', '   ', '']) {
  test(`${state} transient ${JSON.stringify(text)} survives Keep editing without touching recovery`, async () => {
    let closes = 0;
    const h = mount({ onCancel: () => { closes++; } }, 'android', { deferRecovery: true });
    if (state === 'failed') h.failRecovery();
    if (state === 'undecodable') h.recover([{ ...cues[0], wordIds: 'invalid' }]);
    h.act(() => h.input(1).onChangeText(text));
    assert.equal(h.input(1).value, text);
    assert.equal(h.input(1).editable, false);
    assert.equal(h.button('Save all caption edits').disabled, true);
    h.act(() => h.button('Cancel caption edits').onPress());
    assert.equal(closes, 0);
    assert.match(h.calls.alerts.at(-1)[1], /preserved/);
    h.act(() => h.calls.alerts.at(-1)[2].find(choice => choice.text === 'Keep editing').onPress?.());
    assert.equal(h.input(1).value, text);
    h.advance(2000); await h.flush();
    assert.equal(h.calls.journals, undefined);
    assert.equal(h.calls.journalClears, undefined);
    h.act(() => h.button('Cancel caption edits').onPress());
    h.act(() => h.calls.alerts.at(-1)[2].find(choice => choice.text === 'Discard').onPress());
    await h.flush();
    assert.equal(closes, 1);
    assert.equal(h.calls.journalClears, undefined);
    h.unmount();
  });
}

for (const outcome of ['empty', 'failed', 'undecodable']) test(`${outcome} recovery outcome renews callback ownership even with unchanged status`, () => {
  const h = mount({}, 'android', { deferRecovery: true });
  const complete = () => outcome === 'failed' ? h.captureRecoveryFailure()(new Error('Read failed'))
    : h.captureRecovery()(outcome === 'empty' ? null : { payload: [{ ...cues[0], wordIds: 'invalid' }] });
  h.act(complete);
  h.act(() => h.input(1).onChangeText('owned before outcome'));
  const stale = h.input(1);
  complete();
  assert.equal(h.hasPendingRender(), true, 'a completed outcome must publish its new input epoch');
  h.act(() => {});
  h.act(() => stale.onChangeText('obsolete phase'));
  assert.equal(h.input(1).value, 'owned before outcome');
  h.act(() => h.input(1).onChangeText('current phase'));
  assert.equal(h.input(1).value, 'current phase');
  assert.equal(h.calls.journalReads, 1, 'publishing an input epoch cannot start another recovery read');
  h.unmount();
});

test('join failure preserves original cues and caret without publishing a partial mutation', () => {
  const bad = cues.slice(0, 2).map(cue => ({ ...cue, mergeProvenance: {
    fragments: [{ captionId: 'duplicate', primaryText: cue.text, translations: {} }],
  } }));
  const h = mount({ captions: bad }); h.edit(1);
  h.act(() => h.input(1).onSelectionChange(selectionEvent(0)));
  h.act(() => h.input(1).onKeyPress?.(keyEvent('Backspace')));
  assert.deepEqual(plain(h.list().data), bad);
  assert.equal(h.calls.placements, undefined);
  assert.match(h.list().ListHeaderComponent.props.children[1]?.props.children ?? '', /Originals were preserved/);
});

for (const edited of [false, true]) test(`retapping a natively focused input after keyboard dismissal restores joins without losing ${edited ? 'edited' : 'source'} text or caret`, async () => {
  let closes = 0;
  const h = mount({ onSave: async (captions) => { h.calls.saves.push(plain(captions)); return true; }, onCancel: () => { closes++; } });
  h.recover(null);
  h.act(() => h.input(2).onFocus());
  h.keyboard('keyboardDidShow');
  if (edited) h.act(() => h.input(2).onChangeText('Hello again'));
  const before = plain(h.list().data);
  h.act(() => h.input(2).onSelectionChange({ nativeEvent: { selection: { start: 2, end: 2 } } }));
  assert.equal(h.hasAction(2, 'Join previous'), true);
  assert.equal(h.hasAction(2, 'Join next'), true);
  h.keyboard('keyboardDidHide');
  assert.equal(h.hasAction(2, 'Join next'), false, 'keyboard dismissal still collapses the row');
  assert.equal(h.calls.selects.at(-1), 'cue-2');
  h.calls.focuses.length = 0;
  h.update({ currentMs: 2100 }); h.viewport(200); h.measure(2);
  assert.deepEqual(h.calls.focuses, [], 'layout and transport updates cannot reopen the keyboard');

  // Android retains native focus: deliver only the input press, never a second
  // onFocus or the outer card onPress (the timestamp workaround).
  h.act(() => h.input(2).onPressIn());
  h.keyboard('keyboardDidShow');
  assert.equal(h.hasAction(2, 'Join previous'), true, 'input retap must reactivate Join previous');
  assert.equal(h.hasAction(2, 'Join next'), true, 'input retap must reactivate Join next');
  assert.equal(h.calls.editing.at(-1), 'cue-2');
  assert.equal(h.calls.selects.at(-1), 'cue-2');
  assert.ok(h.calls.focuses.every((id) => id === 'cue-2'), 'activation cannot bounce focus to another cue');
  assert.deepEqual(plain(h.list().data), before, 'reactivation preserves every draft cue');
  assert.equal(h.input(2).selection, undefined, 'reactivation must not force the native caret');

  h.calls.focuses.length = 0; h.calls.indices.length = 0; h.calls.offsets.length = 0;
  h.fire('onScrollBeginDrag'); h.fire('onScroll', 392); h.fire('onScrollEndDrag', 392);
  h.advance(150); h.measure(2); h.viewport(120); h.update({ currentMs: 3100 });
  assert.equal(h.hasAction(2, 'Join next'), true, 'dragging with the IME open retains the editing controls');
  assert.deepEqual(h.calls.focuses, [], 'scroll and resize cannot refocus the input');
  assert.deepEqual(h.calls.indices, [], 'late layouts cannot bounce a user-owned scroll');
  assert.deepEqual(h.calls.offsets, [], 'late measured layouts cannot bounce a user-owned scroll');
  assert.deepEqual(h.calls.saves, [], 'focus and keyboard transitions never save');

  h.action(2, 'Split here');
  assert.equal(h.list().data[2].text, before[2].text.slice(0, 2), 'split uses the caret retained across dismissal and retap');
  assert.equal(h.list().data[3].text, before[2].text.slice(2));
  h.act(() => h.button('Save all caption edits').onPress());
  await h.flush();
  assert.equal(h.calls.saves.length, 1, 'one explicit Done produces one save');
  assert.equal(closes, 1);
  h.unmount();
});

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
  assert.equal(400 - h.calls.offsets.at(-1)?.offset, 8);
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
  h.calls.offsets.length = 0;
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
  assert.deepEqual(h.calls.offsets, [], 'parent updates must not recenter a measured user scroll');
});

test('tapping during momentum hands navigation to the focused input before keyboard resize', () => {
  const h = mount();
  h.fire('onScrollBeginDrag'); h.fire('onScrollEndDrag', 292); h.fire('onMomentumScrollBegin');
  h.edit(4);
  h.calls.seeks.length = 0; h.calls.selects.length = 0; h.calls.indices.length = 0;
  h.keyboard('keyboardDidShow'); h.viewport(120); h.measure(4, 500, 200);
  h.fire('onScroll', 592); h.fire('onMomentumScrollEnd', 592); h.advance(200);
  assert.equal(h.input(4).value, 'caption 4');
  assert.equal(500 - h.calls.offsets.at(-1)?.offset, 8);
  assert.deepEqual(h.calls.seeks, []); assert.deepEqual(h.calls.selects, []);
});

test('selecting an offscreen caption preserves transport and keeps its input visible during playback', () => {
  const h = mount(); h.edit(4);
  assert.deepEqual(h.calls.selects, ['cue-4']); assert.deepEqual(h.calls.seeks, []);
  assert.equal(500 - h.calls.offsets.at(-1)?.offset, 8);
  h.calls.indices.length = 0; h.calls.offsets.length = 0;
  h.update({ isPlaying: true, currentMs: 1100 }); h.update({ currentMs: 2100 });
  assert.ok(h.calls.indices.every(({ index }) => index === 4));
  assert.ok(h.calls.offsets.every(({ offset }) => 500 - offset === 8));
  assert.equal(h.input(4).value, 'caption 4');
});

test('keyboard resize and growing input reveal the focused cue without seeking', () => {
  const h = mount(); h.edit(3); h.fire('onScroll', 350);
  h.calls.indices.length = 0; h.calls.seeks.length = 0;
  h.viewport(120); h.measure(3, 400, 180);
  h.act(() => h.input(3).onContentSizeChange(contentSizeEvent(230)));
  assert.equal(400 - h.calls.offsets.at(-1)?.offset, 8);
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
    assert.equal(120 - h.calls.offsets.at(-1)?.offset, 8);
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
  const h = mount({ captions: [original, cues[1]] }); h.recover(null); h.edit(0);
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
  h.recover(null);
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

for (const [initialText, latestText] of [['original', 'same-batch revision'], ['', 'filled before Save'], ['original', '  \n']]) {
  test(`same-batch input then Save validates and snapshots latest text ${JSON.stringify(latestText)}`, async () => {
    let closes = 0;
    const h = mount({ captions: [{ ...cues[0], text: initialText }],
      onSave: async captions => { h.calls.saves.push(plain(captions)); return true; },
      onCancel: () => { closes++; },
    });
    h.edit(0);
    const input = h.input(0), save = h.button('Save all caption edits');
    h.act(() => { input.onChangeText(latestText); save.onPress(); });
    await h.flush();
    assert.equal(h.input(0).value, latestText);
    if (latestText.trim()) {
      assert.equal(h.calls.saves.length, 1);
      assert.equal(h.calls.saves[0][0].text, latestText);
      assert.equal(closes, 1);
    } else {
      assert.deepEqual(h.calls.saves, []);
      assert.equal(closes, 0);
      assert.equal(h.calls.journalClears ?? 0, 0);
      assert.equal(h.input(0).editable, true);
    }
    h.unmount();
  });
}

for (const accepted of [false, true]) test(`same-batch input then Cancel prompts for edits after ${accepted ? 'accepted' : 'source'} draft`, async () => {
  let closes = 0;
  const storage = { clearError: true };
  const h = mount({ onSave: async () => true, onCancel: () => { closes++; } }, 'android', storage);
  h.edit(0);
  if (accepted) {
    h.act(() => h.input(0).onChangeText('accepted draft'));
    h.act(() => h.button('Save all caption edits').onPress()); await h.flush();
    assert.equal(h.calls.alerts.at(-1)[0], 'Changes saved');
  }
  storage.clearError = false;
  h.calls.alerts.length = 0;
  const clears = h.calls.journalClears ?? 0;
  const input = h.input(0), cancel = h.button('Cancel caption edits');
  h.act(() => { input.onChangeText('new text before Cancel'); cancel.onPress(); });
  await h.flush();
  assert.equal(closes, 0);
  assert.equal(h.calls.journalClears ?? 0, clears);
  assert.equal(h.calls.alerts.at(-1)?.[0], 'Discard unsaved caption edits?');
  assert.equal(h.input(0).value, 'new text before Cancel');
  h.act(() => h.calls.alerts.at(-1)[2].find(button => button.text === 'Keep editing').onPress?.());
  assert.equal(h.input(0).editable, true);
  h.unmount();
});

for (const restored of [false, true]) for (const outcome of ['success', 'false', 'rejection']) {
  test(`queued text survives ${outcome} receipt from ${restored ? 'restored' : 'source'} draft with journal/version ownership`, async () => {
    let resolveSave, rejectSave, closes = 0;
    const receipt = new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; });
    const h = mount({
      onSave: (captions) => {
        h.calls.saves.push(plain(captions));
        return h.calls.saves.length === 1 ? receipt : Promise.resolve(true);
      },
      onCancel: () => { closes++; },
    }, 'android', { deferRecovery: true });
    if (restored) { h.recover(cues.map(cue => ({ ...cue, text: `restored ${cue.text}` }))); h.restore(); }
    else h.recover(null);
    h.edit(1);
    h.act(() => h.input(1).onChangeText('submitted words'));
    h.act(() => h.input(1).onSelectionChange(selectionEvent(0)));
    const queued = h.input(1), other = h.input(2), row = h.row(2);
    const actions = ['Split here', 'Join previous', 'Join next'].map(label => h.actionProps(1, label));
    const before = plain(h.list().data), focuses = h.calls.focuses.length;
    h.act(() => {
      h.button('Save all caption edits').onPress();
      queued.onChangeText('first queued words');
      queued.onSubmitEditing({ nativeEvent: { text: 'first queued words' } });
      queued.onKeyPress(keyEvent('Backspace'));
      queued.onSelectionChange(selectionEvent(3));
      for (const action of actions) action.onPress();
      other.onFocus(); other.onPressIn(); row.props.onPress(); other.onChangeText('foreign cue');
      queued.onChangeText('newest\nqueued words');
    });
    assert.equal(h.input(1).editable, false);
    assert.equal(h.calls.focuses.length, focuses);
    assert.deepEqual(plain(h.list().data), before.map((cue, index) => index === 1
      ? { ...cue, text: 'newest\nqueued words', textMode: 'manual' } : cue));
    assert.equal(h.calls.saves[0][1].text, 'submitted words');
    if (outcome === 'rejection') rejectSave(new Error('receipt rejected'));
    else resolveSave(outcome === 'success');
    await h.flush();
    assert.equal(closes, 0);
    assert.equal(h.calls.journalClears ?? 0, 0);
    assert.equal(h.input(1).value, 'newest\nqueued words');
    assert.equal(h.button('Save all caption edits').disabled, false);
    if (outcome === 'success') h.update({ captions: h.calls.saves[0] });
    h.advance(1000); await h.flush();
    const journal = h.calls.journals.at(-1);
    assert.equal(journal[0], 'project');
    assert.equal(journal[2], scriptMutations.captionScriptRevision(outcome === 'success' ? h.calls.saves[0] : cues));
    assert.equal(journal[3][1].text, 'newest\nqueued words');
    if (outcome === 'success') assert.match(h.list().ListHeaderComponent.props.children[4].props.children, /Newer caption edits are still unsaved/);
    h.act(() => h.button('Save all caption edits').onPress()); await h.flush();
    assert.equal(h.calls.saves.length, 2);
    assert.equal(h.calls.saves[1][1].text, 'newest\nqueued words');
    assert.equal(closes, 1);
    assert.equal(h.calls.journalClears, 1);
    h.unmount();
  });
}

for (const boundary of ['project', 'reopen', 'restore', 'removed', 'cancel', 'unmount']) {
  test(`captured text cannot cross ${boundary} ownership boundary`, async () => {
    const h = mount(); h.edit(1);
    const stale = h.input(1);
    if (boundary === 'project') h.update({ projectId: 'another-project' });
    if (boundary === 'reopen') { h.update({ visible: false }); h.update({ visible: true }); h.recover(null); }
    if (boundary === 'restore') { h.recover(cues.map(cue => ({ ...cue, text: `restored ${cue.text}` }))); h.restore(); }
    if (boundary === 'removed') h.action(1, 'Join previous');
    if (boundary === 'cancel') { h.act(() => h.button('Cancel caption edits').onPress()); await h.flush(); }
    if (boundary === 'unmount') h.unmount();
    const before = plain(h.list().data), publications = h.calls.drafts.length;
    if (boundary === 'unmount') stale.onChangeText('stale delivery');
    else h.act(() => stale.onChangeText('stale delivery'));
    assert.deepEqual(plain(h.list().data), before);
    assert.equal(h.calls.drafts.length, publications);
    h.advance(1000); await h.flush();
    assert.ok((h.calls.journals ?? []).every(entry => entry[3].every(cue => cue.text !== 'stale delivery')));
    if (boundary !== 'unmount') h.unmount();
  });
}

for (const decision of ['unread', 'failed', 'restore']) test(`pre-recovery callback stays blocked after ${decision} recovery`, () => {
  const h = mount({}, 'android', { deferRecovery: true });
  const stale = h.input(1);
  if (decision === 'failed') h.failRecovery();
  if (decision === 'restore') { h.recover(cues); h.restore(); }
  if (decision === 'unread') h.recover(null);
  const before = plain(h.list().data);
  h.act(() => stale.onChangeText('pre-recovery text'));
  assert.deepEqual(plain(h.list().data), before);
  h.unmount();
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
  const h = mount({}, 'android', {}, {}); h.viewport(200); h.edit(5); h.calls.seeks.length = 0;
  assert.equal(h.calls.indices.at(-1)?.index, 5, 'unmeasured target uses index navigation');
  h.calls.indices.length = 0; h.calls.offsets.length = 0;
  h.advance(1000);
  assert.equal(h.calls.indices.length, 3, 'three bounded retries after the initial unmeasured request');
  assert.ok(h.calls.indices.every(({ index }) => index === 5));
  const requests = h.calls.indices.length, offsets = h.calls.offsets.length;
  h.advance(1000);
  assert.equal(h.calls.indices.length, requests);
  assert.equal(h.calls.offsets.length, offsets);
  assert.ok(h.calls.offsets.length <= 3); assert.deepEqual(h.calls.seeks, []);
});

for (const interrupt of ['drag', 'close', 'unmount']) {
  test(`${interrupt} cancels pending virtualized navigation`, () => {
    const h = mount({}, 'android', {}, {}); h.viewport(200); h.edit(5);
    h.act(() => h.list().onScrollToIndexFailed({ index: 5, averageItemLength: 100 }));
    if (interrupt === 'drag') h.fire('onScrollBeginDrag');
    if (interrupt === 'close') h.update({ visible: false });
    if (interrupt === 'unmount') h.unmount();
    h.calls.indices.length = 0; h.calls.offsets.length = 0;
    h.advance(1000); assert.deepEqual(h.calls.indices, []); assert.deepEqual(h.calls.offsets, []);
  });
}

test('reopening resets gestures and reveals the new initial cue', () => {
  const h = mount(); h.fire('onScrollBeginDrag'); h.fire('onScroll', 192);
  h.update({ visible: false }); h.update({ visible: true, initialCaptionId: 'cue-0', currentMs: 4100 });
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
  let workspaceHeight = 800, workspaceWidth = 360;
  const onLayout = jsxProp(workspaceRoot, 'onLayout', {
    setWorkspaceHeight: (value) => { workspaceHeight = value; },
    setWorkspaceWidth: (value) => { workspaceWidth = value; },
  });
  assert.equal(typeof onLayout, 'function', 'measure the usable root, not just the screen dimensions');
  const [preview, tools] = workspaceRoot.children.filter(ts.isJsxElement);
  const fitRect = evaluate(editorAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'fitRect').getText(editorAst));
  for (const availableHeight of [800, 360, 280, 240, 220, 440, 800]) {
    onLayout(layoutEvent(0, availableHeight));
    const context = { scriptEditorOpen: true, scriptKeyboardOpen: true, workspaceHeight, workspaceWidth, width: workspaceWidth, height: 800 };
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
    const offset = h.calls.offsets.at(-1)?.offset;
    const guideY = 500 - offset;
    assert.equal(guideY, 8);
    assert.ok(h.input(4).style.minHeight >= 2 * h.input(4).style.lineHeight);
    const inputTop = previewStyle.height + headerHeight + guideY + 14;
    assert.ok(inputTop + h.input(4).style.lineHeight < availableHeight, 'the focused input starts above the keyboard; long text extends in the list');
    assert.equal(h.input(4).style.maxHeight, undefined, 'keyboard resize must never cap the text height');
    h.fire('onScroll', offset);
  }
  assert.deepEqual(h.calls.seeks, [], 'focus, resize and reveal preserve authoritative transport');
  assert.ok(workspaceValue('previewHeight', { scriptEditorOpen: false, workspaceHeight: 280, height: 800 }) <= 136);
  assert.equal(jsxProp(tools, 'style', { scriptEditorOpen: false }).display, 'flex');
});

test('the leading edge seeks the first cue even when multiple short rows fit in the viewport', () => {
  const h = mount(); h.viewport(600);
  for (let index = 0; index < cues.length; index += 1) h.measure(index, 20 + index * 80, 72);
  h.fire('onScrollBeginDrag'); h.fire('onScroll', 0); h.fire('onScrollEndDrag', 0); h.advance(150);
  assert.deepEqual(h.calls.seeks, [0]);
  assert.deepEqual(h.calls.selects, ['cue-0']);
  h.calls.indices.length = 0; h.calls.offsets.length = 0;
  h.measure(0, 20, 72); h.viewport(580);
  assert.deepEqual(h.calls.indices, [], 'settled user scroll must survive later layout events');
  assert.deepEqual(h.calls.offsets, [], 'settled user scroll must survive later measured layout events');
});

test('tapping a visible or final short row aligns its editor at the top, including retry and resize', () => {
  const h = mount(); h.viewport(500);
  h.edit(1);
  assert.equal(200 - h.calls.offsets.at(-1)?.offset, 8, 'visible rows must also move to the top');
  h.edit(5);
  h.advance(100); h.keyboard('keyboardDidShow'); h.viewport(140);
  assert.equal(600 - h.calls.offsets.at(-1)?.offset, 8);
  assert.ok(h.list().ListFooterComponent.props.style.height >= 132, 'the final row needs enough trailing scroll space to reach the 8px anchor');
  h.fire('onScroll', 592); h.calls.indices.length = 0; h.calls.offsets.length = 0;
  h.act(() => h.input(5).onContentSizeChange(contentSizeEvent(69)));
  assert.deepEqual(h.calls.indices, [], 'already aligned input must not restart navigation');
  assert.deepEqual(h.calls.offsets, [], 'already aligned input must not restart measured navigation');
});

test('dragging and tapping retain native inputs and focus without reopening a natively hidden keyboard', () => {
  const h = mount(); h.edit(1); h.keyboard('keyboardDidShow');
  assert.equal(h.calls.focusCaptures, cues.length, 'forward focus capture so native virtualization retains the focused cell');
  h.calls.indices.length = 0; h.calls.offsets.length = 0; h.calls.focuses.length = 0;
  h.fire('onScrollBeginDrag'); h.fire('onScroll', 392); h.fire('onScrollEndDrag', 392); h.advance(150);
  h.viewport(180); h.measure(1, 200, 160); h.act(() => h.input(1).onContentSizeChange(contentSizeEvent(92)));
  assert.equal(h.input(1).value, 'caption 1');
  assert.equal(h.input(1).scrollEnabled, false, 'the list scrolls the fully expanded input');
  assert.deepEqual(h.calls.indices, [], 'the old focused row must not reclaim a user scroll');
  assert.deepEqual(h.calls.offsets, [], 'the old measured row must not reclaim a user scroll');
  assert.deepEqual(h.calls.focuses, [], 'list updates must not refocus the input');
  h.edit(4);
  assert.equal(h.input(1).value, 'caption 1', 'the previous native input must not unmount during focus transfer');
  assert.equal(h.input(4).scrollEnabled, false);
  assert.equal(h.input(4).submitBehavior, 'submit');
  assert.equal(h.calls.focuses.at(-1), 'cue-4');
  h.keyboard('keyboardDidHide'); h.calls.focuses.length = 0;
  h.viewport(500); h.fire('onScrollBeginDrag'); h.fire('onScrollEndDrag', 0); h.advance(150);
  assert.deepEqual(h.calls.focuses, [], 'native hide remains authoritative');
  assert.equal(h.calls.keyboards.at(-1), false);
});

test('draft text, empty text, splits, joins and recovery reach the actual parent preview selection before Save', () => {
  let scriptDraftCaptions = null, selectedCaptionId = cues[0].id, currentMs = 1100;
  const h = mount({
    currentMs,
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
  await h.flush();
  const journals = plain(h.calls.journals);
  assert.ok(journals.length > 0);
  h.act(() => h.button('Save all caption edits').onPress());
  await settleSave(); h.act(() => {});
  assert.equal(closes, 0);
  assert.equal(h.calls.journalClears ?? 0, 0);
  assert.deepEqual(h.calls.journals, journals);
  assert.deepEqual(plain(h.list().data), plain(scriptMutations.decodeCaptionDraft(invalid)));
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
  await h.flush();
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

test('zero-duration recovery survives editing another cue and a second journal restore', async () => {
  const project = migrationProject();
  project.captions[0].endMs = project.captions[0].startMs;
  const original = decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(project)));
  const recovery = structuredClone(original.captions);
  recovery[1].text = 'Previously unsaved words';
  const h = mount({ captions: original.captions });
  h.recover(recovery); h.restore();
  h.act(() => h.input(0).onChangeText('Next edit in zero cue')); h.advance(1000);
  await h.flush();
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

test('durable script save with failed recovery cleanup retries cleanup without resaving accepted text', async () => {
  let saves = 0, closes = 0;
  const storage = { clearError: true };
  const h = mount({ onSave: async () => { saves++; return true; }, onCancel: () => { closes++; } }, 'android', storage);
  h.recover(null);
  h.act(() => h.input(1).onChangeText('Durable accepted text'));
  h.act(() => h.button('Save all caption edits').onPress()); await h.flush();
  assert.equal(saves, 1); assert.equal(closes, 0);
  assert.equal(h.calls.alerts.at(-1)[0], 'Changes saved');
  assert.match(h.calls.alerts.at(-1)[1], /changes were saved.*recovery copy cleanup failed/i);
  assert.equal(h.input(1).value, 'Durable accepted text');
  storage.clearError = false;
  h.act(() => h.calls.alerts.at(-1)[2].find((button) => button.text === 'Retry cleanup').onPress());
  await h.flush();
  assert.equal(saves, 1); assert.equal(closes, 1); assert.equal(h.calls.journalClears, 2);
  h.advance(1000); await h.flush(); assert.equal(h.calls.journals, undefined);
  h.unmount();
});

test('script cleanup button state resets on newer typing and old retry preserves its journal', async () => {
  let saves = 0;
  const storage = { clearError: true };
  const h = mount({ onSave: async () => { saves++; return true; } }, 'android', storage);
  h.recover(null);
  h.act(() => h.input(1).onChangeText('Accepted text'));
  h.act(() => h.button('Save all caption edits').onPress()); await h.flush();
  assert.equal(h.button('Save all caption edits').children.props.children, 'Retry cleanup');
  const oldRetry = h.calls.alerts.at(-1)[2].find((button) => button.text === 'Retry cleanup');
  h.act(() => h.input(1).onChangeText('New unsaved text'));
  assert.equal(h.button('Save all caption edits').children.props.children, 'Done');
  storage.clearError = false;
  h.act(() => oldRetry.onPress()); await h.flush();
  assert.equal(saves, 1); assert.equal(h.calls.journalClears, 1);
  h.advance(1000); await h.flush();
  assert.equal(h.calls.journals.at(-1)[3][1].text, 'New unsaved text');
  h.unmount();
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
  else h.recover(null);
  const preview = workspaceValue('previewCaptions', {
    project, timelineCaptions: project.captions, scriptDraftCaptions: h.list().data,
  });
  for (const cue of preview) assert.deepEqual(captionTransform(resolveCaptionStyle(project.projectStyle, cue)), scriptTransform);
  h.act(() => h.button('Save all caption edits').onPress());
  await settleSave();
  assert.equal(closes, 1);
  assert.equal(h.calls.journalClears ?? 0, 1, 'saving after recovery resolves clears the consumed journal');
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
  h.recover(null);
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
      let observedOffset = leading - 8;
      for (const index of [0, 1, 5]) {
        h.calls.indices.length = 0; h.calls.offsets.length = 0; h.edit(index);
        // An already aligned row may need no native request.
        assert.deepEqual(h.calls.indices, [], 'measured rows bypass index metrics');
        const requestedOffset = h.calls.offsets.at(-1)?.offset ?? observedOffset;
        const nativeOffset = Math.max(0, Math.min(maximumOffset, requestedOffset));
        assert.equal(positions[index] - nativeOffset, 8, 'native clamping must not prevent top alignment');
        observedOffset = nativeOffset;
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
  h.recover(null);
  h.measure(1, 176, 72);
  h.calls.seeks.length = 0; h.calls.selects.length = 0;
  h.fire('onScrollBeginDrag'); h.fire('onScroll', -18); h.fire('onScroll', 0);
  h.measure(1, 176, 72); h.measure(0, 96, 72);
  h.fire('onScrollEndDrag', 0); h.advance(150);
  assert.deepEqual(h.calls.seeks, [0]); assert.deepEqual(h.calls.selects, ['cue-0']);
});

test('forward scrolling stays user-owned across keyboard resize and late layouts without reverse seeks', () => {
  const h = mount(); h.edit(0); h.keyboard('keyboardDidShow');
  h.calls.seeks.length = 0; h.calls.indices.length = 0; h.calls.offsets.length = 0;
  h.fire('onScrollBeginDrag'); h.fire('onScroll', 192);
  h.fire('onScroll', 292); h.viewport(140); h.measure(0, 100, 180);
  h.fire('onScrollEndDrag', 292); h.advance(150); h.measure(1, 200, 80);
  assert.deepEqual(h.calls.seeks, [1000, 2000]);
  assert.deepEqual(h.calls.indices, []);
  assert.deepEqual(h.calls.offsets, []);
  assert.equal(h.calls.editing.at(-1), undefined, 'a user scroll releases the old input camera target');
  h.edit(2); assert.equal(h.calls.editing.at(-1), 'cue-2');
});

test('offscreen retry includes measured leading space and the top editing anchor', () => {
  const h = mount({}, 'android', {}, {}); h.viewport(200);
  h.act(() => h.list().ListHeaderComponent.props.onLayout(layoutEvent(0, 148)));
  h.measure(0, 148, 100);
  h.edit(5);
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
  assert.ok(canvasSource.includes('<VideoTransitionOverlay')); assert.ok(canvasSource.includes('<CaptionOverlay'));
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
        assert.ok(previewHeight >= 48 && previewHeight <= workspaceHeight - 144, 'restored preview respects the actual resized window');
        if (workspaceHeight >= 424) {
          assert.ok(previewHeight >= 280);
          assert.ok(layoutStyle.height > 180, 'a roomy restored preview must not remain a keyboard strip');
        }
        assert.equal(x.value, 0); assert.equal(y.value, 0);
        assert.equal(h.calls.keyboards.at(-1), false, 'closing cannot depend on receiving keyboard hide');
      }
    }
    h.unmount();
  }
  assert.equal(stopped, 4, 'each keyboard crop animation stops before restoration');
});

test('native caption input preserves the editor around the landscape keyboard', () => {
  const h = mount(); h.edit(1);
  assert.equal(h.input(1).disableFullscreenUI, true);
});


test('the actual workspace supplies top safe space only when its native header is hidden', () => {
  for (const [width, height, workspaceHeight, expectedTop, expectedPreview] of [[760, 360, 360, 24, 320], [360, 800, 744, 0, 344]]) {
    const context = { width, height, workspaceWidth: width, workspaceHeight, scriptEditorOpen: false, scriptKeyboardOpen: false, insets: { top: 24, bottom: 16, left: 0, right: 0 }, editorWorkspaceLayout };
    const workspaceLayout = workspaceValue('workspaceLayout', context);
    assert.equal(workspaceLayout.previewHeight, expectedPreview);
    const style = jsxProp(workspaceRoot, 'style', { ...context, workspaceLayout, palette: {} });
    assert.equal(style.paddingTop, expectedTop);
    assert.equal(style.flexDirection, width > height ? 'row' : 'column');
  }
});
