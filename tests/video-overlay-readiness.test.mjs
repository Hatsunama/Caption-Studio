import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { posix } from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url), compiled = new Map();
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

// Executes the actual overlay, clock/geometry modules and native-window service.
// Only React scheduling and native boundaries are faked. A seek/READY/public
// frame is deliberately NOT a native presentation receipt (same main-preview contract).
function harness(platform = 'android', initial = {}, { readyOnCreate = false, nativeDuration = 8 } = {}) {
  const hosts = new Map(), cache = new Map(), players = [], requests = [], calls = [], warnings = [], errors = [];
  const layout = [], passive = [], timers = new Map();
  let host, cursor, dirty = true, alive = true, views = [], timerId = 0;
  let props = { layer: { id: 'pip', uri: 'file:///eight-seconds.mp4', startMs: 0, endMs: 8000,
    sourceStartMs: 0, sourceDurationMs: 8000, playbackRate: 1, includeAudio: false, opacity: 1,
    position: { x: .5, y: .5 }, box: { width: .5, height: .5 }, scale: 1, rotation: 0 },
    clips: [], timelineMs: 0, isPlaying: false, suspended: false, onError: message => errors.push(message), ...initial };
  const effect = queue => (fn, deps) => {
    const cell = host.cells[cursor++] ??= {};
    if (!same(cell.deps, deps)) { cell.deps = deps; cell.setup = fn; queue.push(() => { cell.cleanup?.(); cell.cleanup = fn(); }); }
  };
  const react = {
    useRef(value) { return host.cells[cursor++] ??= { current: value }; },
    useState(value) { const cell = host.cells[cursor++] ??= { value };
      return [cell.value, next => { const value = typeof next === 'function' ? next(cell.value) : next;
        if (!Object.is(cell.value, value)) { cell.value = value; dirty = true; } }]; },
    useEffect: effect(passive), useLayoutEffect: effect(layout),
  };
  function createPlayer(uri) {
    const listeners = new Map(); let time = 0;
    const player = { uri, loadedUri: undefined, status: 'loading', duration: nativeDuration, playing: false, muted: false,
      get currentTime() { return time; },
      set currentTime(value) { time = value; calls.push(['seek', player, value]); },
      play() { player.playing = true; calls.push(['play', player, player.muted]); },
      pause() { player.playing = false; calls.push(['pause', player]); },
      addListener(event, fn) { const set = listeners.get(event) ?? new Set(); listeners.set(event, set); set.add(fn);
        return { remove: () => set.delete(fn) }; },
      emit(status) { player.status = status; if (status === 'readyToPlay') player.loadedUri = uri;
        for (const fn of [...(listeners.get('statusChange') ?? [])]) fn({ status, error: { message: 'decoder failed' } }); },
      listeners() { return [...listeners.values()].flatMap(set => [...set]); },
      position(value) { time = value; },
    };
    if (readyOnCreate) { player.status = 'readyToPlay'; player.loadedUri = uri; }
    players.push(player); return player;
  }
  const jsx = (type, props, key) => ({ type, props, key });
  const mocks = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { View: 'view', Platform: { OS: platform } },
    'expo-video': { VideoView: 'video', useVideoPlayer(uri, setup) {
      const cell = react.useRef();
      if (!cell.current || cell.current.uri !== uri) { const player = createPlayer(uri); setup?.(player); cell.current = player; }
      return cell.current;
    } },
    'caption-media': { __esModule: true, default: {
      configureVideoPlaybackWindow(player, uri, token, endMs, targetMs, timeoutMs) {
        assert.equal(player.loadedUri, uri, 'SDK source installation must precede native presentation');
        assert.equal(player.playing, false); assert.equal(player.muted, true);
        assert.equal(endMs, null, 'PiP keeps its full source clock');
        assert.ok(timeoutMs > 0 && timeoutMs <= 5000);
        let resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        const request = { player, uri, token, targetMs, resolve, reject, cancelled: false };
        requests.push(request); return promise;
      },
      async cancelVideoPlaybackWindow(player, token) {
        const request = requests.find(r => r.player === player && r.token === token);
        if (request) request.cancelled = true;
      },
    } },
  };
  const context = vm.createContext({ AbortController, Error, console: { warn: (...args) => warnings.push(args) },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id) });
  function load(path) {
    if (cache.has(path)) return cache.get(path);
    if (!compiled.has(path)) compiled.set(path, ts.transpileModule(readFileSync(new URL(path, root), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText);
    const exports = {}; cache.set(path, exports);
    vm.runInContext(`(function(exports, require) {\n${compiled.get(path)}\n})`, context)(exports, id => {
      if (id in mocks) return mocks[id];
      const stem = id.startsWith('@/') ? `src/${id.slice(2)}` : id.startsWith('.') ? posix.normalize(posix.join(posix.dirname(path), id)) : undefined;
      if (stem?.endsWith('.json')) return JSON.parse(readFileSync(new URL(stem, root), 'utf8'));
      if (stem) return load(stem + (stem.endsWith('video-layer-overlay') ? '.tsx' : '.ts'));
      return require(id);
    });
    return exports;
  }
  const { VideoLayerOverlay } = load('src/components/editor/video-layer-overlay.tsx');
  function visit(node, path, seen) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((child, i) => visit(child, `${path}/${i}`, seen));
    path += `/${node.key ?? ''}`;
    if (typeof node.type === 'function') {
      seen.add(path); host = hosts.get(path) ?? { cells: [] }; hosts.set(path, host); cursor = 0;
      visit(node.type(node.props), `${path}/result`, seen);
    } else {
      if (node.type === 'video') views.push({ ...node.props, path });
      visit(node.props?.children, `${path}/children`, seen);
    }
  }
  function render() {
    if (!alive) return;
    let attempts = 0;
    do {
      assert.ok(++attempts < 20); dirty = false; views = []; const seen = new Set();
      visit(jsx(VideoLayerOverlay, props), 'root', seen);
      for (const [path, owner] of hosts) if (!seen.has(path)) { owner.cells.forEach(cell => cell?.cleanup?.()); hosts.delete(path); }
      while (layout.length) layout.shift()(); while (passive.length) passive.shift()();
    } while (dirty);
  }
  async function settle() { for (let i = 0; i < 20; i++) { await Promise.resolve(); if (dirty) render(); } }
  render();
  return { players, calls, requests, warnings, errors, get views() { return views; }, get timers() { return timers.size; }, settle,
    async update(next) { props = { ...props, ...next }; render(); await settle(); },
    async ready(player = players.at(-1)) { player.emit('readyToPlay'); await settle(); },
    async replayEffects() { for (const owner of hosts.values()) for (const cell of owner.cells) {
      if (cell?.setup) { cell.cleanup?.(); cell.cleanup = cell.setup(); }
    } await settle(); },
    async present(request = requests.at(-1)) {
      assert.ok(request, 'paused PiP must request source/view-owned native presentation, even at zero');
      if (!request.cancelled) request.player.position(request.targetMs / 1000);
      request.resolve(); await settle();
    },
    async fail(request = requests.at(-1)) { request.reject(new Error('presentation failed')); await settle(); },
    async timeout() { for (const fn of [...timers.values()]) fn(); await settle(); },
    unmount() { alive = false; for (const owner of hosts.values()) owner.cells.forEach(cell => cell?.cleanup?.()); hosts.clear(); },
  };
}

