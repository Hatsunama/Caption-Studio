import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as scriptDrafts from '../src/lib/caption-script.ts';
import * as dualDrafts from '../src/lib/dual-caption-drafts.ts';
import { createEditorSession } from '../src/services/editor-session.ts';

const root = new URL('../src/components/editor/', import.meta.url);
const compile = (source) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function helper() {
  const path = new URL('caption-save-recovery.ts', root);
  if (!existsSync(path)) return {};
  const exports = {};
  runInNewContext(compile(readFileSync(path, 'utf8')), { exports });
  return exports;
}
const sources = Object.fromEntries(['script', 'dual-caption'].map((kind) => {
  const source = readFileSync(new URL(`${kind}-editor.tsx`, root), 'utf8');
  return [kind, ts.createSourceFile(`${kind}.tsx`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)];
}));
function expression(kind, name, context) {
  const ast = sources[kind];
  const component = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === (kind === 'script' ? 'ScriptEditor' : 'DualCaptionEditorSession'));
  const declaration = component.body.statements.filter(ts.isVariableStatement).flatMap((node) => [...node.declarationList.declarations]).find((node) => node.name.getText(ast) === name);
  let node = declaration.initializer;
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useCallback') node = node.arguments[0];
  return runInNewContext(compile(`(${node.getText(ast)})`), context);
}
function journalEffect(kind, context) {
  const ast = sources[kind];
  const component = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === (kind === 'script' ? 'ScriptEditor' : 'DualCaptionEditorSession'));
  const effect = component.body.statements.find((node) => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === 'useEffect' && node.expression.arguments[0].getText(ast).includes('writeEditorDraftJournal'));
  return runInNewContext(compile(`(${effect.expression.arguments[0].getText(ast)})`), context)();
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function mount(kind) {
  const alerts = [], timers = new Map();
  let saveCalls = 0, clearCalls = 0, closes = 0, restart = 0, journal = 'unsaved', clearFailure = true, saveResult = true;
  const context = {
    ...scriptDrafts, ...dualDrafts, ...helper(),
    Error, Promise,
    saving: false, closing: false, disabled: false, journalReady: true, journalProtected: false,
    projectId: 'p', journalKind: 'dual-captions-fr', openingRevision: 'r', sourceRevision: 'r',
    sourceCaptions: [{ id: 'c', text: 'Original', startMs: 0, endMs: 1000 }],
    draftCaptions: [{ id: 'c', text: 'Edited', startMs: 0, endMs: 1000 }],
    draftVersionRef: { current: 1 }, acceptedDraftRef: { current: undefined },
    sessionRef: { current: { visible: true } }, recoveryActiveRef: { current: true },
    cleanupPendingRef: { current: false }, stopJournalRef: { current: undefined },
    journalQueueRef: { current: helper().createCaptionJournalQueue?.() },
    Alert: { alert: (...args) => alerts.push(args) },
    setSaving: (value) => { context.saving = value; }, setClosing: (value) => { context.closing = value; },
    setSaveError: (value) => { context.saveError = value; }, setJournalError: (value) => { context.journalError = value; },
    setJournalRestart: () => { restart++; }, setCleanupPending: (value) => { context.cleanupPending = value; },
    focusCaption: () => {}, setEmptyCaptionId: () => {},
    onCancel: () => { closes++; },
    setTimeout: (callback) => { const key = {}; timers.set(key, callback); return key; },
    clearTimeout: (key) => timers.delete(key),
    clearEditorDraftJournal: async () => { clearCalls++; if (clearFailure) throw new Error('disk cleanup failed'); journal = undefined; },
    writeEditorDraftJournal: async (_project, _kind, _revision, payload) => { journal = payload; },
    props: { visible: true, projectId: 'p', busy: false, pairs: [{ source: { id: 'c' } }],
      onSave: async () => { saveCalls++; if (saveResult instanceof Error) throw saveResult; return saveResult; },
      onCancel: () => { closes++; } },
  };
  if (kind === 'dual-caption') {
    const ast = sources[kind];
    const store = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name.text === 'DualCaptionDraftStore');
    const Store = runInNewContext(compile(`${store.getText(ast)}; DualCaptionDraftStore`), context);
    context.store = new Store({ c: { primaryText: 'Original', translatedText: 'Bonjour' } });
    context.store.setDraft('c', 'primaryText', 'Edited');
  }
  // These are the production callbacks, executed with storage faults and real draft logic.
  try { context.retryCleanup = expression(kind, 'retryCleanup', context); } catch { /* absent on the failing baseline */ }
  const save = expression(kind, 'save', context);
  return { context, alerts, timers, save,
    effect: () => journalEffect(kind, context),
    flushTimers: () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((callback) => callback()); },
    get saveCalls() { return saveCalls; }, get clearCalls() { return clearCalls; }, get closes() { return closes; },
    get restart() { return restart; }, get journal() { return journal; },
    set clearFailure(value) { clearFailure = value; }, set saveResult(value) { saveResult = value; },
  };
}

