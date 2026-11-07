import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { posix } from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
const compiled = new Map();
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const transform = { position: { x: .5, y: .5 }, scale: 1, rotation: 0, fit: 'contain' };
const clip = (id = 'a', sourceId = 'source') => ({ id, sourceId, sourceStartMs: 1000,
  sourceEndMs: 31000, availableSourceStartMs: 0, availableSourceEndMs: 60000,
  gapBeforeMs: 0, gapAfterMs: 0, playbackRate: 1, muted: false, volume: 1,
  transitionAfter: { type: 'none', durationMs: 0 }, transform });

// Executes complete modules, with real timeline/policy/overlay consumers. Only
// React scheduling and the native boundary are faked; frames never arrive by default.
function harness({ clips = [clip()], missingSource = false, holdReplacement = false } = {}) {
  const hosts = new Map(), cache = new Map(), timers = new Map(), calls = [];
  let host, cursor, dirty = true, transport, views = [], alive = true, timerId = 0, now = 0;
  let appStateListener, playerCursor = 0, blockingUi = false;
  const layout = [], passive = [];
  const effect = (queue) => (fn, deps) => {
    const i = cursor++, cell = host.cells[i] ??= {};
    if (!same(cell.deps, deps)) {
      cell.deps = deps; cell.setup = fn; cell.effectKind = queue === layout ? 'layout' : 'passive';
      queue.push(() => { cell.cleanup?.(); cell.cleanup = fn(); });
    }
  };
  const react = {
    useRef(value) { const i = cursor++; return host.cells[i] ??= { current: value }; },
    useState(value) { const i = cursor++, owner = host;
      if (!(i in owner.cells)) owner.cells[i] = typeof value === 'function' ? value() : value;
      return [owner.cells[i], next => { const value = typeof next === 'function' ? next(owner.cells[i]) : next;
        if (!Object.is(value, owner.cells[i])) { owner.cells[i] = value; dirty = true; } }]; },
    useMemo(fn, deps) { const i = cursor++; if (!same(host.cells[i]?.deps, deps)) host.cells[i] = { deps, value: fn() }; return host.cells[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useLayoutEffect: effect(layout), useEffect: effect(passive),
  };
  const appState = { currentState: 'active', addEventListener(_event, fn) {
    appStateListener = fn; return { remove() { appStateListener = undefined; } }; } };
  const players = [0, 1].map(slot => {
    const listeners = new Map();
    let time = 0;
    return { status: 'idle', playing: false, muted: false, playbackRate: 1, volume: 1,
      get currentTime() { return time; }, set currentTime(value) { time = value; calls.push(['seek', slot, value]); },
      pause() { this.playing = false; calls.push(['pause', slot]); },
      play() { this.playing = true; calls.push(['play', slot, this.muted]); },
      async replaceAsync(uri) { calls.push(['replace', slot, uri]);
        if (holdReplacement && uri) await new Promise(resolve => { this.finishReplacement = resolve; });
        this.status = uri ? 'readyToPlay' : 'idle'; },
      addListener(event, fn) { const set = listeners.get(event) ?? new Set(); listeners.set(event, set); set.add(fn);
        return { remove: () => set.delete(fn) }; },
      emit(event, value) { for (const fn of [...(listeners.get(event) ?? [])]) fn(value); },
      listenerCount() { return [...listeners.values()].reduce((n, set) => n + set.size, 0); },
    };
  });
  const jsx = (type, props, key) => ({ type, props, key });
  const mocks = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'react-native': { View: 'view', Text: 'text', AppState: appState },
    'expo-video': { VideoView: 'video', useVideoPlayer(_source, setup) {
      const player = players[playerCursor++]; const ref = react.useRef(false);
      if (!ref.current) { setup(player); ref.current = true; } return player; } },
    expo: { useEventListener(player, event, callback) {
      react.useEffect(() => { const sub = player.addListener(event, callback); return () => sub.remove(); }, [player, event, callback]); } },
  };
  function load(path) {
    if (cache.has(path)) return cache.get(path);
    if (!compiled.has(path)) compiled.set(path, ts.transpileModule(readFileSync(new URL(path, root), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText);
    const exports = {}; cache.set(path, exports);
    vm.runInNewContext(compiled.get(path), { exports, Error, AbortController, performance,
      setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; },
      clearTimeout: id => timers.delete(id), requestAnimationFrame: () => { throw new Error('unexpected gap clock'); }, cancelAnimationFrame() {},
      require(id) { if (id in mocks) return mocks[id];
        if (id.startsWith('.')) { const relative = posix.normalize(posix.join(posix.dirname(path), id));
          return id.endsWith('.json') ? JSON.parse(readFileSync(new URL(relative, root), 'utf8')) : load(relative + '.ts'); }
        if (id.startsWith('@/')) { const stem = `src/${id.slice(2)}`;
          return load(stem + (stem.endsWith('video-transition-overlay') ? '.tsx' : '.ts')); }
        return require(id); },
    }, { filename: fileURLToPath(new URL(path, root)) });
    return exports;
  }
  const { useTimelineVideoController } = load('src/hooks/use-timeline-video-controller.ts');
  const { useEditorRuntimePolicy } = load('src/hooks/use-editor-runtime-policy.ts');
  const { VideoTransitionOverlay } = load('src/components/editor/video-transition-overlay.tsx');
  const { buildClipTimeline } = load('src/lib/video-timeline.ts');
  const project = { clips, sources: missingSource ? [] : ['source', 'other'].map(id => ({ id, uri: `file:///${id}.mp4`, displayName: id, durationMs: 60000 })) };
  function Root() {
    const policy = useEditorRuntimePolicy(blockingUi);
    transport = useTimelineVideoController(project, () => {}, policy.videoSurfacesAdmitted);
    return jsx(VideoTransitionOverlay, { entries: buildClipTimeline(project.clips), sources: project.sources,
      timelineMs: transport.currentMs, isPlaying: transport.isPlaying, transportReady: transport.phase === 'ready',
      width: 300, height: 200, backgroundColor: '#000', admitted: policy.videoSurfacesAdmitted && !transport.previewResourcesSuspended,
      visible: !transport.isGap, players, slots: transport.slots, activeSlot: transport.activeSlot,
      currentTransform: transform, currentClipId: transport.slots[transport.activeSlot].preparedClipId,
      onFirstFrameRender: transport.markFirstFrame, setCompositeClock: transport.setCompositeClock });
  }
  function renderNode(node, path, seen, ancestors = []) {
    if (Array.isArray(node)) return node.forEach((child, i) => renderNode(child, `${path}/${child?.key ?? i}`, seen, ancestors));
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'function') {
      seen.add(path); host = hosts.get(path) ?? { cells: [] }; hosts.set(path, host); cursor = 0;
      const child = node.type(node.props); renderNode(child, `${path}/result`, seen, ancestors);
    } else {
      if (node.type === 'video') views.push({ ...node.props, ancestors });
      const style = node.props?.style;
      const flat = Object.assign({}, ...(Array.isArray(style) ? style.flat(Infinity) : [style]).filter(Boolean));
      renderNode(node.props?.children, `${path}/children`, seen, [...ancestors, flat]);
    }
  }
  function render() {
    if (!alive) return transport;
    let attempts = 0;
    do {
      assert.ok(++attempts < 30, 'render must settle'); dirty = false; playerCursor = 0; views = [];
      const seen = new Set(); renderNode(jsx(Root, {}), 'root', seen);
      for (const [path, owner] of hosts) if (!seen.has(path)) { owner.cells.forEach(cell => cell?.cleanup?.()); hosts.delete(path); }
      while (layout.length) layout.shift()(); while (passive.length) passive.shift()();
    } while (dirty);
    return transport;
  }
  async function settle() { for (let i = 0; i < 25; i++) { await Promise.resolve(); if (dirty) render(); } return transport; }
  render();
  return { players, calls, project, render, settle, get transport() { return transport; }, get views() { return views; },
    async app(state) { appState.currentState = state; appStateListener(state); render(); await settle(); },
    async modal(value) { blockingUi = value; render(); await settle(); },
    async frame(slot) { views.find(view => view.player === players[slot])?.onFirstFrameRender(); await settle(); },
    async decoded(slot) { players[slot].emit('timeUpdate', { currentTime: players[slot].currentTime }); await settle(); },
    async complete() { await settle(); for (let i = 0; i < 4; i++) {
      for (const slot of [0, 1]) if (transport.slots[slot].readiness === 'preparing') { await this.frame(slot); await this.decoded(slot); }
      await settle(); } },
    async advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } await settle(); },
    async replayEffects() {
      const cells = [...hosts.values()].flatMap(owner => owner.cells).filter(cell => cell?.setup);
      for (const kind of ['layout', 'passive']) for (const cell of cells) {
        if (cell.effectKind === kind) { cell.cleanup?.(); cell.cleanup = undefined; }
      }
      for (const kind of ['layout', 'passive']) for (const cell of cells) {
        if (cell.effectKind === kind) cell.cleanup = cell.setup();
      }
      await settle();
    },
    unmount() { alive = false; for (const owner of hosts.values()) owner.cells.forEach(cell => cell?.cleanup?.()); hosts.clear(); },
    get timerCount() { return timers.size; },
  };
}

