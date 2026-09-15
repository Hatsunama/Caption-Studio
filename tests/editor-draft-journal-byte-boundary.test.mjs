import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createKeyedOperationQueue } from '../src/lib/keyed-operation-queue.ts';
import * as scriptHelpers from '../src/lib/caption-script.ts';
import * as dualHelpers from '../src/lib/dual-caption-drafts.ts';

const compile = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const serviceSource = compile('../src/services/editor-draft-journal.ts');
const editorSources = {
  script: compile('../src/components/editor/script-editor.tsx'),
  dual: compile('../src/components/editor/dual-caption-editor.tsx') + '\nexports.Session = DualCaptionEditorSession;',
};
const uri = 'file:///test-documents/editor-drafts/project-caption-script.json';
const envelope = (payload, kind = 'caption-script') => JSON.stringify({ schemaVersion: 1, projectId: 'project', kind,
  baseRevision: 'base', savedAt: '2026-09-15T00:00:00.000Z', payload });

// Only synthetic in-memory files: never access private device recovery data.
function harness(options = {}) {
  const files = new Map();
  const events = [];
  const fs = {
    documentDirectory: options.unavailable ? null : 'file:///test-documents/',
    async getInfoAsync(path) {
      return { exists: files.has(path), isDirectory: false,
        size: options.omitSize ? undefined : Buffer.byteLength(files.get(path) ?? '', 'utf8') };
    },
    async readAsStringAsync(path) {
      events.push(['read', path]);
      if (options.failRead === path) throw new Error('storage read failed');
      if (!files.has(path)) throw new Error('missing file');
      return files.get(path);
    },
    async makeDirectoryAsync() {},
    async writeAsStringAsync(path, raw) {
      events.push(['write', path]);
      files.set(path, options.failWrite ? raw.slice(0, 20) : raw);
      if (options.failWrite) throw new Error('write interrupted');
    },
    async moveAsync({ from, to }) {
      events.push(['move', from, to]);
      // Model Expo iOS's destructive destination removal, including failure
      // immediately after removal. A safe protocol always has another copy.
      files.delete(to);
      if (options.failMove === from) throw new Error('move interrupted');
      assert.ok(files.has(from));
      files.set(to, files.get(from));
      files.delete(from);
      await options.afterMove?.(from, to);
    },
    async deleteAsync(path) { events.push(['delete', path]); files.delete(path); },
  };
  function reopen() {
    const exports = {};
    runInNewContext(serviceSource, { exports, Error, require(name) {
      if (name === 'expo-file-system/legacy') return fs;
      if (name === '@/lib/keyed-operation-queue') return { createKeyedOperationQueue };
      throw new Error(`Unexpected dependency: ${name}`);
    } });
    return exports;
  }
  const journal = reopen();
  return { files, events, journal, reopen,
    write: (payload) => journal.writeEditorDraftJournal('project', 'caption-script', 'base', payload),
    read: () => journal.readEditorDraftJournal('project', 'caption-script') };
}

for (const character of ['\u4e2d', '\ud83d\ude00', '\u00e9', '\ud800']) {
  test(`serialized UTF-8 threshold and reopen for ${JSON.stringify(character)}`, async () => {
    const h = harness();
    const budget = h.journal.MAX_JOURNAL_BYTES - Buffer.byteLength(envelope(''));
    const unitBytes = Buffer.byteLength(JSON.stringify(character)) - 2;
    const payload = character.repeat(Math.floor(budget / unitBytes)) + 'a'.repeat(budget % unitBytes);
    assert.equal(Buffer.byteLength(envelope(payload)), h.journal.MAX_JOURNAL_BYTES);
    await h.write(payload);
    assert.equal(Buffer.byteLength(h.files.get(uri)), h.journal.MAX_JOURNAL_BYTES);
    assert.equal((await h.reopen().readEditorDraftJournal('project', 'caption-script')).payload, payload);
    const previous = h.files.get(uri);
    const writes = h.events.length;
    await assert.rejects(h.write(payload + 'a'), { code: 'oversized' });
    assert.equal(h.events.length, writes, 'reject before any file operation');
    assert.equal(h.files.get(uri), previous);
  });
}

