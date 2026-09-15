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
const envelope = (payload) => JSON.stringify({ schemaVersion: 1, projectId: 'project', kind: 'caption-script',
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
async function mountRejectedEditor(kind, error) {
  const slots = [], effects = [], timers = [];
  let cursor = 0, changed = true, closeRequest;
  const calls = { writes: 0, clears: 0, closes: 0 };
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const memo = (fn, deps) => {
    const index = cursor++;
    if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { value: fn(), deps };
    return slots[index].value;
  };
  const effect = (fn, deps) => {
    const index = cursor++;
    if (!slots[index] || !same(slots[index].deps, deps)) {
      slots[index] = { deps };
      effects.push(fn);
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
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === 'react-native') return {
        ...Object.fromEntries(['View', 'Text', 'TextInput', 'Pressable', 'Modal', 'FlatList', 'KeyboardAvoidingView'].map((v) => [v, v])),
        Keyboard: { isVisible: () => false, addListener: () => ({ remove() {} }) },
        Platform: { OS: 'android' }, Alert: { alert() {} },
      };
      if (name === 'react-native-safe-area-context') return { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) };
      if (name === '@/lib/ui-theme') return { chrome: { radius: {} } };
      if (name === '@/lib/caption-script') return scriptHelpers;
      if (name === '@/lib/dual-caption-drafts') return dualHelpers;
      if (name === '@/services/editor-draft-journal') return {
        readEditorDraftJournal: async () => { throw error; },
        writeEditorDraftJournal: async () => { calls.writes++; },
        clearEditorDraftJournal: async () => { calls.clears++; },
      };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  const props = { visible: true, projectId: 'project', baseRevision: 'base', captions: [], words: [], pairs: [],
    trackId: 'zh', currentMs: 0, onDraftChange() {}, onKeyboardChange() {}, onEditingCaptionChange() {},
    onSelectCaption() {}, onSeekTimeline() {}, onBackRequestChange: (fn) => { closeRequest = fn; },
    onCancel: () => { calls.closes++; }, onClose: () => { calls.closes++; } };
  let tree;
  for (let pass = 0; pass < 8; pass++) {
    if (changed) {
      changed = false; cursor = 0;
      tree = (kind === 'script' ? exports.ScriptEditor : exports.Session)(props);
      while (effects.length) effects.shift()();
    }
    await new Promise(setImmediate);
  }
  return { calls, tree, timers, close: async () => { closeRequest(); await new Promise(setImmediate); } };
}

for (const kind of ['script', 'dual']) {
  for (const code of ['oversized', 'corrupt']) {
    test(`${kind} UI exposes ${code}, pauses autosave and closes without deleting recovery`, async () => {
      const h = harness();
      const error = new h.journal.EditorDraftJournalError(code, `Recovery reason: ${code}`);
      const editor = await mountRejectedEditor(kind, error);
      assert.ok(JSON.stringify(editor.tree).includes(error.message));
      assert.equal(editor.timers.length, 0);
      await editor.close();
      assert.deepEqual(editor.calls, { writes: 0, clears: 0, closes: 1 });
    });
  }
}