test('paused Android PiP at zero requests real presentation after SDK readiness, without playing', async t => {
  const h = harness(); t.after(() => h.unmount()); const p = h.players[0], path = h.views[0].path;
  assert.equal(h.requests.length, 0); await h.ready();
  assert.equal(h.requests.length, 1, 'READY alone is insufficient; whole-source PiP needs native presentation');
  assert.equal(h.requests[0].targetMs, 0);
  h.views[0].onFirstFrameRender?.(); await h.settle();
  assert.equal(p.playing, false); await h.present();
  assert.equal(p.currentTime, 0); assert.equal(h.views[0].path, path);
  assert.equal(h.calls.filter(c => c[0] === 'seek' || c[0] === 'play').length, 0);
  assert.equal(h.timers, 0);
});

test('SDK loading keeps latest clock and explicit play intent muted until native presentation', async t => {
  const h = harness(); t.after(() => h.unmount());
  await h.update({ timelineMs: 3100, isPlaying: true }); await h.ready();
  assert.equal(h.requests.at(-1)?.targetMs, 3100);
  assert.equal(h.players[0].playing, false); await h.present();
  assert.equal(h.players[0].playing, true); assert.equal(h.players[0].muted, true);
});

test('clock changed during paused presentation needs latest target before activation', async t => {
  const h = harness(); t.after(() => h.unmount()); await h.ready(); const first = h.requests[0];
  await h.update({ timelineMs: 2600 }); await h.present(first);
  assert.equal(h.requests.length, 2); assert.equal(h.requests[1].targetMs, 2600);
  await h.present(); assert.equal(h.players[0].currentTime, 2.6);
  assert.equal(h.calls.some(c => c[0] === 'play'), false);
});