test('1.5 million Chinese characters cannot replace a valid recovery draft', async () => {
  const h = harness();
  await h.write('previous edits');
  const previous = h.files.get(uri);
  await assert.rejects(h.write('\u4e2d'.repeat(1_500_000)), { code: 'oversized' });
  assert.equal(h.files.get(uri), previous);
  assert.equal((await h.read()).payload, 'previous edits');
});

for (const omitSize of [false, true]) {
  test(`existing oversized journal reports reason and is preserved (missing stat size: ${omitSize})`, async () => {
    const h = harness({ omitSize });
    const raw = envelope('\u4e2d'.repeat(1_500_000));
    h.files.set(uri, raw);
    await assert.rejects(h.read(), { code: 'oversized' });
    if (!omitSize) assert.equal(h.events.length, 0, 'reject stat size before allocating file contents');
    await assert.rejects(h.write('new edits'), { code: 'oversized' });
    assert.equal(h.files.get(uri), raw);
  });
}

test('only missing is null; corrupt, incompatible and unavailable are errors', async () => {
  const h = harness();
  assert.equal(await h.read(), null);
  for (const raw of ['{broken', 'null', '{}', envelope('text').replace('"project"', '"another"')]) {
    h.files.set(uri, raw);
    await assert.rejects(h.read(), { code: 'corrupt' });
    await assert.rejects(h.write('new'), { code: 'corrupt' });
    assert.equal(h.files.get(uri), raw);
  }
  await assert.rejects(harness({ unavailable: true }).read(), { code: 'unavailable' });
});

for (const problem of ['corrupt', 'oversized', 'unavailable']) {
  test(`${problem} primary recovers previous with provenance and cannot replace either file`, async () => {
    const h = harness(problem === 'unavailable' ? { failRead: uri } : {});
    const raw = problem === 'oversized' ? envelope('\u4e2d'.repeat(1_500_000)) : '{broken';
    h.files.set(uri, raw);
    h.files.set(`${uri}.previous`, envelope('backup typing'));
    const before = [...h.files];
    const recovered = await h.read();
    assert.equal(recovered.payload, 'backup typing');
    assert.equal(recovered.recovery.source, 'previous');
    assert.equal(recovered.recovery.failures[0].source, 'primary');
    assert.equal(recovered.recovery.failures[0].code, problem);
    assert.match(recovered.recovery.warning, /\.previous backup/);
    assert.match(recovered.recovery.warning, /preserved/);
    await assert.rejects(h.write('new typing'), { code: problem });
    assert.deepEqual([...h.files], before);
    assert.equal(h.events.some(([event]) => ['write', 'move', 'delete'].includes(event)), false);
    if (problem === 'oversized') assert.equal(h.events.some(([event, path]) => event === 'read' && path === uri), false);
  });
}

test('malformed copies report both structured reasons and preserve both files', async () => {
  const h = harness();
  h.files.set(uri, '{broken primary');
  h.files.set(`${uri}.previous`, '{broken previous');
  const before = [...h.files];
  for (const operation of [h.read, () => h.write('new')]) {
    await assert.rejects(operation(), (error) => {
      assert.equal(error.code, 'corrupt');
      assert.deepEqual(Array.from(error.reasons, ({ source, code }) => [source, code]), [['primary', 'corrupt'], ['previous', 'corrupt']]);
      assert.match(error.message, /Neither recovery copy/);
      return true;
    });
  }
  assert.deepEqual([...h.files], before);
});