test('journal queue drains active writes, invalidates queued writes, and never resurrects data after clear', async () => {
  const queue = helper().createCaptionJournalQueue();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let journal;
  const events = [];
  queue.resume();
  const active = queue.write(async () => { events.push('active'); await blocked; journal = 'old'; });
  await settle();
  const stale = queue.write(async () => { events.push('stale'); journal = 'stale'; });
  const clear = queue.clear(async () => { events.push('clear'); journal = undefined; });
  assert.deepEqual(events, ['active']);
  release(); await Promise.all([active, stale, clear]);
  assert.deepEqual(events, ['active', 'clear']); assert.equal(journal, undefined);
  queue.resume();
  await queue.write(async () => { journal = 'new unsaved edits'; });
  assert.equal(journal, 'new unsaved edits');
});

test('journal queue still clears after a failed active write and rechecks newer edits at the storage boundary', async () => {
  const queue = helper().createCaptionJournalQueue();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let current = true, cleared = false;
  queue.resume();
  const write = queue.write(async () => { await blocked; throw new Error('write failed'); });
  const rejection = assert.rejects(write, /write failed/);
  await settle();
  const clear = queue.clear(async () => { cleared = true; }, () => current);
  current = false; release(); await rejection;
  assert.equal(await clear, false); assert.equal(cleared, false);
  current = true;
  assert.equal(await queue.clear(async () => { cleared = true; }, () => current), true);
  assert.equal(cleared, true);
});

test('dual accepted save preserves newer keystrokes and incoming generation text in unsubmitted fields', async () => {
  const h = mount('dual-caption');
  let accept;
  h.context.props.onSave = () => new Promise((resolve) => { accept = resolve; });
  const saving = h.save();
  h.context.store.setDraft('c', 'primaryText', 'Newer keystroke');
  h.context.store.reconcile({ c: { primaryText: 'Original', translatedText: 'New translation' } });
  accept(true); await saving;
  assert.equal(h.context.store.getDraft('c').primaryText, 'Newer keystroke');
  assert.equal(h.context.store.getDraft('c').translatedText, 'New translation');
  assert.equal(h.context.store.committed.c.primaryText, 'Edited');
  assert.equal(h.context.store.getDirtyCount(), 1);
  assert.equal(h.clearCalls, 0, 'new unsaved edits retain recovery');
});

for (const kind of ['script', 'dual-caption']) test(`${kind}: thrown save keeps recovery and restarts journaling`, async () => {
  const h = mount(kind); h.saveResult = new Error('project disk write failed');
  await h.save();
  assert.match(h.context.saveError, /project disk write failed/);
  assert.equal(h.clearCalls, 0); assert.equal(h.journal, 'unsaved'); assert.ok(h.restart > 0);
});

for (const kind of ['script', 'dual-caption']) test(`${kind}: a cleanup retry from a closed session cannot clear a reopened session's recovery`, async () => {
  const h = mount(kind); await h.save();
  const retry = h.alerts.find(([title]) => /changes saved/i.test(title))[2].find((button) => /retry.*cleanup/i.test(button.text));
  h.context.sessionRef.current.visible = false;
  h.context.recoveryActiveRef.current = false;
  h.clearFailure = false;
  await retry.onPress(); await settle();
  assert.equal(h.clearCalls, 1);
});

test('script: returning to the old source after an accepted save journals the new unsaved revision', async () => {
  const h = mount('script'); h.clearFailure = false;
  await h.save();
  h.context.draftCaptions = h.context.sourceCaptions;
  h.context.draftVersionRef.current++;
  h.effect(); h.flushTimers(); await settle();
  assert.equal(h.journal[0].text, 'Original');
});