test('Home detaches actual overlay; resume at 21.8s needs a fresh view frame AND decoded position without source reload', async t => {
  const h = harness(); t.after(() => h.unmount()); await h.complete();
  h.transport.seek(21800); await h.complete();
  const retired = h.views.map(view => view.onFirstFrameRender), tokens = h.transport.slots.map(slot => slot.prepareToken);
  const replacements = h.calls.filter(call => call[0] === 'replace').length;
  await h.app('background'); assert.equal(h.views.length, 0);
  assert.equal(h.transport.slots.some(slot => slot.firstFrameReady), false);
  retired.forEach(callback => callback()); await h.settle();
  assert.equal(h.transport.slots.some(slot => slot.firstFrameReady), false);
  await h.app('active');
  assert.equal(h.transport.currentMs, 21800); assert.equal(h.transport.isPlaying, false);
  assert.notEqual(h.transport.phase, 'ready');
  const slot = h.transport.slots.findIndex(value => value.readiness === 'preparing');
  assert.ok(slot >= 0); assert.ok(h.transport.slots[slot].prepareToken > tokens[slot]);
  assert.equal(h.players[slot].currentTime, 22.8);
  retired.forEach(callback => callback()); await h.decoded(slot);
  assert.notEqual(h.transport.phase, 'ready');
  await h.frame(slot); assert.equal(h.transport.phase, 'ready');
  assert.equal(h.transport.currentMs, 21800); assert.equal(h.players[slot].playing, false);
  assert.equal(h.calls.filter(call => call[0] === 'replace').length, replacements);
  assert.ok(h.calls.filter(call => call[0] === 'play').every(call => call[2] === true));
});