test('play-to-pause during preparation cannot be undone by late completion or audio option changes', async t => {
  const h = harness(); t.after(() => h.unmount());
  await h.update({ isPlaying: true }); await h.ready();
  await h.update({ timelineMs: 1700, isPlaying: false,
    layer: { id: 'pip', uri: 'file:///eight-seconds.mp4', startMs: 0, endMs: 8000,
      sourceStartMs: 0, playbackRate: 2, includeAudio: true, opacity: 1 } });
  await h.present(h.requests[0]); await h.present();
  assert.equal(h.players[0].currentTime, 3.4); assert.equal(h.players[0].playing, false);
  assert.equal(h.calls.some(c => c[0] === 'play'), false);
});

for (const stage of ['loading', 'presentation', 'ready']) {
  test(`background/suspension in ${stage} retires player work and resume owns a fresh player`, async t => {
    const h = harness(); t.after(() => h.unmount()); const old = h.players[0];
    if (stage !== 'loading') await h.ready();
    if (stage === 'ready') { await h.present(); await h.update({ isPlaying: true }); }
    const late = old.listeners(), request = h.requests[0];
    await h.update({ suspended: true }); assert.equal(h.views.length, 0);
    assert.equal(old.playing, false); assert.equal(old.muted, true); assert.equal(old.listeners().length, 0);
    late.forEach(fn => fn({ status: 'readyToPlay' }));
    late.forEach(fn => fn({ status: 'error', error: { message: 'file:///private/retired.mp4' } }));
    if (request) { await h.fail(request); await h.present(request); }
    await h.update({ suspended: false, timelineMs: 2000, isPlaying: false }); await h.ready(); await h.present();
    assert.notEqual(h.players.at(-1), old); assert.equal(h.players.at(-1).currentTime, 2);
    assert.equal(old.playing, false); assert.equal(h.timers, 0);
    assert.deepEqual(h.errors, []);
  });
}

for (const reason of ['native failure', 'native timeout', 'SDK error']) {
  test(`${reason} fails closed and late callbacks cannot authorize playback`, async t => {
    const h = harness(); t.after(() => h.unmount()); await h.update({ isPlaying: true }); await h.ready();
    const p = h.players[0], request = h.requests[0]; assert.ok(request);
    if (reason === 'native failure') await h.fail();
    else if (reason === 'native timeout') await h.timeout();
    else { p.emit('error'); await h.settle(); }
    await h.present(request); await h.ready(); await h.update({ timelineMs: 1000 });
    assert.equal(p.playing, false); assert.equal(p.muted, true);
    assert.equal(h.calls.some(c => c[0] === 'play'), false); assert.ok(h.warnings.length);
    assert.deepEqual(h.errors, ['A picture-in-picture video preview could not be prepared.']);
    assert.deepEqual(h.warnings, [['Video overlay preparation failed']]);
    assert.equal(h.timers, 0);
  });
}