test('script: acceptance of an older snapshot preserves newer typing and recovery', async () => {
  const h = mount('script');
  let accept;
  h.context.props.onSave = () => new Promise((resolve) => { accept = resolve; });
  const saving = h.save();
  h.context.draftVersionRef.current++;
  h.context.draftCaptions = [{ ...h.context.draftCaptions[0], text: 'Newer typing' }];
  accept(true); await saving;
  assert.match(h.context.saveError, /submitted changes were saved.*newer caption edits are still unsaved/i);
  assert.equal(h.clearCalls, 0); assert.equal(h.closes, 0);
  h.effect(); h.flushTimers(); await settle();
  assert.equal(h.journal[0].text, 'Newer typing');
});

test('generation audit: session checkpoints newer accepted edits after a stale generation persistence', async () => {
  const original = { id: 'p', captions: [{ id: 'c', text: 'Original' }] };
  const accepted = { ...original, captions: [{ id: 'c', text: 'Accepted manual edit' }] };
  let disk = original, published = original, complete;
  const session = createEditorSession(original, (next) => { published = next; }, async (next) => { disk = next; return next; });
  const generation = session.commit(async (before) => {
    await new Promise((resolve) => { complete = resolve; });
    disk = { ...before, captions: [{ id: 'c', text: 'Generated stale text' }] };
    return disk;
  }, true);
  const rejection = assert.rejects(generation, /project changed.*newer edits were kept/i);
  await settle();
  disk = accepted; session.update(accepted);
  complete(); await rejection;
  assert.equal(session.current(), accepted); assert.equal(published, accepted); assert.equal(disk, accepted);
});

for (const kind of ['script', 'dual-caption']) {
  test(`${kind}: durable save plus cleanup failure reports saved and retries cleanup only`, async () => {
    const h = mount(kind);
    await h.save();
    assert.equal(h.context.saveError, undefined, 'cleanup must never become a save error');
    const alert = h.alerts.find(([title]) => /changes saved/i.test(title));
    assert.ok(alert, 'accepted save must truthfully report recovery cleanup failure');
    assert.match(alert[1], /recovery.*cleanup.*failed/i);
    const retry = alert[2].find((button) => /retry.*cleanup/i.test(button.text));
    assert.ok(retry);
    h.clearFailure = false;
    await retry.onPress(); await settle();
    assert.equal(h.saveCalls, 1); assert.equal(h.clearCalls, 2); assert.equal(h.journal, undefined);
    if (kind === 'script') assert.equal(h.closes, 1);
    else assert.equal(h.context.store.getDirtyCount(), 0, 'accepted edits no longer invite a second project save');
  });
  test(`${kind}: failed project save retains edits and recovery, and resumes scheduling`, async () => {
    const h = mount(kind); h.saveResult = false;
    const dispose = h.effect();
    await h.save();
    assert.equal(h.clearCalls, 0); assert.equal(h.journal, 'unsaved');
    assert.ok(h.context.saveError);
    assert.ok(h.restart > 0, 'a batched saving true/false must still restart the stopped journal effect');
    dispose?.(); h.effect(); h.flushTimers(); await settle();
    assert.notEqual(h.journal, 'unsaved');
    if (kind === 'dual-caption') assert.equal(h.context.store.getDirtyCount(), 1);
    else assert.equal(h.context.draftCaptions[0].text, 'Edited');
  });
  test(`${kind}: accepted snapshot is not re-journaled after successful cleanup`, async () => {
    const h = mount(kind); h.clearFailure = false;
    const dispose = h.effect();
    await h.save(); dispose?.();
    h.effect(); h.flushTimers(); await settle();
    assert.equal(h.journal, undefined, 'later effect/timer must not resurrect the accepted draft');
  });
  test(`${kind}: delayed cleanup retry preserves newer unsaved text`, async () => {
    const h = mount(kind); await h.save();
    const alert = h.alerts.find(([title]) => /changes saved/i.test(title));
    assert.ok(alert);
    if (kind === 'script') {
      h.context.draftVersionRef.current++;
      h.context.draftCaptions = [{ ...h.context.draftCaptions[0], text: 'Newer' }];
    } else h.context.store.setDraft('c', 'primaryText', 'Newer');
    h.clearFailure = false;
    await alert[2].find((button) => /retry.*cleanup/i.test(button.text)).onPress(); await settle();
    assert.equal(h.clearCalls, 1, 'old retry cannot delete recovery for new edits');
    assert.equal(h.saveCalls, 1);
  });
}