test('retired callbacks cannot revive either active or standby slot across repeated interruptions', async t => {
  const h = harness({ clips: [clip(), clip('b', 'other')] }); t.after(() => h.unmount()); await h.complete();
  assert.equal(h.transport.slots.filter(slot => slot.readiness === 'ready').length, 2);
  const retired = h.views.map(view => view.onFirstFrameRender);
  for (let i = 0; i < 3; i++) {
    await h.app('background'); await h.app('active');
    retired.forEach(callback => callback()); await h.settle();
    assert.equal(h.transport.slots.some(slot => slot.firstFrameReady), false);
    assert.notEqual(h.transport.phase, 'ready');
  }
  await h.complete(); assert.equal(h.transport.phase, 'ready');
  assert.equal(h.calls.filter(call => call[0] === 'replace').length, 2);
});

test('resume timeout remains 5s; stale callbacks cannot hide failure, and explicit retry recovers', async t => {
  const h = harness(); t.after(() => h.unmount()); await h.complete();
  h.transport.seek(21800); await h.complete();
  const retired = h.views.map(view => view.onFirstFrameRender);
  await h.app('background'); await h.app('active');
  const slot = h.transport.slots.findIndex(value => value.readiness === 'preparing');
  retired.forEach(callback => callback()); await h.decoded(slot);
  await h.advance(4999); assert.notEqual(h.transport.phase, 'error');
  await h.advance(1); assert.equal(h.transport.phase, 'error');
  assert.match(h.transport.sourceFailure.detail, /did not render a frame/);
  assert.equal(h.transport.currentMs, 21800); assert.equal(h.players[slot].playing, false);
  h.transport.retrySource(); await h.complete();
  assert.equal(h.transport.phase, 'ready'); assert.equal(h.transport.sourceFailure, undefined);
  assert.equal(h.transport.currentMs, 21800); assert.equal(h.transport.isPlaying, false);
  assert.equal(h.timerCount, 0);
});