test('a valid primary does not authorize deleting an unreadable previous copy', async () => {
  const h = harness();
  h.files.set(uri, envelope('primary typing'));
  h.files.set(`${uri}.previous`, '{broken');
  const before = [...h.files];
  const recovered = await h.read();
  assert.equal(recovered.payload, 'primary typing');
  assert.equal(recovered.recovery.source, 'primary');
  assert.equal(recovered.recovery.failures[0].source, 'previous');
  await assert.rejects(h.write('new'), { code: 'corrupt' });
  assert.deepEqual([...h.files], before);
});

test('missing primary uses previous with an explicit interruption warning and permits safe retry', async () => {
  const h = harness();
  h.files.set(`${uri}.previous`, envelope('backup typing'));
  const recovered = await h.read();
  assert.equal(recovered.recovery.source, 'previous');
  assert.equal(recovered.recovery.failures.length, 0);
  assert.match(recovered.recovery.warning, /\.previous backup/);
  await h.write('retry');
  assert.equal((await h.read()).payload, 'retry');
});

test('replacement is old-or-new at each move boundary, including a fresh service', async () => {
  const options = {};
  const h = harness(options);
  await h.write('old');
  const observed = [];
  options.afterMove = async () => {
    observed.push((await h.reopen().readEditorDraftJournal('project', 'caption-script')).payload);
  };
  await h.write('new');
  assert.deepEqual(observed, ['old', 'new']);
  assert.equal((await h.reopen().readEditorDraftJournal('project', 'caption-script')).payload, 'new');
  assert.equal(h.files.size, 1);
});

for (const failure of ['stage', 'retain', 'publish']) {
  test(`${failure} interruption retains the last valid draft across restart and retry`, async () => {
    const options = {};
    const h = harness(options);
    await h.write('old');
    if (failure === 'stage') options.failWrite = true;
    else options.failMove = failure === 'retain' ? uri : `${uri}.writing`;
    await assert.rejects(h.write('new'), /interrupted/);
    assert.equal((await h.reopen().readEditorDraftJournal('project', 'caption-script')).payload, 'old');
    options.failWrite = false;
    options.failMove = undefined;
    await h.write('retry');
    assert.equal((await h.read()).payload, 'retry');
  });
}

test('explicit clear removes fallback before primary so it cannot resurrect on reopen', async () => {
  const h = harness();
  h.files.set(uri, envelope('new'));
  h.files.set(`${uri}.previous`, envelope('old'));
  await h.journal.clearEditorDraftJournal('project', 'caption-script');
  assert.equal(await h.read(), null);
  assert.deepEqual(h.events.filter(([event]) => event === 'delete').map(([, path]) => path), [`${uri}.previous`, uri]);
});