test('source replacement ignores retired source readiness and native completion', async t => {
  const h = harness(); t.after(() => h.unmount()); await h.ready();
  const old = h.players[0], callbacks = old.listeners(), request = h.requests[0];
  await h.update({ layer: { id: 'pip', uri: 'content://media/new', startMs: 0, endMs: 8000,
    sourceStartMs: 0, playbackRate: 1, includeAudio: true, opacity: 1 }, timelineMs: 2500, isPlaying: true });
  callbacks.forEach(fn => fn({ status: 'readyToPlay' })); await h.present(request);
  callbacks.forEach(fn => fn({ status: 'error', error: { message: 'content://private/retired' } }));
  assert.deepEqual(h.errors, []);
  assert.equal(old.playing, false); assert.equal(old.muted, true); assert.equal(request.cancelled, true);
  assert.equal(h.requests.length, 1); await h.ready(); await h.present();
  assert.equal(h.players.at(-1).currentTime, 2.5); assert.equal(h.players.at(-1).playing, true);
  assert.equal(h.players.at(-1).muted, false);
});

test('prepared PiP retains texture view across pinch, ordinary seek, play and pause', async t => {
  const h = harness(); t.after(() => h.unmount()); await h.ready(); await h.present();
  const path = h.views[0].path;
  await h.update({ geometry: { position: { x: .6, y: .3 }, scale: 2, rotation: 0 }, timelineMs: 4000 });
  await h.update({ isPlaying: true }); await h.update({ isPlaying: false });
  assert.equal(h.players.length, 1); assert.equal(h.requests.length, 1);
  assert.equal(h.views[0].path, path); assert.equal(h.views[0].surfaceType, 'textureView');
  assert.equal(h.views[0].nativeControls, false); assert.equal(h.players[0].currentTime, 4);
  assert.equal(h.players[0].playing, false);
});

test('EOF preparation uses the existing Android last-millisecond policy without changing project time', async t => {
  const h = harness('android', { timelineMs: 8000 }); t.after(() => h.unmount()); await h.ready();
  assert.equal(Math.trunc(h.requests.at(-1)?.targetMs), 7999); await h.present();
  assert.equal(h.players[0].playing, false); assert.equal(h.players[0].currentTime, 7.999);
});

for (const { name, durationMs, nativeDuration, timelineMs, expectedMs } of [
  { name: 'native Float EOF', durationMs: 8001, nativeDuration: Math.fround(8001 / 1000), timelineMs: 8001, expectedMs: 8000 },
  { name: 'ordinary trim', durationMs: 8000, nativeDuration: 8, timelineMs: 7500, expectedMs: 7500 },
  { name: 'native duration too far from EOF', durationMs: 8000, nativeDuration: 7.5, timelineMs: 8000, expectedMs: 8000 },
  { name: 'unknown zero duration', durationMs: 0, nativeDuration: 8, timelineMs: 8000, expectedMs: 8000 },
  { name: 'legacy absent duration', durationMs: undefined, nativeDuration: 8, timelineMs: 8000, expectedMs: 7999 },
]) {
  test(`${name} keeps source/native duration units and unknown semantics`, async t => {
    const layer = { id: 'pip', uri: 'file:///eight-seconds.mp4', startMs: 0, endMs: timelineMs,
      sourceStartMs: 0, playbackRate: 1, includeAudio: false, opacity: 1 };
    if (durationMs !== undefined) layer.sourceDurationMs = durationMs;
    // Unknown/legacy layers have no valid segment duration; exercise their old clock.
    const h = harness('android', { layer, timelineMs, clips: durationMs === 0 ? undefined : [] }, { nativeDuration });
    t.after(() => h.unmount()); await h.ready();
    assert.ok(Math.abs(h.requests.at(-1)?.targetMs - expectedMs) < 1e-6,
      `native target ${h.requests.at(-1)?.targetMs} must match ${expectedMs}ms`);
    assert.equal(Math.trunc(h.requests.at(-1)?.targetMs), expectedMs);
    await h.present(); assert.equal(Math.trunc(h.players[0].currentTime * 1000), expectedMs);
    assert.equal(h.players[0].playing, false); assert.equal(h.requests.length, 1);
    await h.update({ timelineMs }); assert.equal(h.requests.length, 1);
  });
}

