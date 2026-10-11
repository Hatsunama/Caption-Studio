import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const { resolveCaptionPairs, createTranslationCaptionTrack } = await import('../src/lib/caption-tracks.ts');
const { createCaptionProject } = await import('../src/lib/project-factory.ts');

// Execute the actual editor derivations/JSX prop, without a native app mount.
const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('editor.tsx', editor, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
let dualPairs, voiceoverBackEffect;
function visit(node) {
  if (ts.isExpressionStatement(node) && node.getText(ast).startsWith('useEffect(')
    && node.getText(ast).includes('const closeVoiceover =')) voiceoverBackEffect = node.getText(ast);
  if (ts.isVariableStatement(node)) for (const d of node.declarationList.declarations) {
    if (ts.isIdentifier(d.name)) declarations.set(d.name.text, node.getText(ast));
  }
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'DualCaptionEditor') {
    dualPairs = node.attributes.properties.find(p => p.name?.getText(ast) === 'pairs').initializer.expression.getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
const compile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const plain = value => JSON.parse(JSON.stringify(value));

function captionHost() {
  const slots = [];
  let cursor, calls = [];
  const names = ['resolvedTranslationPairsByTrack', 'translationTimelineTracks', 'selectedTranslationTrack',
    'selectedTranslationPairs', 'selectedTranslationEditorPairs'];
  const code = compile(names.filter(n => declarations.has(n)).map(n => declarations.get(n)).join('\n')
    + `\nresult = { timeline: translationTimelineTracks, selected: selectedTranslationPairs, editor: ${dualPairs} };`);
  return {
    render(project, selectedTranslationTrackId) {
      cursor = 0;
      const scope = { project, selectedTranslationTrackId, resolveCaptionPairs(p, id) {
        calls.push(id); return resolveCaptionPairs(p, id);
      }, useMemo(fn, deps) {
        const i = cursor++;
        if (!same(slots[i]?.deps, deps)) slots[i] = { deps, value: fn() };
        return slots[i].value;
      }, result: undefined };
      runInNewContext(code, scope);
      return scope.result;
    },
    get calls() { return calls; },
  };
}
function fixture() {
  let p = createCaptionProject({ id: 'runtime-project', name: 'Runtime', sources: [{
    id: 'video', uri: 'file:///video.mp4', displayName: 'video', durationMs: 6000,
    width: 1920, height: 1080, rotation: 0, frameRate: 30,
  }] });
  p = { ...p, captions: ['manual', 'reviewed', 'skipped', 'hidden', 'fallback'].map((id, i) => ({
    id, text: `Source ${id}`, textMode: 'manual', startMs: i * 1000, endMs: i * 1000 + 800,
    wordIds: [], timelineVisible: id !== 'hidden', styleOverride: { textColor: '#123456' },
  })) };
  p = createTranslationCaptionTrack(p, { id: 'zh', languageTag: 'zh-Hans', displayName: 'Chinese',
    translations: { manual: 'Manual', reviewed: 'Reviewed', skipped: 'Skipped', hidden: 'Hidden' },
    styleOverride: { fontSize: 42 }, stackGap: 0.05 });
  p = createTranslationCaptionTrack(p, { id: 'es', languageTag: 'es', displayName: 'Spanish', visible: false });
  return { ...p, captionTracks: { ...p.captionTracks, translations: p.captionTracks.translations.map(t => ({ ...t,
    cues: t.cues.map(c => ({ ...c, status: c.sourceCaptionId === 'reviewed' ? 'reviewed'
      : c.sourceCaptionId === 'fallback' ? 'failed' : c.status,
      reviewed: c.sourceCaptionId === 'reviewed', translationSkipped: c.sourceCaptionId === 'skipped',
      ...(c.sourceCaptionId === 'manual' ? { startMs: 120, endMs: 740, styleOverride: { textColor: '#abcdef', position: { x: 0.3, y: 0.4 } } } : {}),
    })),
  })) } };
}
function expected(project, id) {
  const base = resolveCaptionPairs(project, id);
  return { selected: base.filter(p => p.timelineVisible), editor: base.filter(p => p.timelineVisible
    || (p.translation.translationSkipped && (p.translation.timelineVisible ?? p.source.timelineVisible !== false))) };
}
test('editor resolves one base per track/revision and reuses it across selected consumers and track switches', () => {
  const p = fixture(), host = captionHost(), before = structuredClone(p);
  const a = host.render(p, 'zh');
  assert.deepEqual(plain(a.selected), plain(expected(p, 'zh').selected));
  assert.deepEqual(plain(a.editor), plain(expected(p, 'zh').editor));
  assert.deepEqual(p, before);
  assert.deepEqual(host.calls, ['zh', 'es'], 'selected timeline and dual editor must reuse base resolution');
  assert.strictEqual(a.selected[0], a.editor[0]);
  assert.strictEqual(a.selected[0], a.timeline[0].pairs[0]);
  const b = host.render(p, 'es');
  assert.deepEqual(plain(b.selected), plain(expected(p, 'es').selected));
  host.render(p, 'zh'); host.render(p, undefined);
  assert.deepEqual(host.calls, ['zh', 'es'], 'track switches and host rerenders must not re-resolve');
  const revised = { ...p, projectStyle: { ...p.projectStyle, fontSize: 60 }, captions: p.captions.map(c => ({ ...c, endMs: c.endMs + 200 })) };
  const c = host.render(revised, 'zh');
  assert.deepEqual(plain(c.editor), plain(expected(revised, 'zh').editor));
  assert.deepEqual(host.calls, ['zh', 'es', 'zh', 'es']);
  assert.notStrictEqual(c.editor[0], a.editor[0]);
});
test('different filters retain skipped editing, hidden overrides, styles, timing, manual/reviewed/fallback and visibility', () => {
  const p = fixture(), host = captionHost();
  const a = host.render(p, 'zh');
  assert.deepEqual(Array.from(a.selected, p => p.source.id), ['manual', 'reviewed', 'fallback']);
  assert.deepEqual(Array.from(a.editor, p => p.source.id), ['manual', 'reviewed', 'skipped', 'fallback']);
  assert.equal(a.selected[0].startMs, 120); assert.equal(a.selected[0].endMs, 740);
  assert.equal(a.selected[0].style.textColor, '#abcdef');
  assert.deepEqual(plain(a.selected[0].style.position), { x: 0.3, y: 0.4 });
  assert.equal(a.selected[1].translation.reviewed, true);
  assert.equal(a.selected[2].displayProvenance, 'source-fallback');
  assert.equal(a.timeline[1].visible, false);
  const revised = { ...p, captionTracks: { ...p.captionTracks, translations: p.captionTracks.translations.map(t => ({ ...t,
    cues: t.cues.map(c => c.sourceCaptionId === 'skipped' ? { ...c, timelineVisible: false }
      : c.sourceCaptionId === 'hidden' ? { ...c, timelineVisible: true } : c),
  })) } };
  assert.deepEqual(plain(host.render(revised, 'zh').editor), plain(expected(revised, 'zh').editor));
  const empty = host.render({ ...p, captionTracks: { ...p.captionTracks, translations: [] } }, 'missing');
  assert.equal(empty.selected.length, 0); assert.equal(empty.editor.length, 0);
});

// Tiny deterministic React host executes the installed Expo hook before the
// change, and the actual replacement afterward. No copied observer algorithm.
function recorderHost() {
  const slots = [], intervals = new Map(), listeners = new Set(), callbacks = [];
  let cursor = 0, pending = [], dirty = false, mounted = true, now = 0, nextTimer = 0;
  let options = { voiceoverOpen: false, voiceoverSaving: false, voiceoverStartMs: undefined };
  const native = { canRecord: false, isRecording: false, durationMillis: 0, mediaServicesDidReset: false, url: null };
  const calls = { status: 0, owner: 0, prepare: 0, record: 0, stop: 0, updates: 0 };
  const recorder = { id: 'owner', uri: null, getStatus() { calls.status++; return { ...native }; },
    addListener(event, cb) { assert.equal(event, 'recordingStatusUpdate'); listeners.add(cb); callbacks.push(cb);
      return { remove() { listeners.delete(cb); } }; },
    async prepareToRecordAsync() { calls.prepare++; native.canRecord = true; },
    record() { calls.record++; native.isRecording = true; },
    async stop() { calls.stop++; native.isRecording = false; recorder.uri = native.url = 'file:///take.m4a'; },
  };
  const react = {
    useMemo(fn, deps) { const i = cursor++; if (!same(slots[i]?.deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useRef(value) { return react.useMemo(() => ({ current: value }), []); },
    useState(initial) { const i = cursor++; slots[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, value => { assert.ok(mounted, 'no updates after unmount');
        const next = typeof value === 'function' ? value(slots[i].value) : value;
        if (!Object.is(next, slots[i].value)) { slots[i].value = next; dirty = true; calls.updates++; }
      }]; },
    useEffect(fn, deps) { const i = cursor++; if (!same(slots[i]?.deps, deps)) pending.push(() => {
      slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() };
    }); },
  };
  const hookPath = new URL('../src/hooks/use-voiceover-recorder-state.ts', import.meta.url);
  const source = readFileSync(existsSync(hookPath) ? hookPath
    : new URL('../node_modules/expo-audio/src/utils/useAudioRecorderState.ts', import.meta.url), 'utf8');
  const exports = {};
  runInNewContext(compile(source), { exports, require(name) { if (name === 'react') return react; throw Error(name); },
    setInterval(fn, ms) { const id = ++nextTimer; intervals.set(id, { fn, ms, at: now + ms }); callbacks.push(fn); return id; },
    clearInterval(id) { intervals.delete(id); },
  });
  let result;
  const code = compile(declarations.get('voiceoverRecorder') + '\n' + declarations.get('voiceoverRecorderState')
    + '\nresult = { recorder: voiceoverRecorder, state: voiceoverRecorderState };');
  const render = changes => {
    options = { ...options, ...changes };
    do {
      dirty = false; cursor = 0; pending = [];
      const scope = { ...options, ...react, RecordingPresets: { HIGH_QUALITY: {} },
        useAudioRecorder() { return react.useMemo(() => { calls.owner++; return recorder; }, []); },
        useAudioRecorderState: exports.useAudioRecorderState,
        useVoiceoverRecorderState: exports.useVoiceoverRecorderState, result: undefined };
      runInNewContext(code, scope); result = scope.result;
      for (const effect of pending) effect();
    } while (dirty);
    return result;
  };
  render();
  return { recorder, native, calls, render,
    get options() { return options; },
    get state() { return result.state; }, get timers() { return intervals.size; },
    tick(ms) { const end = now + ms; while (true) {
      const entry = [...intervals].sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry || entry[1].at > end) break;
      now = entry[1].at; entry[1].at += entry[1].ms; entry[1].fn(); if (dirty) render();
    } now = end; },
    emit(event = { hasError: true, error: 'interruption', isFinished: true }) {
      for (const cb of [...listeners]) cb(event); if (dirty) render();
    },
    stale() { const count = calls.status; for (const cb of callbacks) cb({ hasError: true });
      assert.equal(calls.status, count, 'stale callbacks must not read native status'); },
    unmount() { for (const slot of slots) slot.cleanup?.(); mounted = false; },
  };
}
test('idle editor has first status, no timer or render reads, event refresh and no stale teardown callbacks', () => {
  const h = recorderHost();
  assert.equal(h.state.canRecord, false);
  const initial = h.calls.status;
  h.tick(1000); h.render(); h.render();
  assert.equal(h.calls.status, initial, 'idle polls and eager render getStatus must be removed');
  assert.equal(h.timers, 0);
  h.native.mediaServicesDidReset = true; h.emit();
  assert.equal(h.state.mediaServicesDidReset, true);
  h.unmount(); const count = h.calls.status; h.tick(1000); h.stale();
  assert.equal(h.calls.status, count); assert.equal(h.timers, 0);
});
function voiceoverActions(h, failures = {}) {
  const calls = { alerts: [], modes: [], appended: [], selected: [], play: 0, pause: 0 };
  let saved;
  const saveFinished = new Promise(resolve => { saved = resolve; });
  const prepare = h.recorder.prepareToRecordAsync, stop = h.recorder.stop;
  h.recorder.prepareToRecordAsync = async () => {
    if (failures.prepareGate) await failures.prepareGate;
    if (failures.prepare) throw Error('prepare error');
    return prepare();
  };
  h.recorder.stop = async () => { if (failures.stop) throw Error('stop error'); return stop(); };
  const code = compile(declarations.get('startVoiceover') + '\n' + declarations.get('stopVoiceover')
    + '\n' + voiceoverBackEffect + '\nresult = { startVoiceover, stopVoiceover, close: voiceoverBackRequestRef.current };');
  return { calls, saveFinished, current() {
    const scope = { ...h.options, voiceoverRecorder: h.recorder, voiceoverRecorderState: h.state,
      currentMs: 400, isPlaying: false, runtimePolicy: { mediaAdmitted: true },
      VOICEOVER_RECORDING_OPTIONS: {}, voiceoverBackRequestRef: { current: undefined },
      setVoiceoverStartMs(value) { h.render({ voiceoverStartMs: value }); },
      setVoiceoverSaving(value) { h.render({ voiceoverSaving: value }); },
      setVoiceoverOpen(value) { h.render({ voiceoverOpen: value }); },
      AudioModule: { async requestRecordingPermissionsAsync() { return { granted: !failures.permission }; },
        async setAudioModeAsync(mode) { calls.modes.push(mode); if (!mode.allowsRecording) saved(); } },
      Alert: { alert(...args) { calls.alerts.push(args); } },
      transport: { play() { calls.play++; }, pause() { calls.pause++; } },
      async appendRecordedAudioToProject(before, startMs, uri) {
        calls.appended.push({ startMs, uri }); return { project: { ...before, audioClips: [{ id: 'take' }] } };
      },
      async commitEditorProject(fn) { const before = { audioClips: [] }; return { before, project: await fn(before) }; },
      editorSession: { isCurrent() { return true; } }, selectEditorObject(value) { calls.selected.push(value); },
      useEffect(fn) { fn(); }, result: undefined,
    };
    runInNewContext(code, scope); return scope.result;
  } };
}
test('actual editor start/save/back handlers preserve take and permission/preparation/stop error recovery', async () => {
  const h = recorderHost(), failures = { permission: true }, actions = voiceoverActions(h, failures);
  h.render({ voiceoverOpen: true });
  await actions.current().startVoiceover(); assert.equal(h.calls.prepare, 0); assert.equal(actions.calls.alerts.length, 1);
  failures.permission = false; failures.prepare = true;
  await actions.current().startVoiceover(); assert.equal(h.calls.record, 0); assert.equal(actions.calls.alerts.length, 2);
  failures.prepare = false;
  await actions.current().startVoiceover(); h.tick(100);
  assert.equal(h.state.isRecording, true); assert.equal(h.options.voiceoverStartMs, 400);
  failures.stop = true;
  await actions.current().stopVoiceover(true);
  assert.equal(h.options.voiceoverSaving, false); assert.equal(h.options.voiceoverStartMs, undefined);
  assert.equal(h.options.voiceoverOpen, true); assert.equal(actions.calls.appended.length, 0);
  assert.equal(actions.calls.alerts.length, 3); assert.equal(actions.calls.modes.at(-1).allowsRecording, false);
  failures.stop = false;
  await actions.current().stopVoiceover(true); h.tick(100);
  assert.equal(h.options.voiceoverOpen, false); assert.equal(h.state.isRecording, false);
  assert.deepEqual(actions.calls.appended, [{ startMs: 400, uri: 'file:///take.m4a' }]);
  assert.deepEqual(plain(actions.calls.selected), [{ kind: 'audio', id: 'take' }]);
  assert.equal(h.calls.owner, 1); assert.equal(h.timers, 0);
  h.render({ voiceoverOpen: true }); actions.current().close(); assert.equal(h.options.voiceoverOpen, false);
  h.unmount(); h.stale();
});
test('closing during pending preparation still observes late recording and actual back saves it', async () => {
  let finishPreparation;
  const h = recorderHost(), failures = { prepareGate: new Promise(resolve => { finishPreparation = resolve; }) };
  const actions = voiceoverActions(h, failures);
  h.render({ voiceoverOpen: true }); const start = actions.current().startVoiceover();
  await Promise.resolve(); await Promise.resolve();
  actions.current().close(); assert.equal(h.options.voiceoverOpen, false);
  finishPreparation(); await start;
  h.tick(100); assert.equal(h.state.isRecording, true);
  actions.current().close();
  await actions.saveFinished;
  h.tick(100); assert.equal(actions.calls.appended.length, 1); assert.equal(h.timers, 0);
  assert.equal(h.calls.owner, 1); h.unmount(); h.stale();
});
test('preparation/start/stop/close/reopen preserve native owner, 100ms cadence and current status', async () => {
  const h = recorderHost(); h.render({ voiceoverOpen: true });
  assert.equal(h.timers, 1);
  await h.recorder.prepareToRecordAsync(); h.tick(99); assert.equal(h.state.canRecord, false);
  h.tick(1); assert.equal(h.state.canRecord, true);
  h.recorder.record(); h.native.metering = -20; h.tick(99); assert.equal(h.state.isRecording, false);
  h.tick(1); assert.equal(h.state.isRecording, true); assert.equal(h.state.metering, -20);
  h.render({ voiceoverOpen: false, voiceoverStartMs: 120 });
  const count = h.calls.status; h.native.durationMillis = 300; h.tick(100);
  assert.equal(h.calls.status, count + 1); assert.equal(h.state.durationMillis, 300);
  h.render({ voiceoverSaving: true }); await h.recorder.stop(); h.tick(100);
  assert.equal(h.state.isRecording, false); assert.equal(h.state.url, 'file:///take.m4a');
  h.render({ voiceoverSaving: false, voiceoverStartMs: undefined });
  assert.equal(h.timers, 0, 'closing a completed take must stop observation');
  h.native.canRecord = false; h.native.url = null;
  h.render({ voiceoverOpen: true }); assert.equal(h.state.canRecord, false); assert.equal(h.state.url, null);
  assert.equal(h.calls.owner, 1); assert.equal(h.calls.prepare, 1); assert.equal(h.calls.record, 1); assert.equal(h.calls.stop, 1);
  h.render({ voiceoverOpen: false }); h.unmount(); h.tick(1000); h.stale();
});
test('thresholds match Expo, active errors stay on cadence, recording outside panel remains observed', async () => {
  const h = recorderHost(); h.render({ voiceoverOpen: true });
  const state = h.state, updates = h.calls.updates;
  h.native.durationMillis = 50; h.tick(100); assert.strictEqual(h.state, state);
  h.native.durationMillis = 51; h.tick(100); assert.equal(h.state.durationMillis, 51);
  h.native.metering = 0; h.tick(100);
  const meter = h.state; h.native.metering = 0.1; h.tick(100); assert.strictEqual(h.state, meter);
  h.native.metering = 0.1001; h.tick(100); assert.equal(h.state.metering, 0.1001);
  await h.recorder.prepareToRecordAsync(); h.recorder.record(); h.tick(100);
  h.render({ voiceoverOpen: false }); assert.equal(h.timers, 1);
  h.native.isRecording = false; h.native.mediaServicesDidReset = true; h.emit();
  assert.equal(h.state.isRecording, true, 'active event must not change visible poll cadence');
  h.tick(100); assert.equal(h.state.isRecording, false); assert.equal(h.state.mediaServicesDidReset, true);
  assert.equal(h.timers, 0, 'interrupted take outside panel returns to idle');
  h.native.isRecording = true; h.emit(); assert.equal(h.state.isRecording, true); assert.equal(h.timers, 1);
  assert.ok(h.calls.updates > updates); h.unmount(); h.tick(500); h.stale();
});