// Minimal deterministic hooks execute the real recovery effects and close paths.
// Rendering remains synthetic; no native runtime or device is needed.
async function mountEditor(kind, options = {}) {
  const slots = [], effects = [], alerts = [], timers = new Map();
  let nextTimer = 0;
  let cursor = 0, changed = true, closeRequest;
  const calls = { writes: 0, clears: 0, closes: 0, saves: 0 };
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const memo = (fn, deps) => {
    const index = cursor++;
    if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { value: fn(), deps };
    return slots[index].value;
  };
  const effect = (fn, deps) => {
    const index = cursor++;
    if (!slots[index] || !same(slots[index].deps, deps)) {
      effects.push(() => {
        slots[index]?.cleanup?.();
        slots[index] = { deps, cleanup: fn() };
      });
    }
  };
  const react = {
    memo: (fn) => fn, useMemo: memo, useCallback: (fn, deps) => memo(() => fn, deps),
    useRef: (value) => memo(() => ({ current: value }), []),
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (value) => {
        const next = typeof value === 'function' ? value(slots[index].value) : value;
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; changed = true; }
      }];
    },
    useEffect: effect, useLayoutEffect: effect,
    useSyncExternalStore: (_subscribe, get) => get(),
    createContext: (value) => ({ value }), useContext: (context) => context.value,
  };
  const jsx = (type, props) => ({ type, props });
  const exports = {};
  runInNewContext(editorSources[kind], { exports, Error,
    setTimeout: (fn) => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: (id) => timers.delete(id),
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === 'react-native') return {
        ...Object.fromEntries(['View', 'Text', 'TextInput', 'Pressable', 'Modal', 'FlatList', 'KeyboardAvoidingView'].map((v) => [v, v])),
        Keyboard: { isVisible: () => false, addListener: () => ({ remove() {} }) },
        Platform: { OS: 'android' }, Alert: { alert: (...args) => alerts.push(args) },
      };
      if (name === 'react-native-safe-area-context') return { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) };
      if (name === '@/lib/ui-theme') return { chrome: { radius: {} } };
      if (name === '@/lib/caption-script') return scriptHelpers;
      if (name === '@/lib/dual-caption-drafts') return dualHelpers;
      if (name === '@/services/editor-draft-journal') return {
        readEditorDraftJournal: async (...args) => {
          if (options.error) throw options.error;
          return options.service ? options.service.readEditorDraftJournal(...args) : options.journal;
        },
        writeEditorDraftJournal: async (...args) => { calls.writes++; await options.service?.writeEditorDraftJournal(...args); },
        clearEditorDraftJournal: async (...args) => { calls.clears++; await options.service?.clearEditorDraftJournal(...args); },
      };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  const props = { visible: true, projectId: 'project', baseRevision: 'base', captions: options.captions ?? [], words: [], pairs: options.pairs ?? [],
    trackId: 'zh', currentMs: 0, onDraftChange() {}, onKeyboardChange() {}, onEditingCaptionChange() {},
    onSelectCaption() {}, onSeekTimeline() {}, onBackRequestChange: (fn) => { closeRequest = fn; },
    onCancel: () => { calls.closes++; }, onClose: () => { calls.closes++; },
    onSave: async () => { calls.saves++; return true; } };
  let tree;
  async function settle() {
    for (let pass = 0; pass < 8; pass++) {
      if (changed) {
        changed = false; cursor = 0;
        tree = (kind === 'script' ? exports.ScriptEditor : exports.Session)(props);
        while (effects.length) effects.shift()();
      }
      await new Promise(setImmediate);
    }
  }
  function find(predicate, node = tree) {
    if (!node || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) return node.map((child) => find(predicate, child ?? null)).find(Boolean);
    return predicate(node) ? node : find(predicate, node.props?.children ?? null);
  }
  const list = () => find((node) => node.type === 'FlatList').props;
  const row = () => list().renderItem({ item: list().data[0], index: 0 });
  await settle();
  return { calls, alerts, timers, get tree() { return tree; },
    draft: () => kind === 'script' ? list().data : row().props.store.snapshot(),
    async edit(value) {
      if (kind === 'script') find((node) => node.type === 'TextInput', row()).props.onChangeText(value);
      else row().props.store.setDraft('cue', 'primaryText', value);
      changed = true; await settle();
    },
    async choose(label) {
      const choice = alerts.at(-1)?.[2].find((entry) => entry.text === label);
      assert.ok(choice, `missing alert choice: ${label}`);
      choice.onPress?.(); await settle();
    },
    async save() {
      const button = find((node) => node.props?.accessibilityLabel === (kind === 'script' ? 'Save all caption edits' : 'Save dual subtitle edits'));
      assert.equal(!!button.props.disabled, false);
      button.props.onPress(); await settle();
    },
    async drainTimers() {
      for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
      await settle();
    },
    close: async () => { closeRequest(); await settle(); } };
}