test('source already ready before commit still requests presentation and effect replay uses a fresh token', async t => {
  const h = harness('android', {}, { readyOnCreate: true }); t.after(() => h.unmount());
  assert.equal(h.requests.length, 1); const retired = h.requests[0];
  await h.replayEffects(); assert.equal(retired.cancelled, true);
  assert.equal(h.requests.length, 2); assert.ok(h.requests[1].token > retired.token);
  await h.present(retired); assert.equal(h.players[0].playing, false);
  await h.present(); assert.equal(h.players[0].currentTime, 0); assert.equal(h.timers, 0);
});

test('SDK error before initial readiness cannot start native work or leak audio', async t => {
  const h = harness('android', { isPlaying: true }); t.after(() => h.unmount());
  const p = h.players[0]; p.emit('error'); await h.ready();
  assert.equal(h.requests.length, 0); assert.equal(p.playing, false); assert.equal(p.muted, true);
  assert.equal(h.warnings.length, 1);
  assert.deepEqual(h.errors, ['A picture-in-picture video preview could not be prepared.']);
});

test('failure uses the latest committed callback without restarting preparation or status subscription', async t => {
  const oldErrors = [], newErrors = [];
  const h = harness('android', { onError: message => oldErrors.push(message) }); t.after(() => h.unmount());
  await h.ready(); const p = h.players[0], listeners = p.listeners();
  await h.update({ onError: message => newErrors.push(message) });
  assert.deepEqual(p.listeners(), listeners); assert.equal(h.requests.length, 1);
  await h.fail(); await h.ready(); await h.timeout(); await h.update({ isPlaying: true });
  assert.deepEqual(oldErrors, []);
  assert.deepEqual(newErrors, ['A picture-in-picture video preview could not be prepared.']);
  assert.equal(h.requests.length, 1); assert.equal(p.playing, false); assert.equal(p.muted, true);
  assert.equal(h.timers, 0);
});

test('error callback is optional and unmount suppresses late native and SDK failures', async () => {
  const h = harness('android', { onError: undefined }); await h.ready(); await h.fail();
  assert.equal(h.players[0].playing, false); assert.equal(h.players[0].muted, true); h.unmount();
  const retired = harness(); await retired.ready(); const late = retired.players[0].listeners(); retired.unmount();
  await retired.fail(); late.forEach(fn => fn({ status: 'error' })); await retired.settle();
  assert.deepEqual(retired.errors, []); assert.deepEqual(retired.warnings, []); assert.equal(retired.timers, 0);
});