test('a view frame alone cannot complete resume without a decoded position event', async t => {
  const h = harness(); t.after(() => h.unmount()); await h.complete();
  await h.app('background'); await h.app('active');
  await h.frame(h.transport.activeSlot); assert.notEqual(h.transport.phase, 'ready');
  await h.advance(5000); assert.equal(h.transport.phase, 'error');
  assert.match(h.transport.sourceFailure.detail, /did not reach the requested frame/);
});

test('background cancels in-flight frame preparation, stays silent, and reuses a completed replacement', async t => {
  const h = harness(); t.after(() => h.unmount()); await h.settle();
  const retired = h.views.map(view => view.onFirstFrameRender);
  assert.equal(h.transport.slots[0].readiness, 'preparing');
  await h.app('background');
  assert.equal(h.timerCount, 0); assert.equal(h.players.some(player => player.playing), false);
  const count = h.calls.length;
  retired.forEach(callback => callback()); h.transport.play(); await h.advance(15000);
  assert.equal(h.calls.length, count); assert.equal(h.transport.phase, 'suspended');
  await h.app('active'); await h.complete();
  assert.equal(h.transport.phase, 'ready'); assert.equal(h.calls.filter(call => call[0] === 'replace').length, 1);
});

test('an interrupted source replacement is not cached as loaded; its late completion cannot activate transport', async t => {
  const h = harness({ holdReplacement: true }); t.after(() => h.unmount());
  const finishOld = h.players[0].finishReplacement;
  await h.app('background'); finishOld(); await h.settle();
  assert.equal(h.transport.phase, 'suspended'); assert.equal(h.calls.some(call => call[0] === 'play'), false);
  await h.app('active'); assert.equal(h.calls.filter(call => call[0] === 'replace').length, 2);
  h.players[0].finishReplacement(); await h.complete();
  assert.equal(h.transport.phase, 'ready');
});

test('translation unload and background restore retire tokens permanently and restore the saved paused position', async t => {
  const h = harness(); t.after(() => h.unmount()); await h.complete();
  h.transport.seek(21800); await h.complete();
  const retired = h.views.map(view => view.onFirstFrameRender);
  const token = h.transport.slots[0].prepareToken;
  const lease = h.transport.suspendForTranslation(); await h.settle(); await lease.ready;
  assert.equal(h.views.length, 0); assert.equal(h.players.every(player => player.status === 'idle'), true);
  await h.app('background'); await lease.restore(); await lease.restore(); await h.settle();
  assert.equal(h.transport.phase, 'suspended');
  const count = h.calls.filter(call => call[0] === 'replace').length;
  await h.app('active'); await h.settle();
  assert.ok(h.transport.slots[0].prepareToken > token);
  retired.forEach(callback => callback()); await h.decoded(0);
  assert.notEqual(h.transport.phase, 'ready');
  await h.frame(0); assert.equal(h.transport.phase, 'ready');
  assert.equal(h.transport.currentMs, 21800); assert.equal(h.transport.isPlaying, false);
  assert.equal(h.calls.filter(call => call[0] === 'replace').length, count + 1);
});