for (const kind of ['script', 'dual']) {
  for (const code of ['oversized', 'corrupt']) {
    test(`${kind} UI exposes ${code}, pauses autosave and closes without deleting recovery`, async () => {
      const h = harness();
      const error = new h.journal.EditorDraftJournalError(code, `Recovery reason: ${code}`);
      const editor = await mountEditor(kind, { error });
      assert.ok(JSON.stringify(editor.tree).includes(error.message));
      assert.equal(editor.timers.size, 0);
      await editor.close();
      assert.deepEqual(editor.calls, { writes: 0, clears: 0, closes: 1, saves: 0 });
    });
  }
}

const cue = { id: 'cue', text: 'Source', startMs: 0, endMs: 1000, wordIds: [] };
const pair = { source: cue, translation: { text: 'Translation', status: 'translated' } };
for (const kind of ['script', 'dual']) {
  const draftKind = kind === 'script' ? 'caption-script' : 'dual-captions-zh';
  const path = uri.replace('caption-script', draftKind);
  const recoveredPayload = kind === 'script' ? [{ ...cue, text: 'Recovered typing' }]
    : { cue: { primaryText: 'Recovered typing', translatedText: 'Translation' } };
  for (const action of ['save', 'discard', 'keep current', 'unchanged']) {
    test(`${kind} fallback ${action} surfaces provenance and retains unread files`, async () => {
      const h = harness();
      h.files.set(path, '{broken primary');
      const payload = action === 'unchanged' ? (kind === 'script' ? [cue] : { cue: { primaryText: 'Source', translatedText: 'Translation' } }) : recoveredPayload;
      h.files.set(`${path}.previous`, envelope(payload, draftKind));
      const before = [...h.files];
      const editor = await mountEditor(kind, { service: h.journal, captions: [cue], pairs: [pair] });
      assert.ok(JSON.stringify(editor.tree).includes('.previous backup'));
      if (editor.alerts.length) {
        assert.match(editor.alerts[0][1], /\.previous backup/);
        await editor.choose(action === 'keep current' ? (kind === 'script' ? 'Keep current captions' : 'Keep current translation')
          : kind === 'script' ? 'Restore' : 'Restore unsaved typing');
      }
      if (action === 'save' || action === 'discard') {
        assert.ok(JSON.stringify(editor.draft()).includes('Recovered typing'));
        await editor.edit('Current typing');
      }
      await editor.drainTimers();
      assert.equal(editor.calls.writes, 0);
      if (action === 'save') { await editor.save(); assert.equal(editor.calls.saves, 1); }
      else {
        await editor.close();
        if (action === 'discard') {
          assert.equal(editor.calls.closes, 0);
          await editor.choose('Keep editing');
          assert.ok(JSON.stringify(editor.draft()).includes('Current typing'));
          await editor.close(); await editor.choose('Discard');
        }
        assert.equal(editor.calls.closes, 1);
      }
      assert.equal(editor.calls.clears, 0);
      assert.deepEqual([...h.files], before);
    });
  }
  for (const typed of ['Current typing', '   ', '']) {
    test(`${kind} malformed recovery close requires a decision for ${JSON.stringify(typed)}`, async () => {
      const h = harness();
      h.files.set(path, '{bad primary');
      h.files.set(`${path}.previous`, '{bad previous');
      const before = [...h.files];
      const editor = await mountEditor(kind, { service: h.journal, captions: [cue], pairs: [pair] });
      assert.ok(JSON.stringify(editor.tree).includes('Neither recovery copy'));
      await editor.edit(typed);
      const draft = JSON.stringify(editor.draft());
      await editor.close();
      assert.equal(editor.calls.closes, 0);
      assert.match(editor.alerts.at(-1)[1], /preserved/);
      await editor.choose('Keep editing');
      assert.equal(editor.calls.closes, 0);
      assert.equal(JSON.stringify(editor.draft()), draft);
      await editor.drainTimers();
      await editor.close(); await editor.choose('Discard');
      assert.deepEqual(editor.calls, { writes: 0, clears: 0, closes: 1, saves: 0 });
      assert.deepEqual([...h.files], before);
    });
  }
}
