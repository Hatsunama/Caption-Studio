import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as draftHelpers from '../src/lib/dual-caption-drafts.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { createTranslationCaptionTrack, resolveCaptionPairs, setTranslationCueTiming, setTranslationCueStyle, setTranslationStackGap, updatePairedCaptionTexts } from '../src/lib/caption-tracks.ts';
import { resolveCaptionStyle } from '../src/lib/style-resolver.ts';

// Like the script-editor tests, execute the complete component with deterministic
// native, hook, storage and timer doubles. FlatList windows are simulated; these
// tests measure subscription/render work, not native frame rate or keyboard layout.
const source = readFileSync(process.env.DUAL_CAPTION_EDITOR_SOURCE
  ?? new URL('../src/components/editor/dual-caption-editor.tsx', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  fileName: 'dual-caption-editor.tsx',
});
const plain = (value) => JSON.parse(JSON.stringify(value));
const pairs = (count = 3) => Array.from({ length: count }, (_, index) => ({
  trackId: 'zh', languageTag: 'zh-Hans', visible: true, timelineVisible: true,
  startMs: index * 1000, endMs: (index + 1) * 1000, style: { fontSize: 34 },
  source: { id: `cue-${index}`, text: `Source ${index}`, wordIds: [] },
  translation: { id: `translation-${index}`, text: `Translation ${index}`, status: 'translated' },
}));
const same = (left, right) => left && right && left.length === right.length
  && left.every((value, index) => Object.is(value, right[index]));
const shallow = (left, right) => left && right && same(Object.keys(left), Object.keys(right))
  && Object.keys(left).every((key) => Object.is(left[key], right[key]));