test('composite consumers cannot reuse detached active/standby frames on foreground', async t => {
  const first = clip(); first.transitionAfter = { type: 'crossfade', durationMs: 1000 };
  const h = harness({ clips: [first, clip('b', 'other')] }); t.after(() => h.unmount()); await h.complete();
  h.transport.seek(29750); await h.complete();
  const retired = h.views.map(view => view.onFirstFrameRender);
  const assertComposite = () => {
    assert.equal(h.views.length, 2, 'composite retains one native view per player');
    for (const player of h.players) assert.equal(h.views.filter(view => view.player === player).length, 1);
    const incoming = h.views.find(view => view.player === h.players[1]);
    assert.ok(incoming.ancestors.some(style => style.opacity === .25), 'crossfade is one quarter through the 29.5–30.5s window');
  };
  assertComposite();
  await h.app('background'); assert.equal(h.views.length, 0);
  await h.app('active'); assert.equal(h.views.length, 2, 'composite waits for new preparations');
  retired.forEach(callback => callback()); await h.settle(); assert.notEqual(h.transport.phase, 'ready');
  await h.complete(); assert.equal(h.transport.phase, 'ready'); assertComposite();
  assert.equal(h.transport.currentMs, 29750); assert.equal(h.transport.isPlaying, false);
  assert.equal(h.calls.filter(call => call[0] === 'replace').length, 2);
});

test('blocking UI preserves surface admission and the repeated-scrub ready cache', async t => {
  const h = harness(); t.after(() => h.unmount()); await h.complete();
  const token = h.transport.slots[0].prepareToken, playCount = h.calls.filter(call => call[0] === 'play').length;
  await h.modal(true); h.transport.seek(21800); await h.settle();
  h.transport.seek(21800); await h.settle(); await h.modal(false);
  assert.equal(h.transport.phase, 'ready'); assert.equal(h.views.length, 2);
  assert.equal(h.transport.slots[0].prepareToken, token);
  assert.equal(h.calls.filter(call => call[0] === 'play').length, playCount);
});

test('missing source remains an actionable error', async t => {
  const h = harness({ missingSource: true }); t.after(() => h.unmount()); await h.settle();
  assert.equal(h.transport.phase, 'error'); assert.match(h.transport.sourceFailure.detail, /lost its source video/);
  assert.equal(h.calls.some(call => call[0] === 'replace'), false);
});

test('unmount during preparation cancels waiters and retired callbacks cannot touch disposed players', async () => {
  const h = harness(); await h.settle();
  const retired = h.views.map(view => view.onFirstFrameRender);
  h.unmount(); const count = h.calls.length;
  retired.forEach(callback => callback()); await h.settle();
  assert.equal(h.timerCount, 0); assert.equal(h.calls.length, count);
  assert.equal(h.players.every(player => player.listenerCount() === 0), true);
});

test('mount-effect replay retires old frames and ordinary renders keep the later paused position', async t => {
  const h = harness(); t.after(() => h.unmount());
  const retired = h.views.map(view => view.onFirstFrameRender);
  await h.replayEffects(); retired.forEach(callback => callback()); await h.settle();
  assert.notEqual(h.transport.phase, 'ready');
  await h.complete(); assert.equal(h.transport.phase, 'ready');
  h.transport.seek(21800); await h.complete();
  const calls = h.calls.length, tokens = h.transport.slots.map(slot => slot.prepareToken);
  for (let i = 0; i < 4; i++) { h.render(); await h.settle(); }
  assert.equal(h.transport.currentMs, 21800); assert.equal(h.transport.isPlaying, false);
  assert.deepEqual(h.transport.slots.map(slot => slot.prepareToken), tokens);
  assert.equal(h.calls.length, calls);
});