test('editor PiP failure reaches the existing inline alert and success of another PiP cannot clear it or unrelated errors', async t => {
  const source = readFileSync(new URL('src/app/editor.tsx', root), 'utf8');
  const ast = ts.createSourceFile('editor.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let overlay, alert;
  const visit = node => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'VideoLayerOverlay') overlay = node;
    if (ts.isJsxExpression(node) && node.expression && ts.isConditionalExpression(node.expression)
      && node.expression.getText(ast).includes('accessibilityRole="alert"')) alert = node.expression;
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(overlay); assert.ok(alert);
  let error;
  const layer = { id: 'pip', uri: 'file:///private/source.mp4', sourceDurationMs: 8000, sourceStartMs: 0,
    startMs: 0, endMs: 8000, playbackRate: 1, includeAudio: false, opacity: 1 };
  const jsx = (type, props) => ({ type, props });
  const evaluate = node => {
    const code = ts.transpileModule(`result = (${node.getText(ast)});`, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText;
    const sandbox = { result: undefined, exports: {}, require: id => {
      assert.equal(id, 'react/jsx-runtime'); return { jsx, jsxs: jsx };
    }, VideoLayerOverlay: 'overlay', View: 'view', Text: 'text', layer, project: { clips: [] },
    previewGeometryFor: () => undefined, currentMs: 0, isPlaying: false,
    transport: { previewResourcesSuspended: false }, runtimePolicy: { videoSurfacesAdmitted: true },
    setError: next => { error = typeof next === 'function' ? next(error) : next; }, error,
    translationStyleSaveError: undefined, captionInterruptionMessage: undefined, persistenceError: undefined,
    translationController: {} };
    vm.runInNewContext(code, sandbox); return sandbox.result;
  };
  const callerProps = evaluate(overlay).props;
  assert.equal(typeof callerProps.onError, 'function', 'editor must receive the overlay failure');
  const failed = harness('android', callerProps); t.after(() => failed.unmount());
  await failed.ready(); await failed.fail();
  const message = 'A picture-in-picture video preview could not be prepared.';
  assert.equal(error, message);
  const rendered = evaluate(alert), text = rendered.props.children;
  assert.equal(text.props.accessibilityRole, 'alert'); assert.equal(text.props.children, message);
  assert.equal(text.props.style.color, '#FFBBC8');
  const other = harness('android', { ...callerProps, layer: { ...layer, id: 'other', uri: 'file:///other.mp4' } });
  t.after(() => other.unmount()); await other.ready(); await other.present();
  assert.equal(error, message); await failed.update({ suspended: true }); assert.equal(error, message);
  error = 'An unrelated save failed.';
  evaluate(overlay).props.onError(message); assert.equal(error, 'An unrelated save failed.');
  assert.equal(evaluate(alert).props.children.props.children, error);
});

test('latest include-audio and speed apply only after real presentation and honor subsequent pause', async t => {
  const h = harness(); t.after(() => h.unmount()); await h.ready();
  await h.update({ isPlaying: true, timelineMs: 1200,
    layer: { id: 'pip', uri: 'file:///eight-seconds.mp4', startMs: 0, endMs: 8000,
      sourceStartMs: 0, playbackRate: 2, includeAudio: true, opacity: 1 } });
  assert.equal(h.players[0].muted, true); assert.equal(h.players[0].playing, false);
  await h.present(); assert.equal(h.players[0].currentTime, 2.4);
  assert.equal(h.players[0].playbackRate, 2); assert.equal(h.players[0].muted, false);
  assert.equal(h.players[0].playing, true);
  await h.update({ isPlaying: false }); assert.equal(h.players[0].playing, false);
});

test('source replaced before its first READY cannot prepare the retired player', async t => {
  const h = harness(); t.after(() => h.unmount()); const old = h.players[0], late = old.listeners();
  await h.update({ layer: { id: 'pip', uri: 'content://media/new', startMs: 0, endMs: 8000,
    sourceStartMs: 0, playbackRate: 1, includeAudio: false, opacity: 1 } });
  late.forEach(fn => fn({ status: 'readyToPlay' })); await h.settle();
  assert.equal(h.requests.length, 0); assert.equal(old.muted, true);
  await h.ready(); await h.present(); assert.equal(h.requests[0].player, h.players[1]);
});

for (const platform of ['ios', 'web']) {
  test(`${platform} uses SDK readiness and ordinary playback without Android native preparation`, async t => {
    const h = harness(platform, { timelineMs: 1000, isPlaying: true }); t.after(() => h.unmount());
    await h.ready(); await h.update({ isPlaying: false });
    assert.equal(h.requests.length, 0); assert.equal(h.players[0].currentTime, 1);
    assert.equal(h.players[0].playing, false);
  });
}