function mount(overrides = {}, options = {}) {
  const instances = new Map(), timers = new Map(), inputIdentities = new Map();
  const calls = { alerts: [], reads: [], writes: [], clears: [], saves: [], refresh: [], skip: [], close: 0, cancel: 0, retry: 0, dismiss: 0, visibility: 0, remove: 0, renders: new Map() };
  let current, cursor, pending = [], changed = false, tree, now = 0, nextTimer = 0, windowStart = 0;
  const memoHook = (factory, deps) => {
    const index = cursor++;
    if (!current.slots[index] || !same(current.slots[index].deps, deps)) current.slots[index] = { value: factory(), deps };
    return current.slots[index].value;
  };
  const effect = (callback, deps) => {
    const instance = current, index = cursor++;
    if (!instance.slots[index] || !same(instance.slots[index].deps, deps)) pending.push(() => {
      instance.slots[index]?.cleanup?.();
      instance.slots[index] = { deps, cleanup: callback() };
    });
  };
  const react = {
    memo: (fn) => ({ fn }), useMemo: memoHook, useCallback: (fn, deps) => memoHook(() => fn, deps),
    useRef: (value) => memoHook(() => ({ current: value }), []),
    useEffect: effect, useLayoutEffect: effect,
    useState(initial) {
      const instance = current, index = cursor++;
      instance.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [instance.slots[index].value, (value) => {
        const next = typeof value === 'function' ? value(instance.slots[index].value) : value;
        if (!Object.is(next, instance.slots[index].value)) {
          instance.slots[index].value = next; instance.dirty = true; changed = true;
        }
      }];
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const instance = current;
      const slot = memoHook(() => ({ value: getSnapshot() }), []);
      slot.value = getSnapshot();
      effect(() => {
        const check = () => {
          if (!Object.is(slot.value, getSnapshot())) { instance.dirty = true; changed = true; }
        };
        const unsubscribe = subscribe(check); check(); return unsubscribe;
      }, [subscribe, getSnapshot]);
      return slot.value;
    },
  };
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const exports = {};
  runInNewContext(`${outputText}\nexports.Store = typeof DualCaptionDraftStore === 'undefined' ? undefined : DualCaptionDraftStore;`, {
    exports,
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === 'react-native') return {
        ...Object.fromEntries(['ActivityIndicator', 'FlatList', 'Modal', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View'].map((type) => [type, type])),
        Alert: { alert: (...args) => calls.alerts.push(args) },
      };
      if (name === 'react-native-safe-area-context') return { useSafeAreaInsets: () => ({ top: 0, bottom: 24 }) };
      if (name === '@/lib/ui-theme') return { chrome: { radius: { lg: 12, md: 8, pill: 20, xl: 20 } } };
      if (name === '@/lib/dual-caption-drafts') return draftHelpers;
      if (name === '@/services/editor-draft-journal') return {
        readEditorDraftJournal: async (...args) => { calls.reads.push(args); return options.read ? options.read(...args) : options.journal; },
        writeEditorDraftJournal: async (...args) => { calls.writes.push(args); if (options.writeError) throw new Error('storage full'); },
        clearEditorDraftJournal: async (...args) => { calls.clears.push(args); if (options.clearError) throw new Error('clear failed'); },
      };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    setTimeout(callback, delay) { timers.set(++nextTimer, { callback, at: now + delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  });
  let props = {
    visible: true, projectId: 'project', baseRevision: 'r1', trackId: 'zh', pairs: pairs(),
    sourceLanguageLabel: 'English', targetLanguageLabel: 'Chinese', trackVisible: true,
    automaticTranslation: true, busy: false, retryErrorAvailable: false,
    onSave: async (edits) => { calls.saves.push(plain(edits)); return false; },
    onClose: () => { calls.close++; }, onRefresh: (ids) => calls.refresh.push(plain(ids)),
    onSkip: (...args) => calls.skip.push(args), onToggleVisibility: () => { calls.visibility++; },
    onRemove: () => { calls.remove++; }, onCancelBusy: () => { calls.cancel++; },
    onRetryError: () => { calls.retry++; }, onDismissError: () => { calls.dismiss++; }, ...overrides,
  };
  function renderNode(node, path, visited, inputs) {
    if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${path}/${child?.key ?? index}`, visited, inputs));
    if (!node || typeof node !== 'object') return node;
    const fn = node.type?.fn ?? (typeof node.type === 'function' ? node.type : undefined);
    if (fn) {
      const id = `${path}:${fn.name}:${node.key ?? ''}`;
      visited.add(id);
      let instance = instances.get(id);
      if (!instance) { instance = { slots: [], dirty: true }; instances.set(id, instance); }
      if (instance.dirty || !(node.type?.fn ? shallow(instance.props, node.props) : instance.props === node.props)) {
        current = instance; cursor = 0; instance.dirty = false; instance.props = node.props;
        const renderKey = fn.name === 'DualCaptionRow' ? `row:${node.props.pair.source.id}` : fn.name;
        calls.renders.set(renderKey, (calls.renders.get(renderKey) ?? 0) + 1);
        instance.output = fn(node.props);
      }
      return renderNode(instance.output, `${id}/output`, visited, inputs);
    }
    let children = node.props.children;
    if (node.type === 'FlatList') children = node.props.data.slice(windowStart, windowStart + node.props.initialNumToRender)
      .map((item, index) => ({ ...node.props.renderItem({ item, index: windowStart + index }), key: node.props.keyExtractor(item) }));
    if (node.type === 'TextInput') {
      const id = `${path}:${node.key ?? ''}`;
      inputs.add(id);
      if (!inputIdentities.has(id)) inputIdentities.set(id, {});
      return { ...node, identity: inputIdentities.get(id) };
    }
    return { ...node, props: { ...node.props, children: renderNode(children, `${path}/children`, visited, inputs) } };
  }
  function render() {
    let passes = 0;
    do {
      assert.ok(++passes < 30, 'editor must settle without a render loop');
      changed = false; pending = [];
      const visited = new Set(), inputs = new Set();
      tree = renderNode(jsx(exports.DualCaptionEditor, props), 'root', visited, inputs);
      for (const [id, instance] of instances) if (!visited.has(id)) {
        instance.slots.forEach((slot) => slot?.cleanup?.()); instances.delete(id);
      }
      for (const id of inputIdentities.keys()) if (!inputs.has(id)) inputIdentities.delete(id);
      for (const callback of pending) callback();
    } while (changed);
  }
  function all(predicate, node = tree) {
    if (Array.isArray(node)) return node.flatMap((child) => all(predicate, child));
    if (!node || typeof node !== 'object') return [];
    return [...(predicate(node) ? [node] : []), ...all(predicate, node.props?.children ?? null)];
  }
  function text(node) {
    if (Array.isArray(node)) return node.map(text).join('');
    return node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '');
  }
  const button = (label) => {
    const found = all((node) => node.type === 'Pressable'
      && (node.props.accessibilityLabel === label || text(node) === label))[0];
    assert.ok(found, `missing button: ${label}`); return found;
  };
  const input = (index, language = 'English') => {
    const found = all((node) => node.type === 'TextInput' && node.props.accessibilityLabel === `${language} subtitle ${index + 1} text`)[0];
    assert.ok(found, `missing ${language} input ${index}`); return found;
  };
  function act(callback) { callback(); render(); }
  async function flush() { for (let index = 0; index < 10; index++) { await Promise.resolve(); render(); } }
  render();
  return {
    calls, all, button, input, flush, act, Store: exports.Store,
    get props() { return props; },
    update(next) { props = { ...props, ...next }; render(); },
    scroll(index) { windowStart = index; render(); },
    edit(index, value, language = 'English') { const node = input(index, language); assert.equal(node.props.editable, true); act(() => node.props.onChangeText(value)); },
    press(label) { const node = button(label); assert.ok(!node.props.disabled, `disabled: ${label}`); act(() => node.props.onPress()); },
    choose(label) { const choice = calls.alerts.at(-1)?.[2].find((entry) => entry.text === label); assert.ok(choice, `missing alert choice: ${label}`); act(() => choice.onPress?.()); },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
      await flush();
    },
  };
}

test('mounts a bounded input window for 10000 caption pairs', async () => {
  const h = mount({ pairs: pairs(10000) }); await h.flush();
  const inputs = h.all((node) => node.type === 'TextInput');
  assert.ok(inputs.length <= 12, `mounted ${inputs.length} inputs`);
  const list = h.all((node) => node.type === 'FlatList')[0];
  assert.ok(list);
  assert.equal(list.props.windowSize, 5);
  assert.equal(list.props.maxToRenderPerBatch, 6);
  assert.equal(list.props.removeClippedSubviews, false);
  assert.equal(list.props.keyboardShouldPersistTaps, 'handled');
  assert.equal(list.props.getItemLayout, undefined, 'multiline and accessible font sizes have variable height');
});

test('typing updates one cue without rendering siblings or scanning committed drafts', async () => {
  const h = mount({ pairs: pairs(10000) }); await h.flush();
  h.edit(0, 'First edit'); // Clean-to-dirty changes intentionally disable refresh everywhere.
  const before = new Map(h.calls.renders), identity = h.input(0).identity;
  const renderItem = h.all((node) => node.type === 'FlatList')[0].props.renderItem;
  for (let index = 0; index < 30; index++) h.edit(0, `Typing ${index}`);
  assert.equal(h.calls.renders.get('row:cue-0') - before.get('row:cue-0'), 30);
  assert.equal(h.calls.renders.get('row:cue-1'), before.get('row:cue-1'));
  assert.equal(h.calls.renders.get('DualCaptionEditorSession'), before.get('DualCaptionEditorSession'));
  assert.equal(h.all((node) => node.type === 'FlatList')[0].props.renderItem, renderItem);
  assert.equal(h.input(0).identity, identity);
  assert.equal(h.button('Save dual subtitle edits').props.disabled, false);
  let reads = 0, scans = 0, notifications = 0;
  const committed = new Proxy(draftHelpers.dualCaptionDraftsFromPairs(pairs(10000)), {
    get(target, key) { reads++; return target[key]; }, ownKeys(target) { scans++; return Reflect.ownKeys(target); },
  });
  const store = new h.Store(committed), sibling = store.getDraft('cue-9999');
  store.subscribeCue('cue-9999', () => { notifications++; }); reads = 0; scans = 0;
  for (let index = 0; index < 50; index++) store.setDraft('cue-0', 'translatedText', `Edited ${index}`);
  assert.equal(scans, 0); assert.equal(reads, 50); assert.equal(notifications, 0);
  assert.equal(store.getDraft('cue-9999'), sibling); assert.equal(store.getDirtyCount(), 1);
});

test('both fields survive virtualized unmounts, reorder, and save without blur', async () => {
  const h = mount({ pairs: pairs(30) }); await h.flush();
  h.edit(0, 'Edited source'); h.edit(0, 'Edited translation', 'Chinese');
  h.press('Select subtitle 1 for refresh');
  h.scroll(20); h.edit(20, 'Another source'); h.scroll(0);
  assert.equal(h.input(0).props.value, 'Edited source');
  assert.equal(h.input(0, 'Chinese').props.value, 'Edited translation');
  assert.equal(h.button('Select subtitle 1 for refresh').props.accessibilityState.checked, true);
  h.update({ pairs: [h.props.pairs[1], h.props.pairs[0], ...h.props.pairs.slice(2)] });
  assert.equal(h.input(1).props.value, 'Edited source');
  h.press('Save dual subtitle edits'); await h.flush();
  assert.deepEqual(h.calls.saves[0].map((edit) => edit.sourceCaptionId), ['cue-0', 'cue-20']);
  assert.equal(h.calls.saves[0][0].translatedText, 'Edited translation');
});

test('committed updates adopt untouched fields and retain edits without remounting inputs', async () => {
  const h = mount(); await h.flush(); h.edit(0, 'Typed source');
  const identity = h.input(0).identity;
  const next = plain(h.props.pairs); next[0].translation.text = 'New translation';
  h.update({ pairs: next });
  assert.equal(h.input(0).props.value, 'Typed source');
  assert.equal(h.input(0, 'Chinese').props.value, 'New translation');
  assert.equal(h.input(0).identity, identity);
  h.edit(0, 'Typed translation', 'Chinese'); next[0] = { ...next[0], translation: { ...next[0].translation, text: 'Later translation' } };
  h.update({ pairs: [...next] });
  assert.equal(h.input(0, 'Chinese').props.value, 'Typed translation');
  h.update({ pairs: h.props.pairs.slice(1) });
  assert.equal(h.button('Save dual subtitle edits').props.disabled, true);
});

test('recovery snapshots are debounced and immutable; reverting clears pending recovery', async () => {
  const h = mount(); await h.flush(); h.edit(0, 'Before snapshot');
  await h.advance(599); assert.equal(h.calls.writes.length, 0);
  h.edit(0, 'Latest snapshot'); await h.advance(599); assert.equal(h.calls.writes.length, 0);
  await h.advance(1); assert.equal(h.calls.writes.length, 1);
  const payload = h.calls.writes[0][3];
  assert.equal(payload['cue-0'].primaryText, 'Latest snapshot');
  h.edit(0, 'After snapshot'); assert.equal(payload['cue-0'].primaryText, 'Latest snapshot');
  const clears = h.calls.clears.length; h.edit(0, 'Source 0');
  await h.advance(600);
  assert.equal(h.calls.writes.length, 1); assert.ok(h.calls.clears.length > clears);
  assert.equal(h.button('Save dual subtitle edits').props.disabled, true);
});

test('whitespace and blank input keep the existing committed fallback semantics', async () => {
  const h = mount(); await h.flush(); h.edit(0, '   '); h.edit(0, '', 'Chinese');
  assert.equal(h.button('Save dual subtitle edits').props.disabled, true);
  await h.advance(600); assert.equal(h.calls.writes[0][3]['cue-0'].primaryText, '   ');
  h.edit(0, '  New source  '); h.press('Save dual subtitle edits'); await h.flush();
  assert.deepEqual(h.calls.saves[0][0], {
    sourceCaptionId: 'cue-0', primaryText: 'New source', translatedText: 'Translation 0', primaryChanged: true, translatedChanged: false,
  });
});

for (const choice of ['Keep current translation', 'Restore unsaved typing']) {
  test(`${choice} resolves recovery against the latest committed translation`, async () => {
    const h = mount({}, { journal: { payload: { 'cue-0': { primaryText: 'Recovered source', translatedText: '' } } } });
    await h.flush(); assert.equal(h.input(0).props.editable, false);
    const next = plain(h.props.pairs); next[0].translation.text = 'Translation received while asking';
    h.update({ pairs: next }); h.choose(choice);
    assert.equal(h.input(0).props.value, choice === 'Restore unsaved typing' ? 'Recovered source' : 'Source 0');
    assert.equal(h.input(0, 'Chinese').props.value, 'Translation received while asking');
    assert.equal(h.input(0).props.editable, true);
    await h.advance(600);
    assert.equal(h.calls.writes.length, choice === 'Restore unsaved typing' ? 1 : 0);
  });
}

test('stale recovery reads, alerts and timers cannot cross project/track/open sessions', async () => {
  let resolveRead;
  const h = mount({}, { read: () => new Promise((resolve) => { resolveRead = resolve; }) });
  await h.flush(); const resolveOld = resolveRead;
  h.update({ projectId: 'other' }); await h.flush();
  resolveOld({ payload: { 'cue-0': { primaryText: 'Old source', translatedText: 'Old translation' } } });
  await h.flush(); assert.equal(h.calls.alerts.length, 0);
  resolveRead({ payload: { 'cue-0': { primaryText: 'Recover', translatedText: 'Recovery' } } });
  await h.flush(); const oldChoice = h.calls.alerts[0][2][1];
  h.update({ trackId: 'fr' }); await h.flush(); resolveRead(null); await h.flush();
  h.act(() => oldChoice.onPress()); assert.equal(h.input(0).props.value, 'Source 0');
  h.edit(0, 'Unsaved'); h.update({ visible: false }); await h.advance(1000);
  assert.equal(h.calls.writes.length, 0);
  h.update({ visible: true }); await h.flush(); resolveRead(null); await h.flush();
  assert.equal(h.input(0).props.value, 'Source 0');
  assert.deepEqual(h.calls.reads.map((args) => args.slice(0, 2)), [
    ['project', 'dual-captions-zh'], ['other', 'dual-captions-zh'], ['other', 'dual-captions-fr'], ['other', 'dual-captions-fr'],
  ]);
});

test('Keep editing preserves drafts; Discard cancels pending writes before closing', async () => {
  const h = mount(); await h.flush(); h.edit(0, 'Discard me');
  h.press('Close dual subtitle editor'); h.choose('Keep editing'); assert.equal(h.calls.close, 0);
  assert.equal(h.input(0).props.value, 'Discard me');
  h.press('Close dual subtitle editor'); h.choose('Discard');
  h.update({ visible: false }); await h.advance(600);
  assert.equal(h.calls.close, 1); assert.equal(h.calls.writes.length, 0);
});

test('successful save cancels pending journal writes and adopts the saved pair', async () => {
  let completeSave;
  const h = mount({ onSave: () => new Promise((resolve) => { completeSave = resolve; }) });
  await h.flush(); h.edit(0, 'Saved source'); h.press('Save dual subtitle edits');
  assert.equal(h.input(0).props.editable, false);
  await h.advance(1000); assert.equal(h.calls.writes.length, 0);
  const next = plain(h.props.pairs); next[0].source.text = 'Saved source';
  h.update({ pairs: next }); completeSave(true); await h.flush(); await h.advance(600);
  assert.equal(h.input(0).props.value, 'Saved source');
  assert.equal(h.button('Save dual subtitle edits').props.disabled, true);
  assert.equal(h.calls.writes.length, 0);
});

test('failed save and journal failures retain typing and expose accessible errors', async () => {
  const h = mount({ onSave: async () => { throw new Error('Save failed'); } }, { writeError: true });
  await h.flush(); h.edit(0, 'Keep this'); h.press('Save dual subtitle edits'); await h.flush();
  assert.equal(h.input(0).props.value, 'Keep this');
  assert.ok(h.all((node) => node.props.accessibilityRole === 'alert').length > 0);
  await h.advance(600); assert.equal(h.calls.writes.length, 1);
  assert.equal(h.button('Save dual subtitle edits').props.disabled, false);
});

test('selection, refresh, skip, visibility and removal preserve their action contracts', async () => {
  const data = pairs(); data[1].translation.status = 'stale'; data[2].translation.translationSkipped = true;
  const h = mount({ pairs: data }); await h.flush();
  h.press('Select all'); h.press('Refresh selected (2)');
  assert.deepEqual(h.calls.refresh.at(-1), ['cue-0', 'cue-1']);
  assert.equal(h.button('Select subtitle 3 for refresh').props.disabled, true);
  h.press('Clear selection'); h.press('Refresh unfinished (1)');
  assert.deepEqual(h.calls.refresh.at(-1), ['cue-1']);
  h.press('Refresh translation for subtitle 1'); assert.deepEqual(h.calls.refresh.at(-1), ['cue-0']);
  h.press('Skip second line'); assert.deepEqual(h.calls.skip.at(-1), ['cue-0', true]);
  h.press('Include second line'); assert.deepEqual(h.calls.skip.at(-1), ['cue-2', false]);
  h.press('Hide Chinese line'); h.press('Remove second language');
  assert.equal(h.calls.visibility, 1); assert.equal(h.calls.remove, 1);
  h.edit(0, 'Dirty');
  for (const label of ['Refresh all (2)', 'Hide Chinese line', 'Remove second language', 'Skip second line']) assert.equal(h.button(label).props.disabled, true);
  h.update({ automaticTranslation: false });
  assert.equal(h.all((node) => node.props.accessibilityLabel === 'Refresh translation for subtitle 1').length, 0);
});

test('busy cancel and error retry/dismiss controls remain available', async () => {
  const h = mount(); await h.flush(); h.update({ busy: true });
  assert.equal(h.input(0).props.editable, false); h.press('Cancel'); assert.equal(h.calls.cancel, 1);
  h.update({ busy: false, errorMessage: 'Translation stopped', retryErrorAvailable: true });
  h.press('Retry interrupted translation'); h.press('Close');
  assert.equal(h.calls.retry, 1); assert.equal(h.calls.dismiss, 1);
});

test('dual editor save preserves stacked preview overlays with independent timing and style', async () => {
  let project = createCaptionProject({ id: 'preview', name: 'Dual preview', sources: [{
    id: 'video', uri: 'file:///fixture.mp4', storageMode: 'copied', displayName: 'fixture.mp4',
    durationMs: 5000, width: 1080, height: 1920, rotation: 0,
  }] });
  project.transcription.language = 'en';
  project.projectStyle = { ...project.projectStyle, fontSize: 48, textColor: '#FFAA00' };
  project.captions = [{ id: 'cue-0', text: 'Original', startMs: 0, endMs: 2000, wordIds: [], timingMode: 'timeline' }];
  project = createTranslationCaptionTrack(project, {
    id: 'zh', sourceLanguageTag: 'en', languageTag: 'zh-Hans', displayName: 'Chinese',
    translations: { 'cue-0': 'Second language' }, styleOverride: { fontSize: 26, textColor: '#00FFFF' },
  });
  project = setTranslationCueTiming(project, 'zh', 'cue-0', 'move', 500, 2500);
  project = setTranslationCueStyle(project, 'zh', 'cue-0', { fontSize: 30 });
  project = setTranslationStackGap(project, 'zh', 0.06);

  // Evaluate the actual preview selection and the two CaptionOverlay prop
  // expressions. Keep the app editor read-only and avoid loading its services.
  const editorSource = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('editor.tsx', editorSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = new Map(), overlays = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node)) declarations.set(node.name.getText(ast), node.initializer);
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'CaptionOverlay') overlays.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const attribute = (node, name) => node.attributes.properties.find((prop) => prop.name?.getText(ast) === name)?.initializer?.expression;
  const primary = overlays.find((node) => attribute(node, 'caption')?.getText(ast) === 'displayCaption');
  const secondary = overlays.find((node) => attribute(node, 'projectStyle')?.getText(ast) === 'pair.style');
  assert.ok(primary); assert.ok(secondary);
  function evaluate(expression, context) {
    const sandbox = { ...context, result: undefined };
    const compiled = ts.transpileModule(`result = (${expression.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
    runInNewContext(compiled.outputText, sandbox); return sandbox.result;
  }
  function preview() {
    const activeCaption = project.captions.find((caption) => 1000 >= caption.startMs && 1000 < caption.endMs);
    const displayCaption = evaluate(declarations.get('displayCaption'), { scriptEditorOpen: false, isPlaying: true, activeCaption });
    const translationTimelineTracks = project.captionTracks.translations.map((track) => ({
      ...track, pairs: resolveCaptionPairs(project, track.id).filter((pair) => pair.timelineVisible),
    }));
    const translations = evaluate(declarations.get('displayTranslationPairs'), {
      useMemo: (factory) => factory(), displayCaption, translationTimelineTracks,
    });
    return [
      { caption: evaluate(attribute(primary, 'caption'), { displayCaption }),
        style: resolveCaptionStyle(evaluate(attribute(primary, 'projectStyle'), { project }), displayCaption) },
      ...translations.map((pair) => ({ caption: evaluate(attribute(secondary, 'caption'), { pair }),
        style: evaluate(attribute(secondary, 'projectStyle'), { pair }) })),
    ];
  }
  const before = preview(); assert.equal(before.length, 2);
  const h = mount({ pairs: resolveCaptionPairs(project, 'zh'), onSave: async (edits) => {
    project = updatePairedCaptionTexts(project, edits.map((edit) => ({
      trackId: 'zh', sourceCaptionId: edit.sourceCaptionId,
      ...(edit.primaryChanged ? { primaryText: edit.primaryText } : {}),
      ...(edit.translatedChanged ? { translatedText: edit.translatedText, translationStatus: 'reviewed' } : {}),
    })));
    return true;
  } });
  await h.flush(); h.edit(0, 'Edited original'); h.edit(0, 'Edited second language', 'Chinese');
  h.press('Save dual subtitle edits'); await h.flush();
  h.update({ pairs: resolveCaptionPairs(project, 'zh') });
  const after = preview(); assert.equal(after.length, 2);
  assert.deepEqual(after.map((line) => line.caption.text), ['Edited original', 'Edited second language']);
  assert.deepEqual(after.map((line) => [line.caption.startMs, line.caption.endMs]), [[0, 2000], [500, 2500]]);
  assert.notEqual(after[0].caption.id, after[1].caption.id);
  assert.deepEqual(after.map((line) => line.style.fontSize), [48, 30]);
  assert.deepEqual(after.map((line) => line.style.textColor), ['#FFAA00', '#00FFFF']);
  assert.notDeepEqual(after[0].style.position, after[1].style.position, 'preview retains the stacked line positions');
  assert.deepEqual(after.map((line) => plain(line.style)), before.map((line) => plain(line.style)));
});
