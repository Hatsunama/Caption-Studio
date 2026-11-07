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
  const hosts = new Map(), cache = new Map(), timers = new Map(), calls = [], eofFrames = new Map();
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
    return { mediaItems: 0, status: 'idle', playing: false, muted: false, playbackRate: 1, volume: 1,
      get currentTime() { return time; }, set currentTime(value) { time = value; calls.push(['seek', slot, value]); },
      pause() { this.playing = false; calls.push(['pause', slot]); },
      play() { this.playing = true; calls.push(['play', slot, this.muted]); },
      async replaceAsync(uri) { calls.push(['replace', slot, uri]);
        if ((holdReplacement || this.holdReplacement) && uri) await new Promise(resolve => { this.finishReplacement = resolve; });
        if (uri) { this.mediaItems++; time = 0; }
        this.status = uri ? this.replacementStatus ?? 'readyToPlay' : 'idle'; },
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
    'expo-image': { Image: 'image' },
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
    // Native clock events and seek frames can arrive with playback paused.
    // If preparation starts playback, model the decoder running beyond target.
    async pausedEvents() {
      await settle();
      for (const slot of [0, 1]) {
        if (transport.slots[slot].readiness !== 'preparing') continue;
        const player = players[slot], target = player.currentTime;
        if (player.playing) player.currentTime += 0.115;
        await this.positionAck(slot);
        assert.notEqual(transport.slots[slot].readiness, 'ready', 'clock ack alone cannot replace a surface frame');
        assert.equal(player.currentTime, target, 'paused preparation must not run the native clock beyond its target');
        // Completing the frame can activate a composite's explicit source seek.
        await this.frame(slot);
        assert.equal(player.playing, false);
      }
      await settle();
      assert.equal(calls.filter(call => call[0] === 'play').length, 0, 'no decoder playback or audio before user intent');
    },
    // diag998: a retained EOF item still acknowledges 7.999s and runs to
    // 8.036s/EOS, without any frame callback. Replacement offers a new frame
    // at zero, even before readiness. Clock delivery never depends on status.
    async eofEvents(slot, previousMediaItem) {
      const player = players[slot];
      if (player.mediaItems > previousMediaItem && eofFrames.get(slot) !== player.mediaItems) {
        eofFrames.set(slot, player.mediaItems); await this.frame(slot);
      }
      player.currentTime = 7.999; await this.positionAck(slot);
      if (player.playing) {
        player.currentTime = 8.036; await this.positionAck(slot);
        player.playing = false; player.emit('playToEnd', {});
        player.status = 'idle'; player.emit('statusChange', { status: 'idle' });
        await settle();
      }
    },
    async positionAck(slot) { players[slot].emit('timeUpdate', { currentTime: players[slot].currentTime }); await settle(); },
    async complete() { await settle(); for (let i = 0; i < 4; i++) {
      for (const slot of [0, 1]) if (transport.slots[slot].readiness === 'preparing') { await this.frame(slot); await this.positionAck(slot); }
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

for (const scenario of ['load', 'seek', 'Home', 'standby', 'composite']) {
  test(`paused ${scenario} preparation accepts native clock and first frame without playing`, async t => {
    const trimmed = { ...clip(), sourceStartMs: 0, sourceEndMs: 6385, availableSourceEndMs: 8000 };
    const first = scenario === 'composite' ? { ...clip(), transitionAfter: { type: 'crossfade', durationMs: 1000 } } : trimmed;
    const h = harness({ clips: ['standby', 'composite'].includes(scenario) ? [first, clip('b', 'other')] : [first] });
    t.after(() => h.unmount());
    if (first === trimmed) h.project.sources[0].durationMs = 8000;
    await h.pausedEvents();
    // Active completion can schedule standby preparation on the next turn.
    await h.pausedEvents();
    assert.equal(h.transport.phase, 'ready');
    if (scenario === 'seek' || scenario === 'Home') {
      h.transport.seek(6385); await h.settle();
      await h.pausedEvents();
      assert.equal(h.transport.player.currentTime, 6.385);
    }
    if (scenario === 'composite') {
      h.transport.seek(29750); await h.settle(); await h.pausedEvents();
    }
    if (scenario === 'Home' || scenario === 'composite') {
      const retired = h.views.map(view => view.onFirstFrameRender);
      await h.app('background'); await h.app('active');
      retired.forEach(callback => callback()); await h.settle();
      assert.equal(h.transport.slots.some(slot => slot.firstFrameReady), false);
      await h.pausedEvents(); await h.pausedEvents();
    }
    assert.equal(h.transport.phase, 'ready');
    assert.equal(h.transport.isPlaying, false);
    assert.equal(h.calls.some(call => call[0] === 'play'), false);
    if (scenario === 'standby' || scenario === 'composite') {
      assert.equal(h.transport.slots.filter(slot => slot.readiness === 'ready').length, 2);
    }
    if (scenario === 'Home') {
      assert.equal(h.transport.currentMs, 6385); assert.equal(h.transport.player.currentTime, 6.385);
    }
    if (scenario === 'composite') {
      assert.equal(h.players[0].currentTime, 30.75); assert.equal(h.players[1].currentTime, .75);
    }
    const replacements = h.calls.filter(call => call[0] === 'replace').length;
    await h.advance(15000);
    assert.equal(h.timerCount, 0);
    assert.equal(h.calls.filter(call => call[0] === 'replace').length, replacements, 'preloading remains bounded');
  });
}

test('explicit Play during paused preparation activates only the requested slot after both acknowledgements', async t => {
  const h = harness({ clips: [clip(), clip('b', 'other')] }); t.after(() => h.unmount());
  await h.pausedEvents(); await h.pausedEvents();
  h.transport.seek(31800); await h.settle();
  const slot = h.transport.activeSlot;
  assert.equal(h.transport.slots[slot].preparedClipId, 'b');
  await h.app('background'); await h.app('active');
  h.transport.play(); await h.settle();
  assert.equal(h.calls.some(call => call[0] === 'play'), false, 'intent waits for preparation');
  await h.positionAck(slot); assert.equal(h.calls.some(call => call[0] === 'play'), false);
  await h.frame(slot);
  assert.equal(h.transport.phase, 'ready'); assert.equal(h.transport.isPlaying, true);
  assert.equal(h.transport.activeSlot, slot); assert.equal(h.transport.slots[slot].preparedClipId, 'b');
  assert.deepEqual(h.calls.filter(call => call[0] === 'play'), [['play', slot, false]]);
  assert.equal(h.players[slot].playing, true); assert.equal(h.players[1 - slot].playing, false);
});

test('ordinary play and repeated same-clip scrubs keep a ready slot during transient native loading', async t => {
  const h = harness(); t.after(() => h.unmount()); await h.complete();
  const slot = h.transport.activeSlot, token = h.transport.slots[slot].prepareToken;
  const replacements = h.calls.filter(call => call[0] === 'replace').length;
  h.players[slot].status = 'loading';
  h.players[slot].emit('statusChange', { status: 'loading' });
  h.transport.play(); await h.settle();
  for (const target of [21800, 8000, 8000, 12000]) {
    h.transport.seek(target); await h.settle();
    assert.equal(h.transport.phase, 'ready'); assert.equal(h.transport.activeSlot, slot);
    assert.equal(h.transport.slots[slot].readiness, 'ready');
    assert.equal(h.transport.slots[slot].prepareToken, token);
    assert.equal(h.transport.currentMs, target); assert.equal(h.transport.isPlaying, true);
    assert.equal(h.players[slot].currentTime, (target + 1000) / 1000);
    await h.positionAck(slot); assert.equal(h.transport.currentMs, target);
    assert.equal(h.calls.filter(call => call[0] === 'replace').length, replacements);
  }
  h.players[slot].currentTime = 13.25; await h.positionAck(slot);
  assert.equal(h.transport.currentMs, 12250, 'native clock still advances during transient loading');
  h.transport.pause(); await h.settle();
  assert.equal(h.transport.isPlaying, false); assert.equal(h.timerCount, 0);
});

test('ordinary same-URI clip seeks reprepare the loaded slot without replacing a transiently loading decoder', async t => {
  // Discontinuous source ranges prevent seamless continuation; changing clip identity
  // also prevents findPreparedSlot from bypassing prepareSlotOperation.
  const h = harness({ clips: [clip(), clip('b'), clip('c')] }); t.after(() => h.unmount()); await h.complete();
  assert.equal(h.transport.slots.filter(slot => slot.readiness === 'ready').length, 2);
  const replacements = h.calls.filter(call => call[0] === 'replace').length;
  for (const target of [61800, 31800, 1800, 61800, 31800, 1800]) {
    const slot = h.transport.activeSlot === 0 ? 1 : 0;
    const token = h.transport.slots[slot].prepareToken;
    h.players[slot].status = 'loading';
    h.players[slot].emit('statusChange', { status: 'loading' });
    h.transport.seek(target); await h.settle();
    assert.ok(h.transport.slots[slot].prepareToken > token, 'seek must exercise preparation');
    assert.equal(h.calls.filter(call => call[0] === 'replace').length, replacements,
      'ordinary same-URI preparation must retain the loaded decoder during transient loading');
    assert.equal(h.transport.slots[slot].readiness, 'preparing');
    await h.positionAck(slot); assert.notEqual(h.transport.phase, 'ready', 'fresh view frame remains mandatory');
    await h.frame(slot);
    assert.equal(h.transport.phase, 'ready'); assert.equal(h.transport.activeSlot, slot);
    assert.equal(h.transport.slots[slot].readiness, 'ready');
    assert.equal(h.transport.currentMs, target); assert.equal(h.transport.isPlaying, false);
    assert.equal(h.players[slot].currentTime, 2.8);
  }
  await h.advance(15000); assert.equal(h.transport.phase, 'ready'); assert.equal(h.timerCount, 0);
  assert.equal(h.calls.filter(call => call[0] === 'replace').length, replacements);
  assert.equal(h.calls.some(call => call[0] === 'play'), false, 'same-URI repreparation remains paused');
});

test('Home detaches actual overlay; resume at 21.8s reloads once and needs a fresh view frame AND playback position', async t => {
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
  retired.forEach(callback => callback()); await h.positionAck(slot);
  assert.notEqual(h.transport.phase, 'ready');
  await h.frame(slot); assert.equal(h.transport.phase, 'ready');
  assert.equal(h.transport.currentMs, 21800); assert.equal(h.players[slot].playing, false);
  assert.equal(h.calls.filter(call => call[0] === 'replace').length, replacements + 1);
  assert.equal(h.calls.filter(call => call[0] === 'play').length, 0);
});

test('diag998 retained ready EOF item needs replacement on all three Home restores', async t => {
  const endpoint = { ...clip(), sourceStartMs: 0, sourceEndMs: 8000, availableSourceEndMs: 8000 };
  const h = harness({ clips: [endpoint] }); t.after(() => h.unmount());
  h.project.sources[0].durationMs = 8000;
  await h.complete(); h.transport.seek(8000); await h.complete();
  const slot = h.transport.activeSlot, player = h.players[slot];
  const initial = h.calls.filter(call => call[0] === 'replace').length;
  for (let cycle = 0; cycle < 3; cycle++) {
    const retired = h.views.map(view => view.onFirstFrameRender);
    const token = h.transport.slots[slot].prepareToken, mediaItem = player.mediaItems;
    await h.app('background'); assert.equal(h.views.length, 0);
    player.status = 'readyToPlay'; player.currentTime = 7.999;
    player.holdReplacement = true; player.replacementStatus = 'loading';
    const plays = h.calls.filter(call => call[0] === 'play').length;
    await h.app('active');
    assert.ok(h.transport.slots[slot].prepareToken > token);
    retired.forEach(callback => callback()); await h.positionAck(slot);
    assert.equal(h.transport.slots[slot].firstFrameReady, false);
    assert.notEqual(h.transport.phase, 'ready', 'retired callbacks and position ack cannot complete restore');
    // On the old hook no replacement occurs: replay the observed ack/EOS,
    // then require recovery. This fails with the recorded frame-timeout.
    if (player.mediaItems === mediaItem && !player.finishReplacement) {
      await h.eofEvents(slot, mediaItem); await h.advance(5000);
      assert.equal(h.transport.phase, 'ready', h.transport.sourceFailure?.detail);
    }
    assert.equal(h.calls.filter(call => call[0] === 'play').length, plays,
      'source replacement cannot start playback');
    player.finishReplacement(); player.finishReplacement = undefined; await h.settle();
    await h.eofEvents(slot, mediaItem); // new item frame at zero, clock ack while loading
    assert.notEqual(h.transport.phase, 'ready', 'a frame and clock cannot bypass source readiness');
    await h.advance(6000); assert.notEqual(h.transport.phase, 'error');
    assert.equal(h.calls.filter(call => call[0] === 'play').length, plays);
    player.status = 'readyToPlay'; player.emit('statusChange', { status: 'readyToPlay' }); await h.settle();
    assert.equal(player.currentTime, 8, 'seek target remains exact');
    assert.notEqual(h.transport.phase, 'ready', 'pre-seek clock ack cannot satisfy the new waiter');
    await h.eofEvents(slot, mediaItem);
    assert.equal(h.transport.phase, 'ready'); assert.equal(h.transport.sourceFailure, undefined);
    assert.equal(h.transport.currentMs, 8000); assert.equal(h.transport.isPlaying, false);
    assert.equal(h.players.some(value => value.playing), false);
    assert.equal(player.currentTime, 8, 'activation preserves the paused endpoint');
    assert.equal(h.calls.filter(call => call[0] === 'replace').length, initial + cycle + 1,
      'exactly one replacement per needed active view');
    assert.equal(h.calls.filter(call => call[0] === 'play').length, 0);
    await h.advance(15000); h.render(); await h.settle();
    assert.equal(h.transport.phase, 'ready'); assert.equal(h.timerCount, 0);
    assert.equal(h.calls.filter(call => call[0] === 'replace').length, initial + cycle + 1, 'no reload storm');
  }
  h.unmount(); assert.equal(h.timerCount, 0);
  assert.ok(h.players.every(value => value.listenerCount() === 0));
});

for (const status of ['idle', 'loading', 'error']) {
  test(`paused 8s endpoint with completed same-URI source in native ${status} rechecks readiness on repeated resume`, async t => {
    const endpoint = { ...clip(), sourceStartMs: 0, sourceEndMs: 8000, availableSourceEndMs: 8000 };
    const h = harness({ clips: [endpoint] }); t.after(() => h.unmount());
    h.project.sources[0].durationMs = 8000;
    await h.complete(); h.transport.seek(8000); await h.complete();
    assert.equal(h.transport.currentMs, 8000); assert.equal(h.transport.phase, 'ready');
    const slot = h.transport.activeSlot, player = h.players[slot];
    const replacements = () => h.calls.filter(call => call[0] === 'replace');
    const initialReplacements = replacements().length;
    for (let cycle = 0; cycle < 2; cycle++) {
      const retired = h.views.map(view => view.onFirstFrameRender);
      const token = h.transport.slots[slot].prepareToken;
      await h.app('background');
      player.status = status;
      // Expo Android maps a clean STATE_ENDED to idle, even with the source retained.
      if (status === 'idle') player.emit('playToEnd', {});
      player.emit('statusChange', { status }); await h.settle();
      player.holdReplacement = true; player.replacementStatus = 'loading';
      const playCount = h.calls.filter(call => call[0] === 'play').length;
      await h.app('active');
      assert.equal(replacements().length, initialReplacements + cycle + 1,
        'a retired URI must be replaced again regardless of native decoder status');
      assert.equal(replacements().at(-1)[2], 'file:///source.mp4');
      assert.ok(h.transport.slots[slot].prepareToken > token);
      retired.forEach(callback => callback()); await h.positionAck(slot);
      assert.equal(h.transport.slots[slot].firstFrameReady, false);
      assert.equal(h.transport.currentMs, 8000); assert.equal(h.transport.isPlaying, false);
      assert.equal(player.playing, false);
      player.finishReplacement(); await h.settle();
      await h.advance(6000);
      assert.notEqual(h.transport.phase, 'ready'); assert.notEqual(h.transport.phase, 'error');
      assert.equal(h.calls.filter(call => call[0] === 'play').length, playCount,
        'replacement completion must not start frame preparation before decoder readiness');
      player.status = 'readyToPlay'; player.emit('statusChange', { status: 'readyToPlay' }); await h.settle();
      assert.equal(player.currentTime, 8, 'domain endpoint remains exact');
      if (cycle === 0) await h.frame(slot); else await h.positionAck(slot);
      assert.notEqual(h.transport.phase, 'ready', 'both a fresh surface frame and playback position are required');
      await h.advance(4999); assert.notEqual(h.transport.phase, 'error');
      if (cycle === 0) await h.positionAck(slot); else await h.frame(slot);
      assert.equal(h.transport.phase, 'ready'); assert.equal(h.transport.sourceFailure, undefined);
      assert.equal(h.transport.currentMs, 8000); assert.equal(h.transport.isPlaying, false);
      assert.equal(h.players.some(value => value.playing), false);
      await h.advance(15000); assert.equal(h.transport.phase, 'ready'); assert.equal(h.timerCount, 0);
      assert.equal(h.calls.filter(call => call[0] === 'play').length, 0, 'paused preparation never starts playback');
    }
  });
}

test('retired callbacks cannot revive either active or standby slot across repeated interruptions', async t => {
  const h = harness({ clips: [clip(), clip('b', 'other')] }); t.after(() => h.unmount()); await h.complete();
  assert.equal(h.transport.slots.filter(slot => slot.readiness === 'ready').length, 2);
  for (let i = 0; i < 3; i++) {
    const retired = h.views.map(view => view.onFirstFrameRender);
    await h.app('background'); await h.app('active');
    retired.forEach(callback => callback()); await h.settle();
    assert.equal(h.transport.slots.some(slot => slot.firstFrameReady), false);
    assert.notEqual(h.transport.phase, 'ready');
    await h.complete(); assert.equal(h.transport.phase, 'ready');
    assert.equal(h.transport.slots.filter(slot => slot.readiness === 'ready').length, 2);
    assert.equal(h.calls.filter(call => call[0] === 'replace').length, 2 + (i + 1) * 2);
  }
  await h.complete(); assert.equal(h.transport.phase, 'ready');
  assert.equal(h.calls.filter(call => call[0] === 'replace').length, 8,
    'three restores replace each needed active/standby item exactly once');
});

test('resume timeout remains 5s; stale callbacks cannot hide failure, and explicit retry recovers', async t => {
  const h = harness(); t.after(() => h.unmount()); await h.complete();
  h.transport.seek(21800); await h.complete();
  const retired = h.views.map(view => view.onFirstFrameRender);
  await h.app('background'); await h.app('active');
  const slot = h.transport.slots.findIndex(value => value.readiness === 'preparing');
  retired.forEach(callback => callback()); await h.positionAck(slot);
  await h.advance(4999); assert.notEqual(h.transport.phase, 'error');
  await h.advance(1); assert.equal(h.transport.phase, 'error');
  assert.match(h.transport.sourceFailure.detail, /did not render a frame/);
  assert.equal(h.transport.currentMs, 21800); assert.equal(h.players[slot].playing, false);
  h.transport.retrySource(); await h.complete();
  assert.equal(h.transport.phase, 'ready'); assert.equal(h.transport.sourceFailure, undefined);
  assert.equal(h.transport.currentMs, 21800); assert.equal(h.transport.isPlaying, false);
  assert.equal(h.timerCount, 0);
  assert.equal(h.calls.some(call => call[0] === 'play'), false, 'timeout and explicit retry remain paused');
});

test('a view frame alone cannot complete resume without a playback position event', async t => {
  const h = harness(); t.after(() => h.unmount()); await h.complete();
  await h.app('background'); await h.app('active');
  await h.frame(h.transport.activeSlot); assert.notEqual(h.transport.phase, 'ready');
  await h.advance(5000); assert.equal(h.transport.phase, 'error');
  assert.match(h.transport.sourceFailure.detail, /did not reach the requested frame/);
});

test('background cancels in-flight frame preparation, stays silent, and replaces the retired item once', async t => {
  const h = harness(); t.after(() => h.unmount()); await h.settle();
  const retired = h.views.map(view => view.onFirstFrameRender);
  assert.equal(h.transport.slots[0].readiness, 'preparing');
  await h.app('background');
  assert.equal(h.timerCount, 0); assert.equal(h.players.some(player => player.playing), false);
  const count = h.calls.length;
  retired.forEach(callback => callback()); h.transport.play(); await h.advance(15000);
  assert.equal(h.calls.length, count); assert.equal(h.transport.phase, 'suspended');
  await h.app('active'); await h.complete();
  assert.equal(h.transport.phase, 'ready'); assert.equal(h.calls.filter(call => call[0] === 'replace').length, 2);
  assert.equal(h.calls.some(call => call[0] === 'play'), false, 'aborted intent cannot leak into restore');
});

test('an interrupted source replacement is not cached as loaded; its late completion cannot activate transport', async t => {
  const h = harness({ holdReplacement: true }); t.after(() => h.unmount());
  const finishOld = h.players[0].finishReplacement;
  await h.app('background'); finishOld(); await h.settle();
  assert.equal(h.transport.phase, 'suspended'); assert.equal(h.calls.some(call => call[0] === 'play'), false);
  await h.app('active'); assert.equal(h.calls.filter(call => call[0] === 'replace').length, 2);
  h.players[0].finishReplacement(); await h.complete();
  assert.equal(h.transport.phase, 'ready');
  assert.equal(h.calls.some(call => call[0] === 'play'), false, 'late replacement and retry stay paused');
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
  retired.forEach(callback => callback()); await h.positionAck(0);
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
  assert.equal(h.calls.filter(call => call[0] === 'replace').length, 4,
    'composite restore replaces each needed item once');
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
