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
// React scheduling and the native boundary are faked. Public view frames never
// arrive by default; all Android native presentation is controlled by holdWindow.
// Explicit iOS/web fixtures below retain coverage of the legacy public frame gates.
function harness({ clips = [clip()], missingSource = false, holdReplacement = false, frameOnPublish = false, platform = 'android', nativeDuration, nativeClock = false, sourceDurationMs = 31000, allowGapClock = false, pip = false } = {}) {
  const hosts = new Map(), cache = new Map(), timers = new Map(), calls = [], eofFrames = new Map();
  const gapFrames = new Map();
  const publishedFrames = new Map();
  const retirementTrace = [];
  let heldNativeOwner;
  let traceRetirement = false;
  let host, cursor, dirty = true, transport, views = [], alive = true, timerId = 0, now = 0;
  let appStateListener, playerCursor = 0, blockingUi = false, width = 300, height = 200;
  const layout = [], passive = [];
  // views and transport describe the last completed host commit, not pending
  // useState cells. Observe native-boundary calls without inventing black pixels
  // or deriving foreground ownership from the controller's mutable active ref.
  function observeInstallation(operation, slot, uri) {
    if (!traceRetirement) return;
    retirementTrace.push({ operation, slot, uri,
      heldNativeOwner,
      committedActiveSlot: transport.activeSlot, committedMs: transport.currentMs,
      committedViews: views.map(view => ({ slot: players.indexOf(view.player),
        nativePath: view.nativePath,
        pairAncestor: view.pairAncestor,
        foreground: (view.pairAncestor
          ? view.pairAncestor.frontSlot === view.pairAncestor.childSlot
          : view.ancestors.some(style => (style.elevation ?? style.zIndex) === 1))
          && !view.ancestors.some(style => style.opacity === 0),
      })),
    });
  }
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
        if (!Object.is(value, owner.cells[i])) { owner.cells[i] = value; dirty = true;
          // Deliver the newly published native epoch's callback synchronously,
          // before prepareSlotOperation can register its first-frame waiter.
          if (frameOnPublish && Array.isArray(value) && value[0]?.nativeViewEpoch > transport?.slots[0]?.nativeViewEpoch
            && publishedFrames.get(0) !== value[0].nativeViewEpoch) {
            publishedFrames.set(0, value[0].nativeViewEpoch);
            transport.markFirstFrame(0, value[0].nativeViewEpoch);
          }
        } }]; },
    useMemo(fn, deps) { const i = cursor++; if (!same(host.cells[i]?.deps, deps)) host.cells[i] = { deps, value: fn() }; return host.cells[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useLayoutEffect: effect(layout), useEffect: effect(passive),
  };
  const appState = { currentState: 'active', addEventListener(_event, fn) {
    appStateListener = fn; return { remove() { appStateListener = undefined; } }; } };
  const players = (pip ? [0, 1, 2] : [0, 1]).map(slot => {
    const listeners = new Map();
    let time = 0;
    return { mediaItems: 0, status: 'idle', playing: false, muted: false, playbackRate: 1, volume: 1, holdWindow: slot === 2,
      get duration() { const full = nativeDuration === undefined ? project.sources[0]?.durationMs / 1000 : nativeDuration;
        return this.windowEndMs == null ? full : Math.min(full, Math.fround(Math.fround(this.windowEndMs) / 1000)); },
      get currentTime() { return nativeClock ? Math.fround(Math.fround(time * 1000) / 1000) : time; },
      set currentTime(value) { time = nativeClock ? Math.min(Math.trunc(value * 1000), Math.round(this.duration * 1000)) / 1000 : value; calls.push(['seek', slot, value]);
        if (this.ackOnSeek) this.emit('timeUpdate', { currentTime: value }); },
      pause() { this.playing = false; calls.push(['pause', slot]); },
      play() { this.playing = true; calls.push(['play', slot, this.muted]); },
      async replaceAsync(uri) { calls.push(['replace', slot, uri]);
        if (uri) observeInstallation('replaceAsync', slot, uri);
        if ((this.holdReplacement ?? holdReplacement) && uri) await new Promise(resolve => { this.finishReplacement = resolve; });
        if (uri) { this.mediaItems++; time = 0; }
        this.loadedUri = uri; this.windowEndMs = undefined;
        this.status = uri ? this.replacementStatus ?? 'readyToPlay' : 'idle'; },
      addListener(event, fn) { const set = listeners.get(event) ?? new Set(); listeners.set(event, set); set.add(fn);
        return { remove: () => set.delete(fn) }; },
      emit(event, value) { for (const fn of [...(listeners.get(event) ?? [])]) fn(value); },
      listenerCount() { return [...listeners.values()].reduce((n, set) => n + set.size, 0); },
    };
  });
  const jsx = (type, props, key) => ({ type, props, key });
  const mocks = {
    'caption-media': { __esModule: true, default: {
      async acquireVideoMaskLease(player, peer, requestId, generation, requireHiddenAncestor) {
        calls.push(['maskAcquire', players.indexOf(player), requestId, generation, requireHiddenAncestor]);
        assert.notEqual(player, peer);
        player.maskRequest = requestId;
        player.maskGeneration = generation;
        if (player.holdMaskAcquire || heldNativeOwner?.slot === players.indexOf(player)) {
          await new Promise((resolve, reject) => { player.grantMask = resolve; player.failMask = reject; });
        }
        if (player.cancelledMask >= requestId || player.maskRequest !== requestId) throw Object.assign(new Error('stale mask'), { name: 'AbortError' });
        player.nativeLeaseGrant = requestId;
      },
      async commitVideoMaskLease(player, requestId, generation) {
        assert.equal(player.nativeLeaseGrant, requestId);
        assert.equal(player.maskGeneration, generation);
        if (player.holdMaskCommit) await new Promise(resolve => { player.finishMaskCommit = resolve; });
        if (player.cancelledMask >= requestId) throw Object.assign(new Error('stale mask'), { name: 'AbortError' });
        calls.push(['maskCommit', players.indexOf(player), requestId]);
      },
      async cancelVideoMaskLease(player, requestId) {
        player.cancelledMask = Math.max(player.cancelledMask ?? 0, requestId);
        calls.push(['maskCancel', players.indexOf(player), requestId]);
      },
      async disposeVideoMaskLease(player, requestId) {
        calls.push(['maskDispose', players.indexOf(player), requestId]);
        player.cancelledMask = Math.max(player.cancelledMask ?? 0, requestId);
      },
      async configureVideoPlaybackWindow(player, uri, requestId, endMs, targetMs, timeoutMs) {
        const slot = players.indexOf(player);
        calls.push(['window', slot, uri, requestId, endMs, timeoutMs, targetMs]);
        observeInstallation('configureVideoPlaybackWindow', slot, uri);
        assert.equal(player.loadedUri, uri, 'SDK source must be current before configuring its window');
        assert.equal(player.playing, false); assert.equal(player.muted, true);
        assert.ok(timeoutMs > 0 && timeoutMs <= 5000);
        // Native setMediaSource installs the item before asynchronous READY.
        // Cancellation retires its observer, without restoring the old item.
        player.windowEndMs = endMs;
        // Model installation/positioning BEFORE the source-specific presentation promise.
        // This is a contract mock, not evidence of real codec presentation.
        player.currentTime = targetMs / 1000;
        calls[calls.length - 1][0] = 'nativePosition';
        if (player.holdWindow) await new Promise((resolve, reject) => { player.finishWindow = resolve; player.failWindow = reject; });
        if (player.cancelledWindow === requestId) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      },
      async cancelVideoPlaybackWindow(player, requestId) {
        calls.push(['cancelWindow', players.indexOf(player), requestId]); player.cancelledWindow = requestId;
      },
    } },
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'react-native': { View: 'view', Text: 'text', AppState: appState, Platform: { OS: platform, Version: 36 } },
    'expo-video': { VideoView: 'video', useVideoPlayer(source, setup) {
      const player = players[playerCursor++]; const ref = react.useRef(false);
      if (!ref.current) { if (source) { player.loadedUri = source; player.status = 'loading'; }
        setup(player); ref.current = true; } return player; } },
    expo: { requireNativeView(moduleName, viewName) {
      assert.equal(platform, 'android', 'transition pair native factory is Android only');
      assert.equal(moduleName, 'CaptionMedia');
      assert.equal(viewName, 'CaptionTransitionPair');
      return 'transition-pair';
    }, useEventListener(player, event, callback) {
      react.useEffect(() => { const sub = player.addListener(event, callback); return () => sub.remove(); }, [player, event, callback]); } },
  };
  // One app has one JavaScript realm. Keep each harness isolated, while module
  // factories provide their own lexical scope without duplicating VM intrinsics.
  const context = vm.createContext({ Error, AbortController, performance: { now: () => now },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id), requestAnimationFrame(fn) {
      if (!allowGapClock) throw new Error('unexpected gap clock');
      const id = ++timerId; gapFrames.set(id, fn); calls.push(['gapRAF']); return id;
    }, cancelAnimationFrame: id => gapFrames.delete(id),
  });
  function load(path) {
    if (cache.has(path)) return cache.get(path);
    if (!compiled.has(path)) compiled.set(path, ts.transpileModule(readFileSync(new URL(path, root), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText);
    const exports = {}; cache.set(path, exports);
    const factory = vm.runInContext(`(function(exports, require) {\n${compiled.get(path)}\n})`, context,
      { filename: fileURLToPath(new URL(path, root)) });
    factory(exports, function localRequire(id) { if (id in mocks) return mocks[id];
        if (id.startsWith('.')) { const relative = posix.normalize(posix.join(posix.dirname(path), id));
          return id.endsWith('.json') ? JSON.parse(readFileSync(new URL(relative, root), 'utf8')) : load(relative + '.ts'); }
        if (id.startsWith('@/')) { const stem = `src/${id.slice(2)}`;
          return load(stem + (/video-(transition|layer)-overlay$/.test(stem) ? '.tsx' : '.ts')); }
        return require(id); });
    return exports;
  }
  const { useTimelineVideoController } = load('src/hooks/use-timeline-video-controller.ts');
  const { useEditorRuntimePolicy } = load('src/hooks/use-editor-runtime-policy.ts');
  const { VideoTransitionOverlay } = load('src/components/editor/video-transition-overlay.tsx');
  const { VideoLayerOverlay } = pip ? load('src/components/editor/video-layer-overlay.tsx') : {};
  const { buildClipTimeline } = load('src/lib/video-timeline.ts');
  const project = { clips, sources: missingSource ? [] : ['source', 'other'].map(id => ({ id, uri: `file:///${id}.mp4`, displayName: id, durationMs: sourceDurationMs })) };
  function Root() {
    const policy = useEditorRuntimePolicy(blockingUi);
    transport = useTimelineVideoController(project, () => {}, policy.videoSurfacesAdmitted);
    const main = jsx(VideoTransitionOverlay, { entries: buildClipTimeline(project.clips), sources: project.sources,
      timelineMs: transport.currentMs, isPlaying: transport.isPlaying, transportReady: transport.phase === 'ready',
      width, height, backgroundColor: '#000000', admitted: policy.videoSurfacesAdmitted && !transport.previewResourcesSuspended,
      visible: !transport.isGap, players: pip ? players.slice(0, 2) : players, slots: transport.slots, activeSlot: transport.activeSlot,
      currentTransform: transform, currentClipId: transport.slots[transport.activeSlot].preparedClipId,
      onFirstFrameRender: transport.markFirstFrame, setCompositeClock: transport.setCompositeClock,
      retireComposite: transport.retireComposite });
    return pip ? [main, jsx(VideoLayerOverlay, {
      layer: { id: 'pip', uri: 'file:///pip.mp4', startMs: 0, endMs: 8000,
        sourceStartMs: 0, sourceDurationMs: 8000, playbackRate: 1, includeAudio: false, opacity: 1 },
      clips: [], timelineMs: transport.currentMs, isPlaying: transport.isPlaying,
      suspended: transport.previewResourcesSuspended || !policy.videoSurfacesAdmitted,
    })] : main;
  }
  // Capture the actual rendered native-pair prop and its physical child index.
  // Do not infer committed foreground from controller state or player identity.
  function renderNode(node, path, seen, ancestors = [], pairAncestor) {
    if (Array.isArray(node)) return node.forEach((child, i) => renderNode(child, `${path}/${child?.key ?? i}`, seen, ancestors,
      pairAncestor && pairAncestor.childSlot == null ? { ...pairAncestor, childSlot: i } : pairAncestor));
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'function') {
      seen.add(path); host = hosts.get(path) ?? { cells: [] }; hosts.set(path, host); cursor = 0;
      const child = node.type(node.props); renderNode(child, `${path}/result`, seen, ancestors, pairAncestor);
    } else {
      if (node.type === 'video') views.push({ ...node.props, ancestors, pairAncestor, nativePath: path });
      const style = node.props?.style;
      const flat = Object.assign({}, ...(Array.isArray(style) ? style.flat(Infinity) : [style]).filter(Boolean));
      renderNode(node.props?.children, `${path}/children`, seen, [...ancestors, flat],
        node.type === 'transition-pair' ? { frontSlot: node.props.frontSlot, childSlot: null } : pairAncestor);
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
    maskService: load('src/services/video-playback-window.ts'),
    retirementTrace,
    traceRetirement(value) { traceRetirement = value; },
    // Independent native-boundary fixture: later React renders must not advance
    // this snapshot. Its native lease is released only by an explicit fixture grant.
    holdNativeOwnership() {
      const slot = transport.activeSlot;
      heldNativeOwner = { slot, nativeViewEpoch: transport.slots[slot].nativeViewEpoch,
        nativePath: views.find(view => view.player === players[slot]).nativePath };
      return heldNativeOwner;
    },
    async nativeLeaseGrant(slot) {
      assert.ok(players[slot].grantMask, 'an actual lease request must be pending');
      players[slot].grantMask();
      await settle();
    },
    // Let promise continuations/native-boundary requests run while React's next
    // host commit is pending. No timers, fabricated view frames or render calls.
    async drainWithoutCommit() { for (let i = 0; i < 25; i++) await Promise.resolve(); },
    async app(state) { appState.currentState = state; appStateListener(state); render(); await settle(); },
    async modal(value) { blockingUi = value; render(); await settle(); },
    async rotate() { [width, height] = [height, width]; render(); await settle(); },
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
        if (player.windowEndMs === undefined) assert.notEqual(transport.slots[slot].readiness, 'ready', 'legacy clock ack alone cannot replace a surface frame');
        // Native presentation can finish activation during ACK delivery. A
        // composite may then explicitly seek its source handle; no clock drift.
        const activatedSeek = calls.filter(call => call[0] === 'seek' && call[1] === slot).at(-1);
        assert.equal(player.currentTime, player.windowEndMs !== undefined && transport.slots[slot].readiness === 'ready' && activatedSeek
          ? activatedSeek[2] : target, 'paused preparation only moves for an explicit composite source seek');
        // Completing the frame can activate a composite's explicit source seek.
        await this.frame(slot);
        assert.equal(player.playing, false);
      }
      await settle();
      assert.equal(calls.filter(call => call[0] === 'play').length, 0, 'no decoder playback or audio before user intent');
    },
    // diag998: a retained EOF item still acknowledges 7.999s and runs to
    // 8.036s/EOS, without a seek frame callback. A replacement offers a frame
    // at zero before readiness; a new view offers a fresh callback after ACK.
    // Clock delivery never depends on status.
    async eofEvents(slot, previousMediaItem) {
      const player = players[slot];
      const offerViewFrame = async () => {
        const path = views.find(view => view.player === player)?.nativePath;
        if (player.mediaItems > previousMediaItem && eofFrames.get(slot) !== path) {
          eofFrames.set(slot, path); await this.frame(slot);
        }
      };
      await offerViewFrame();
      player.currentTime = 7.999; await this.positionAck(slot);
      await offerViewFrame();
      if (player.playing) {
        player.currentTime = 8.036; await this.positionAck(slot);
        player.playing = false; player.emit('playToEnd', {});
        player.status = 'idle'; player.emit('statusChange', { status: 'idle' });
        await settle();
      }
    },
    async positionAck(slot) { players[slot].emit('timeUpdate', { currentTime: players[slot].currentTime }); await settle(); },
    async complete() { await settle(); for (let i = 0; i < 4; i++) {
      for (const slot of [0, 1]) if (transport.slots[slot].readiness === 'preparing') { await this.positionAck(slot); await this.frame(slot); }
      await settle(); } },
    async advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
      for (const [id, frame] of [...gapFrames]) { gapFrames.delete(id); frame(now); } await settle(); },
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

// Synthetic A/B/A/B 5/5/3/3s fixture: the third cut is at 13s, with a 650ms
// composite. A2 reaches EOF, so its visible 325ms tail runs at half speed.
function mixedBoundaryClips(incomingHandle = true, muted = false) {
  return [
    { ...clip('A1'), sourceStartMs: 0, sourceEndMs: 5000, availableSourceEndMs: 8000 },
    { ...clip('B1', 'other'), sourceStartMs: 0, sourceEndMs: 5000, availableSourceEndMs: 8000 },
    { ...clip('A2'), sourceStartMs: 5000, sourceEndMs: 8000, availableSourceEndMs: 8000,
      transitionAfter: { type: 'crossfade', durationMs: 650 } },
    { ...clip('B2', 'other'), sourceStartMs: 3000, sourceEndMs: 6000, availableSourceEndMs: 8000,
      availableSourceStartMs: incomingHandle ? 0 : 3000, muted, volume: .6 },
  ];
}

async function enterMixedBoundary(h, previous) {
  await h.complete();
  if (previous === 0) { h.transport.seek(5000); await h.complete(); }
  h.transport.seek(10000); await h.complete();
  h.transport.seek(12750); await h.complete();
  h.transport.play(); await h.complete();
  assert.equal(h.transport.activeSlot, previous);
  assert.ok(h.players.every(player => player.playing));
}

for (const previous of [0, 1]) test(`actual 5/3/3/5s mixed boundary at 11s, slot=${previous}`, async t => {
  const clips = mixedBoundaryClips();
  clips[1].sourceEndMs = 3000;
  clips[3].sourceEndMs = 8000;
  const h = harness({ clips, sourceDurationMs: 8000 });
  t.after(() => h.unmount()); await h.complete();
  if (previous === 0) { h.transport.seek(5000); await h.complete(); }
  h.transport.seek(8000); await h.complete();
  h.transport.seek(10750); await h.complete();
  h.transport.play(); await h.complete();
  assert.equal(h.transport.activeSlot, previous);
  const incoming = 1 - previous;
  for (const ms of [10990, 11000, 11100]) {
    h.players[previous].currentTime = (7675 + Math.round((ms - 10675) * .5)) / 1000;
    h.players[incoming].currentTime = (ms - 8000) / 1000;
    h.calls.length = 0;
    h.players[h.transport.activeSlot].emit('timeUpdate', { currentTime: h.players[h.transport.activeSlot].currentTime });
    await h.drainWithoutCommit();
    t.diagnostic(JSON.stringify({ ms, previous, callsBeforeCommit: h.calls }));
    assert.ok(!h.calls.some(c => ['seek', 'pause', 'replace', 'window'].includes(c[0])));
    h.render(); await h.settle();
    assert.equal(h.transport.activeSlot, ms < 11000 ? previous : incoming);
    assert.ok(Math.abs(h.transport.currentMs - ms) <= 1);
    assert.ok(h.players.every(p => p.playing));
    assert.equal(h.players[previous].playbackRate, .5);
    assert.equal(h.players[incoming].playbackRate, 1);
  }
});

for (const previous of [0, 1]) for (const incomingHandle of [false, true]) for (const muted of [false, true]) for (const sample of [12990, 13000, 13040]) test(
  `integrated mixed boundary keeps both visible legs continuous: slot=${previous}, handle=${incomingHandle}, muted=${muted}, sample=${sample}`, async t => {
  const h = harness({ clips: mixedBoundaryClips(incomingHandle, muted), sourceDurationMs: 8000 });
  t.after(() => h.unmount()); await enterMixedBoundary(h, previous);
  const incoming = 1 - previous, paths = h.views.map(view => view.nativePath);
  const incomingRate = incomingHandle ? 1 : .5;
  // At 13.324s the half-rate incoming leg rounds to its endpoint, whose
  // inverse is already 13.325s. Keep this sample unambiguously inside the tail;
  // endpoint rounding is exercised independently by the installed EOF cases.
  for (const ms of [12800, sample, ...(sample < 13000 ? [13000] : []), 13100, 13322]) {
    // Decoder samples are independent fixed arithmetic, not production targets.
    h.players[previous].currentTime = Math.min(7999, 7675 + Math.round((ms - 12675) * .5)) / 1000;
    h.players[incoming].currentTime = (incomingHandle ? ms - 10000 : 3000 + Math.round((ms - 12675) * .5)) / 1000;
    h.calls.length = 0;
    const owner = h.transport.activeSlot;
    h.players[owner].emit('timeUpdate', { currentTime: h.players[owner].currentTime });
    await h.drainWithoutCommit();
    t.diagnostic(JSON.stringify({ ms, previous, incomingHandle, callsBeforeCommit: h.calls,
      players: h.players.map(p => ({ time: p.currentTime, rate: p.playbackRate, playing: p.playing, muted: p.muted })) }));
    assert.ok(!h.calls.some(c => ['pause', 'seek', 'replace', 'window'].includes(c[0])), 'a live composite clock must not pause, seek or prepare either visible leg');
    assert.equal(h.players[previous].playbackRate, .5);
    assert.equal(h.players[incoming].playbackRate, incomingRate);
    h.render(); await h.settle();
    assert.equal(h.transport.activeSlot, ms < 13000 ? previous : incoming, 'transport ownership changes at the cut, never at ordinary early-cut tolerance');
    assert.ok(Math.abs(h.transport.currentMs - ms) <= 1, 'composite clock survives crossing the clip boundary');
    assert.ok(h.players.every(p => p.playing));
    assert.equal(h.players[previous].muted, false);
    assert.equal(h.players[incoming].muted, muted);
    assert.deepEqual(h.views.map(view => view.nativePath), paths);
    assert.ok(!h.calls.some(c => c[0] === 'pause' || c[0] === 'seek'), 'overlay must not repair a controller-induced pause/seek after commit');
  }
  // The tail exits at 13.325s. Incoming returns to its ordinary 1x clock;
  // the outgoing surface can then retire, with no new native host.
  h.players[incoming].currentTime = 3.325;
  await h.positionAck(incoming);
  assert.equal(h.transport.currentMs, 13325);
  assert.equal(h.transport.activeSlot, incoming);
  assert.equal(h.players[incoming].currentTime, 3.325);
  assert.equal(h.players[incoming].playbackRate, 1);
  assert.equal(h.players[incoming].playing, true);
  assert.equal(h.players[incoming].muted, muted);
  assert.equal(h.players[incoming].volume, muted ? 0 : .6);
  assert.equal(h.players[previous].playing, false);
  assert.deepEqual(h.views.map(view => view.nativePath), paths);
  h.players[incoming].currentTime = 3.4; await h.positionAck(incoming);
  assert.equal(h.transport.currentMs, 13400);
});

for (const previous of [0, 1]) for (const interruption of ['seek', 'pause', 'background', 'retry', 'native-stop']) test(
  `integrated mixed boundary interruption ${interruption}, slot=${previous}`, async t => {
  const h = harness({ clips: mixedBoundaryClips(false), sourceDurationMs: 8000 });
  t.after(() => h.unmount()); await enterMixedBoundary(h, previous);
  if (interruption === 'native-stop') {
    h.players[previous].currentTime = 7.833;
    h.players[previous].playing = false;
    h.players[previous].emit('playingChange', { isPlaying: false });
    await h.settle();
    assert.equal(h.transport.activeSlot, previous, 'native stop recovery cannot force an early cut while the composite owns timing');
    assert.ok(h.players.every(p => p.playing));
    return;
  }
  const retired = h.views.map(view => view.onFirstFrameRender);
  if (interruption === 'seek') { h.transport.seek(14000); await h.complete(); }
  if (interruption === 'pause') { h.transport.pause(); await h.settle(); }
  if (interruption === 'background') { await h.app('background'); await h.app('active'); await h.complete(); }
  if (interruption === 'retry') { h.transport.retrySource(); await h.complete(); }
  retired.forEach(callback => callback()); await h.settle();
  assert.equal(h.transport.phase, 'ready');
  assert.equal(h.transport.isPlaying, interruption === 'seek');
  assert.ok(h.players.every(p => p.playing === (interruption === 'seek' && p === h.transport.player)));
  if (interruption === 'seek') {
    assert.equal(h.transport.currentMs, 14000);
    assert.equal(h.transport.player.currentTime, 4);
    assert.equal(h.transport.player.playbackRate, 1);
  } else {
    assert.equal(h.transport.currentMs, 12750);
    assert.equal(h.views.length, 2);
    h.transport.play(); await h.complete();
    assert.ok(h.players.every(p => p.playing), 'explicit play restores both prepared composite legs');
  }
});

for (const [endpoint, nativeDuration, expectedMs] of [[8000, undefined, 7999], [6385, undefined, 6384],
  [7950, undefined, 7949], [8000, Math.fround(7.95), 7949], [8000, Math.fround(7.5), 7999]]) test(
  `integrated synchronizer respects installed EOF ${endpoint}ms, native=${nativeDuration}`, async t => {
  const outgoing = { ...clip('out'), sourceStartMs: endpoint - 3000, sourceEndMs: endpoint,
    availableSourceEndMs: endpoint, transitionAfter: { type: 'crossfade', durationMs: 650 } };
  const h = harness({ clips: [outgoing, { ...clip('in', 'other'), sourceStartMs: 3000, sourceEndMs: 6000 }],
    sourceDurationMs: 8000, nativeClock: true, nativeDuration });
  t.after(() => h.unmount()); await h.complete();
  h.transport.seek(3324); await h.complete();
  const slot = h.transport.slots.findIndex(s => s.preparedClipId === 'out');
  const player = h.players[slot];
  assert.equal(player.windowEndMs, endpoint === 8000 ? null : endpoint);
  const actualSeek = h.calls.filter(c => c[0] === 'seek' && c[1] === slot).at(-1)[2];
  t.diagnostic(JSON.stringify({ endpoint, reportedDuration: player.duration, actualSeek, nativeLongMs: Math.trunc(actualSeek * 1000) }));
  assert.equal(Math.trunc(actualSeek * 1000), expectedMs, 'reuse bounded EOF adjustment and preserve Android Long targets; do not warp a large native mismatch');
  assert.equal(h.transport.currentMs, 3324, 'native seek adjustment never changes logical preview time');
  assert.equal(player.playing, false);
});

for (const previous of [0, 1]) for (const playing of [false, true]) for (const muted of [false, true]) test(
  `simultaneous composite exit and controller slot change preserves owner: slot ${previous}, playing=${playing}, muted=${muted}`, async t => {
  const outgoing = { ...clip('out', 'source'), transitionAfter: { type: 'crossfade', durationMs: 1000 } };
  const clips = [outgoing, { ...clip('in', 'other'), muted }];
  if (previous === 1) clips.unshift(clip('lead', 'other'));
  const h = harness({ clips, sourceDurationMs: 60000 });
  t.after(() => h.unmount());
  await h.complete();
  if (previous === 1) { h.transport.seek(30000); await h.complete(); }
  const boundary = previous === 1 ? 60000 : 30000;
  h.transport.seek(boundary - 250); await h.complete();
  if (playing) { h.transport.play(); await h.complete(); }
  assert.equal(h.transport.activeSlot, previous);
  assert.ok(h.players.every(player => player.playing === playing), 'production composite follows transport intent');
  assert.equal(h.players[1 - previous].muted, !playing || muted, 'prepared composite incoming leg follows playback intent and its clip mute');
  h.calls.length = 0;
  // No intervening render: activate the prepared incoming slot and leave the
  // transition window in the same host commit that removes the composite.
  h.transport.seek(boundary + 1000);
  await h.drainWithoutCommit();
  assert.equal(h.transport.activeSlot, previous, 'published transport is still the old commit');
  assert.equal(h.players[1 - previous].playing, playing, 'controller activated incoming before commit');
  assert.equal(h.players[1 - previous].muted, muted, 'controller restored incoming clip audio');
  h.render(); await h.settle();
  assert.equal(h.transport.activeSlot, 1 - previous);
  assert.equal(h.transport.currentMs, boundary + 1000);
  assert.equal(h.transport.phase, 'ready');
  assert.equal(h.transport.player.muted, muted, 'retirement must preserve the controller audio owner');
  assert.equal(h.transport.player.playing, playing, 'retirement must preserve the controller playback owner');
  assert.equal(h.players[previous].muted, true, 'retired standby is muted');
  assert.equal(h.players[previous].playing, false, 'retired standby is paused');
  assert.ok(!h.calls.some(call => call[0] === 'pause' && call[1] === 1 - previous), 'cleanup never pauses the new owner');
});

test('controller retirement silences transition audio while the ordinary owner remains navigable', async t => {
  const outgoing = { ...clip('out'), transitionAfter: { type: 'crossfade', durationMs: 1000 } };
  const h = harness({ clips: [outgoing, clip('in', 'other')], sourceDurationMs: 60000 });
  t.after(() => h.unmount()); await h.complete();
  h.transport.seek(29750); await h.complete();
  h.transport.play(); await h.complete();
  assert.ok(h.players.every(player => player.playing));
  h.transport.retireComposite();
  assert.equal(h.players[1].playing, false);
  assert.equal(h.players[1].muted, true);
  assert.equal(h.players[0].playing, true);
  assert.equal(h.players[0].muted, true);
  assert.ok(h.players.every(player => player.volume === 0));
  const epochs = h.transport.slots.map(slot => slot.nativeViewEpoch);
  // The standby never owns transport. A fresh ordinary-owner sample can move
  // forward; the still-ready overlay may then explicitly reauthorize its pair.
  h.players[1].emit('timeUpdate', { currentTime: 12 });
  await h.settle();
  assert.equal(h.transport.currentMs, 29750, 'standby cannot advance transport');
  h.players[0].currentTime = 30.85;
  await h.positionAck(0);
  assert.equal(h.transport.currentMs, 29850, 'ordinary source time advances without a frozen play intent');
  assert.deepEqual(h.transport.slots.map(slot => slot.nativeViewEpoch), epochs);
  assert.equal(h.transport.isPlaying, true);
});

for (const previous of [0, 1]) {
  for (const sources of [['source', 'other', 'source', 'other'], ['source', 'source', 'other', 'other']]) {
    test(`native ownership held across React commit blocks retirement: slot ${previous}, ${sources.join('/')}`, async t => {
      const h = harness({ clips: sources.map((source, i) => clip(`cut-${i}`, source)) });
      t.after(() => h.unmount());
      await h.complete(); h.transport.play(); await h.complete();
      if (previous === 1) {
        h.players[0].emit('playToEnd', {}); await h.complete();
      }
      assert.equal(h.transport.activeSlot, previous);
      const nativeOwner = h.holdNativeOwnership();
      h.traceRetirement(true);
      h.players[previous].emit('playToEnd', {});
      await h.drainWithoutCommit();
      assert.deepEqual(h.retirementTrace, [], 'pending React commit retains the outgoing source');
      h.render(); await h.complete();
      assert.equal(h.transport.activeSlot, 1 - previous, 'React has committed the incoming owner');
      const mutations = h.retirementTrace.filter(event => event.slot === nativeOwner.slot);
      const currentView = h.views.find(view => view.player === h.players[previous]);
      assert.deepEqual({ mutations, epoch: h.transport.slots[previous].nativeViewEpoch, path: currentView.nativePath },
        { mutations: [], epoch: nativeOwner.nativeViewEpoch, path: nativeOwner.nativePath },
        'React commit alone cannot authorize source replacement, playback-window installation, or rekey of the held native owner');
    });
  }
}

for (const previous of [0, 1]) {
  for (const sources of [['source', 'other', 'source', 'other'], ['source', 'source', 'other', 'other']]) {
    test(`explicit nativeLeaseGrant permits protected retirement: slot ${previous}, ${sources.join('/')}`, async t => {
      const h = harness({ clips: sources.map((source, i) => clip(`grant-${i}`, source)) });
      t.after(() => h.unmount()); await h.complete(); h.transport.play(); await h.complete();
      if (previous === 1) { h.players[0].emit('playToEnd', {}); await h.complete(); }
      h.holdNativeOwnership(); h.traceRetirement(true);
      h.players[previous].emit('playToEnd', {}); await h.complete();
      assert.deepEqual(h.retirementTrace, []);
      await h.nativeLeaseGrant(previous); await h.complete();
      assert.ok(h.retirementTrace.some(event => event.slot === previous && event.operation === 'configureVideoPlaybackWindow'));
      assert.ok(h.calls.some(call => call[0] === 'maskCommit' && call[1] === previous));
      assert.equal(h.transport.activeSlot, 1 - previous);
      assert.equal(h.transport.phase, 'ready');
    });
  }
}

for (const interruption of ['seek', 'background', 'unmount', 'failure', 'timeout']) {
  test(`native lease pending ${interruption} ignores a stale grant without retiring the owner`, async t => {
    const h = harness({ clips: ['source', 'other', 'source'].map((source, i) => clip(`cancel-${i}`, source)) });
    t.after(() => h.unmount()); await h.complete(); h.transport.play(); await h.complete();
    const owner = h.holdNativeOwnership(); h.traceRetirement(true);
    h.players[0].emit('playToEnd', {}); await h.complete();
    const lateGrant = h.players[owner.slot].grantMask;
    assert.equal(typeof lateGrant, 'function');
    if (interruption === 'seek') { h.transport.seek(35000); await h.settle(); }
    if (interruption === 'background') await h.app('background');
    if (interruption === 'unmount') { h.unmount(); await h.settle(); }
    if (interruption === 'failure') { h.players[owner.slot].failMask(new Error('native mask rejected')); await h.settle(); }
    if (interruption === 'timeout') await h.advance(5000);
    lateGrant(); await h.settle();
    assert.deepEqual(h.retirementTrace.filter(event => event.slot === owner.slot), []);
    assert.notEqual(h.transport.slots[owner.slot].readiness, 'ready');
    assert.ok(h.calls.some(call => call[0] === 'maskCancel' && call[1] === owner.slot));
  });
}

test('cancellation after native grant invalidates standby cache before late frame preparation can be reused', async t => {
  const h = harness({ clips: ['source', 'other', 'source'].map((source, i) => clip(`dirty-${i}`, source)) });
  t.after(() => h.unmount()); await h.complete(); h.transport.play(); await h.complete();
  h.holdNativeOwnership(); h.traceRetirement(true);
  h.players[0].emit('playToEnd', {}); await h.complete();
  h.players[0].holdWindow = true;
  await h.nativeLeaseGrant(0);
  const lateWindow = h.players[0].finishWindow;
  const grantedId = h.players[0].nativeLeaseGrant;
  assert.equal(typeof lateWindow, 'function');
  h.transport.seek(35000); await h.settle();
  assert.equal(h.transport.slots[0].firstFrameReady, false);
  assert.ok(h.transport.slots[0].playbackUri === undefined || h.transport.slots[0].prepareToken > grantedId,
    'the cancelled cache is cleared; a later ungranted request may publish its own desired URI');
  lateWindow(); await h.settle();
  assert.equal(h.transport.slots[0].firstFrameReady, false);
  assert.ok(h.calls.some(call => call[0] === 'maskCancel' && call[1] === 0 && call[2] === grantedId));
  assert.equal(h.calls.some(call => call[0] === 'maskCommit' && call[1] === 0 && call[2] === grantedId), false);
  h.players[0].holdWindow = false;
  const replacements = h.calls.filter(call => call[0] === 'replace' && call[1] === 0).length;
  h.transport.seek(65000); await h.settle();
  await h.nativeLeaseGrant(0); await h.complete();
  assert.equal(h.transport.phase, 'ready'); assert.equal(h.transport.activeSlot, 0);
  assert.ok(h.calls.filter(call => call[0] === 'replace' && call[1] === 0).length > replacements);
});

for (const phase of ['acquire', 'commit']) {
  for (const reason of ['abort', 'timeout']) {
    test(`real mask service ${phase} ${reason} settles once and ignores late native resolution`, async t => {
      const h = harness({ clips: [] }); t.after(() => h.unmount()); await h.settle();
      const player = h.players[0], signalOwner = new AbortController();
      player.holdMaskAcquire = phase === 'acquire'; player.holdMaskCommit = phase === 'commit';
      const acquisition = h.maskService.acquireVideoMaskLease(player, h.players[1], 1, 1, false, signalOwner.signal);
      let lease;
      const task = phase === 'acquire' ? acquisition : (lease = await acquisition).commit();
      let settlements = 0;
      const outcome = task.then(() => { settlements++; return undefined; }, error => { settlements++; return error; });
      await h.settle();
      const late = phase === 'acquire' ? player.grantMask : player.finishMaskCommit;
      assert.equal(typeof late, 'function');
      if (reason === 'abort') { signalOwner.abort(); await h.settle(); }
      else await h.advance(5000);
      const error = await outcome;
      assert.ok(error instanceof Error);
      if (reason === 'abort') assert.equal(error.name, 'AbortError');
      else assert.match(error.message, /timed out/);
      assert.equal(h.timerCount, 0);
      late(); await h.settle(); signalOwner.abort(); lease?.cancel();
      assert.equal(settlements, 1);
      assert.equal(h.calls.filter(call => call[0] === 'maskCancel').length, 1);
      assert.equal(h.calls.some(call => call[0] === 'maskCommit'), false);
    });
  }
}

test('empty timeline translation and cleanup make no native window or mask calls', async () => {
  const h = harness({ clips: [] }); await h.settle();
  const suspension = h.transport.suspendForTranslation(); await h.settle(); await suspension.ready;
  await suspension.restore(); await h.settle(); h.unmount(); await h.settle();
  assert.equal(h.calls.some(call => call[0] === 'window' || call[0].startsWith('mask')), false);
});

test('retirement observer distinguishes a hidden preload from the committed foreground', async t => {
  const h = harness({ clips: [clip('cut-0', 'source'), clip('cut-1', 'other')] });
  t.after(() => h.unmount()); h.traceRetirement(true); await h.complete(); h.traceRetirement(false);
  const standby = h.retirementTrace.filter(event => event.slot === 1);
  assert.ok(standby.some(event => event.operation === 'configureVideoPlaybackWindow'));
  assert.ok(standby.every(event => event.committedActiveSlot === 0
    && event.committedViews.length === 2
    && event.committedViews.find(view => view.slot === 0).foreground
    && !event.committedViews.find(view => view.slot === 1).foreground));
});

for (const sources of [['source', 'other'], ['other', 'source']]) {
  test(`clean-cut ${sources.join('/')} retirement waits for foreground host commit in both slot directions`, async t => {
    // A/B/A/B: each decoder is reused for its original URI. This still installs
    // a fresh native playback window; replaceAsync-only spies miss that path.
    const clips = Array.from({ length: 4 }, (_, i) => clip(`cut-${i}`, sources[i % 2]));
    const h = harness({ clips }); t.after(() => h.unmount());
    await h.complete(); h.transport.play(); await h.complete();
    assert.equal(h.transport.phase, 'ready');
    assert.equal(h.transport.activeSlot, 0);
    assert.deepEqual(Array.from(h.transport.slots, slot => slot.preparedClipId), ['cut-0', 'cut-1']);
    const paths = h.views.map(view => view.nativePath);
    const beforeCommits = [];
    h.traceRetirement(true);
    for (const [previous, incoming, clipId] of [[0, 1, 'cut-1'], [1, 0, 'cut-2']]) {
      const start = h.retirementTrace.length;
      assert.equal(h.transport.activeSlot, previous);
      h.players[previous].emit('playToEnd', {});
      await h.drainWithoutCommit();
      assert.equal(h.transport.activeSlot, previous, 'the previous host commit is still installed');
      assert.deepEqual(h.views.map(view => view.nativePath), paths, 'no layout or mount change during pending commit');
      beforeCommits.push({ previous, incoming, operations: h.retirementTrace.slice(start) });
      h.render(); await h.complete();
      assert.equal(h.transport.activeSlot, incoming);
      assert.equal(h.transport.slots[incoming].preparedClipId, clipId);
      assert.deepEqual(h.views.map(view => view.nativePath), paths, 'handoff retains both native hosts');
    }
    h.traceRetirement(false);
    t.diagnostic(JSON.stringify({ beforeCommits, allInstallations: h.retirementTrace }));
    const installations = h.retirementTrace.filter(event => event.operation === 'configureVideoPlaybackWindow');
    assert.ok(installations.some(event => event.slot === 0) && installations.some(event => event.slot === 1),
      'exercise actual preparation requests for both retired decoder slots');
    const foregroundInstallations = h.retirementTrace.filter(event =>
      event.committedViews.some(view => view.slot === event.slot && view.foreground));
    assert.deepEqual(foregroundInstallations, [],
      'native item replacement must wait until the retained outgoing host is no longer foreground');
  });
}

for (const interruption of ['pause', 'superseding seek', 'rapid A/B/A', 'background', 'active error', 'unmount']) {
  test(`pending retirement preload respects ${interruption}`, async t => {
    const h = harness({ clips: [clip('cut-0'), clip('cut-1', 'other'), clip('cut-2')] });
    t.after(() => h.unmount()); await h.complete();
    h.transport.play(); await h.complete();
    const paths = h.views.map(view => view.nativePath);
    h.traceRetirement(true);
    h.players[0].emit('playToEnd', {}); await h.drainWithoutCommit();
    assert.equal(h.transport.activeSlot, 0, 'outgoing host still committed');
    assert.deepEqual(h.retirementTrace, [], 'no installation while retirement commit is pending');
    if (interruption === 'pause') h.transport.pause();
    if (interruption === 'superseding seek') h.transport.seek(31000);
    if (interruption === 'rapid A/B/A') h.transport.seek(1000);
    if (interruption === 'background') await h.app('background');
    if (interruption === 'active error') h.players[1].emit('statusChange', { status: 'error', error: new Error('decoder failed') });
    if (interruption === 'unmount') h.unmount();
    await h.drainWithoutCommit();
    assert.deepEqual(h.retirementTrace, [], 'interrupting work cannot flush the retired preload before commit');
    h.render(); await h.complete();
    if (interruption === 'superseding seek') {
      assert.equal(h.transport.activeSlot, 1);
      assert.equal(h.transport.currentMs, 31000);
      assert.equal(h.transport.slots[0].preparedClipId, 'cut-2', 'latest request still preloads after commit');
      assert.ok(h.retirementTrace.some(event => event.operation === 'configureVideoPlaybackWindow' && event.slot === 0));
      assert.deepEqual(h.retirementTrace.filter(event =>
        event.committedViews.some(view => view.slot === event.slot && view.foreground)), []);
    } else {
      assert.deepEqual(h.retirementTrace, [], 'cancelled preload cannot restart on a later render');
    }
    if (interruption === 'rapid A/B/A') {
      assert.equal(h.transport.activeSlot, 0);
      assert.equal(h.transport.currentMs, 1000);
      assert.equal(h.transport.slots[0].preparedClipId, 'cut-0', 'outgoing decoder survives the uncommitted round trip');
    }
    if (interruption === 'background') assert.equal(h.transport.phase, 'suspended');
    if (interruption === 'active error') assert.equal(h.transport.phase, 'error');
    if (interruption !== 'background' && interruption !== 'unmount') {
      if (interruption !== 'active error') assert.equal(h.transport.phase, 'ready');
      assert.deepEqual(h.views.map(view => view.nativePath), paths);
    }
    assert.equal(h.timerCount, 0);
  });
}

test('paused clean-cut retirement releases preload after commit without starting playback', async t => {
  const h = harness({ clips: [clip('cut-0'), clip('cut-1', 'other'), clip('cut-2')] });
  t.after(() => h.unmount()); await h.complete(); h.traceRetirement(true);
  h.transport.seek(31000); await h.drainWithoutCommit();
  assert.equal(h.transport.activeSlot, 0);
  assert.deepEqual(h.retirementTrace, []);
  h.render(); await h.complete();
  assert.equal(h.transport.activeSlot, 1);
  assert.equal(h.transport.slots[0].preparedClipId, 'cut-2');
  assert.ok(h.retirementTrace.some(event => event.operation === 'configureVideoPlaybackWindow'));
  assert.deepEqual(h.retirementTrace.filter(event =>
    event.committedViews.some(view => view.slot === event.slot && view.foreground)), []);
  assert.equal(h.calls.some(call => call[0] === 'play'), false);
  assert.equal(h.timerCount, 0);
});

test('transition retirement keeps the outgoing decoder until the tail exit commits', async t => {
  const h = harness({ sourceDurationMs: 60000, clips: [
    { ...clip('cut-0'), transitionAfter: { type: 'crossfade', durationMs: 1001 } },
    clip('cut-1', 'other'), clip('cut-2'),
  ] });
  t.after(() => h.unmount()); await h.complete(); h.transport.play(); await h.complete();
  h.transport.seek(30000); await h.complete();
  assert.equal(h.transport.activeSlot, 1);
  assert.equal(h.transport.slots[0].preparedClipId, 'cut-0');
  const paths = h.views.map(view => view.nativePath);
  h.traceRetirement(true);
  await h.advance(501);
  assert.deepEqual(h.retirementTrace, [], 'wall time cannot retire a still-committed composite');
  h.players[1].currentTime = 1.6;
  h.players[1].emit('timeUpdate', { currentTime: 1.6 });
  await h.drainWithoutCommit();
  assert.deepEqual(h.retirementTrace, [], 'clock advancement without a React commit cannot retire the tail');
  h.render(); await h.complete();
  assert.ok(h.transport.currentMs >= 30501);
  assert.equal(h.transport.slots[0].preparedClipId, 'cut-2');
  assert.ok(h.retirementTrace.some(event => event.operation === 'configureVideoPlaybackWindow' && event.slot === 0));
  assert.deepEqual(h.retirementTrace.filter(event =>
    event.committedViews.some(view => view.slot === event.slot && view.foreground)), []);
  assert.deepEqual(h.views.map(view => view.nativePath), paths);
});

test('authored trailing gap still uses its canvas clock through the rounded project endpoint', async t => {
  const final = { ...clip(), sourceStartMs: 0, sourceEndMs: 6385.416666666667, gapAfterMs: 20.25 };
  const h = harness({ clips: [final], allowGapClock: true }); t.after(() => h.unmount()); await h.complete();
  h.transport.play(); await h.complete();
  h.players[h.transport.activeSlot].emit('playToEnd', {}); await h.settle();
  assert.equal(h.transport.phase, 'gap'); assert.equal(h.transport.isGap, true);
  assert.equal(h.transport.currentMs, final.sourceEndMs);
  assert.equal(h.calls.filter(call => call[0] === 'gapRAF').length, 1);
  await h.advance(10);
  assert.equal(h.transport.currentMs, final.sourceEndMs + 10);
  assert.equal(h.transport.isPlaying, true);
  await h.advance(12);
  assert.equal(h.transport.phase, 'ended');
  assert.equal(h.transport.currentMs, Math.ceil(final.sourceEndMs + final.gapAfterMs));
  assert.equal(h.transport.isGap, true); assert.equal(h.transport.isPlaying, false);
});

for (const playbackRate of [0.5, 1, 1.5, 2]) {
  for (const sourceEndMs of [6385.416666666667, 6000]) {
    test(`paused final endpoint remains footage: end ${sourceEndMs}, rate ${playbackRate}`, async t => {
      const final = { ...clip(), sourceStartMs: 0, sourceEndMs, playbackRate };
      const h = harness({ clips: [final], nativeClock: true }); t.after(() => h.unmount());
      await h.complete();
      const end = sourceEndMs / playbackRate, duration = Math.ceil(end);
      for (const target of [end, (end + duration) / 2, duration]) {
        h.transport.seek(target); await h.complete(); h.transport.pause(); await h.settle();
        assert.equal(h.transport.currentMs, target);
        assert.equal(h.transport.phase, 'ready');
        assert.equal(h.transport.isGap, false);
        assert.equal(h.transport.isPlaying, false);
        assert.equal(h.transport.sourceFailure, undefined);
        assert.ok(h.views.length > 0, 'footage surface remains mounted');
        assert.equal(h.transport.slots[h.transport.activeSlot].preparedClipId, final.id);
        assert.ok(h.players[h.transport.activeSlot].currentTime * 1000 <= sourceEndMs);
      }
      assert.equal(h.calls.some(call => call[0] === 'play'), false);
    });
  }
  for (const event of ['timeUpdate', 'playToEnd', 'playingChange']) {
    test(`fractional playback ends without a gap RAF: ${event}, rate ${playbackRate}`, async t => {
      const final = { ...clip(), sourceStartMs: 0, sourceEndMs: 6385.416666666667, playbackRate };
      const h = harness({ clips: [final] }); t.after(() => h.unmount()); await h.complete();
      h.transport.play(); await h.complete();
      const player = h.players[h.transport.activeSlot];
      player.currentTime = final.sourceEndMs / 1000;
      player.emit(event, { currentTime: player.currentTime, isPlaying: false }); await h.settle();
      assert.equal(h.transport.phase, 'ended');
      assert.equal(h.transport.currentMs, final.sourceEndMs / playbackRate);
      assert.equal(h.transport.isPlaying, false);
      assert.equal(h.transport.isGap, false);
      assert.equal(h.transport.sourceFailure, undefined);
      assert.ok(h.views.length > 0);
      assert.equal(player.playing, false);
    });
  }
}

test('independent app harnesses keep clocks, native calls and teardown isolated', async t => {
  const first = harness(), second = harness();
  t.after(() => { first.unmount(); second.unmount(); });
  await first.complete(); await second.complete();
  assert.equal(first.transport.phase, 'ready');
  assert.equal(second.transport.phase, 'ready');
  const untouched = second.calls.length;
  first.transport.seek(2000); await first.settle();
  assert.equal(first.transport.currentMs, 2000);
  assert.equal(second.transport.currentMs, 0);
  assert.equal(second.calls.length, untouched);
  first.unmount();
  await second.app('background'); await second.app('active'); await second.complete();
  assert.equal(second.transport.phase, 'ready');
  assert.equal(second.transport.currentMs, 0);
});

test('load-time frame plus an unrelated position 115ms away cannot certify preparation', async t => {
  const h = harness({ holdReplacement: true }); t.after(() => h.unmount()); await h.settle();
  await h.frame(0); // Source load has not completed and no target has been assigned.
  h.players[0].holdWindow = true;
  h.players[0].finishReplacement(); await h.settle();
  h.players[0].emit('timeUpdate', { currentTime: 1.115 }); await h.settle();
  assert.notEqual(h.transport.phase, 'ready', 'load frame and nearby stale clock are unrelated receipts');
  assert.equal(h.transport.slots[0].firstFrameReady, false);
  await h.positionAck(0); assert.notEqual(h.transport.phase, 'ready');
  await h.frame(0); assert.notEqual(h.transport.phase, 'ready');
  h.players[0].finishWindow(); await h.settle();
  assert.notEqual(h.transport.phase, 'ready');
  await h.positionAck(0); assert.equal(h.transport.phase, 'ready');
});

test('iOS legacy: position ACK remounts only its slot; pre-ACK view and wrong-slot frames cannot certify the new epoch', async t => {
  const h = harness({ platform: 'ios' }); t.after(() => h.unmount()); await h.settle();
  const before = h.views.map(view => ({ path: view.nativePath, frame: view.onFirstFrameRender }));
  await h.frame(0); // Even a frame after target assignment is disarmed until ACK.
  await h.positionAck(0);
  assert.notEqual(h.transport.phase, 'ready', 'position ACK alone needs a new native-view receipt');
  assert.notEqual(h.views[0].nativePath, before[0].path);
  assert.equal(h.views[1].nativePath, before[1].path);
  before[0].frame(); await h.frame(1);
  assert.equal(h.transport.slots[0].firstFrameReady, false);
  assert.notEqual(h.transport.phase, 'ready');
  await h.frame(0); assert.equal(h.transport.phase, 'ready');
});

test('iOS legacy: position listener precedes target assignment, including a synchronous native ACK', async t => {
  const h = harness({ platform: 'ios', holdReplacement: true }); t.after(() => h.unmount());
  h.players[0].ackOnSeek = true;
  h.players[0].finishReplacement(); await h.settle();
  await h.frame(0);
  assert.equal(h.transport.phase, 'ready', 'a synchronous seek ACK must not be lost');
  assert.equal(h.timerCount, 0);
});

test('replacement is paused and muted before native load begins', async t => {
  const h = harness({ holdReplacement: true }); t.after(() => h.unmount()); await h.settle();
  assert.ok(h.calls.findIndex(call => call[0] === 'pause') < h.calls.findIndex(call => call[0] === 'replace'));
  assert.equal(h.players[0].muted, true);
});

test('iOS legacy: new-epoch frame delivered during publication is latched before waiter registration', async t => {
  const h = harness({ platform: 'ios', frameOnPublish: true }); t.after(() => h.unmount()); await h.settle();
  await h.positionAck(0);
  assert.equal(h.transport.phase, 'ready'); assert.equal(h.timerCount, 0);
});

test('cancel between position receipt and continuation cannot publish a render epoch', async t => {
  const h = harness(); t.after(() => h.unmount()); await h.settle();
  const before = h.transport.slots[0].nativeViewEpoch;
  h.players[0].emit('timeUpdate', { currentTime: h.players[0].currentTime });
  await h.app('background');
  const retired = h.transport.slots[0].nativeViewEpoch;
  assert.ok(retired > before);
  await h.settle(); assert.equal(h.transport.slots[0].nativeViewEpoch, retired);
  assert.equal(h.transport.phase, 'suspended'); assert.equal(h.timerCount, 0);
  await h.app('active'); await h.complete(); assert.equal(h.transport.phase, 'ready');
});

for (const position of [6.385, Math.fround(6.385), 6.385416, 6.5, 6.384, NaN, Infinity]) {
  test(`fractional preparation accepts only native precision ACK: ${position}`, async t => {
    const h = harness({ sourceDurationMs: 8000, clips: [{ ...clip(), sourceStartMs: 6385.416, sourceEndMs: 8000 }] });
    t.after(() => h.unmount()); await h.settle();
    h.players[0].emit('timeUpdate', { currentTime: position }); await h.settle();
    await h.frame(0);
    if ([6.385, Math.fround(6.385), 6.385416].includes(position)) {
      assert.equal(h.transport.phase, 'ready');
    } else {
      assert.notEqual(h.transport.phase, 'ready');
      await h.advance(5000); assert.equal(h.transport.phase, 'error');
    }
  });
}

for (const platform of ['ios', 'web']) {
  test(`${platform} preparation accepts its native precision ACK before requiring a new view frame`, async t => {
    const target = 6.385416;
    const h = harness({ clips: [{ ...clip(), sourceStartMs: target * 1000 }], platform });
    t.after(() => h.unmount()); await h.settle();
    const before = h.views[0].onFirstFrameRender;
    h.players[0].emit('timeUpdate', { currentTime: platform === 'ios'
      ? Math.round(target * 0x7fffffff) / 0x7fffffff : target });
    await h.settle(); before(); await h.settle();
    assert.notEqual(h.transport.phase, 'ready');
    await h.frame(0); assert.equal(h.transport.phase, 'ready');
  });
}

test('iOS legacy: timed-out view callback stays retired during retry load and after retry position ACK', async t => {
  const h = harness({ platform: 'ios' }); t.after(() => h.unmount()); await h.settle();
  await h.positionAck(0);
  const retired = h.views[0].onFirstFrameRender;
  const epoch = h.transport.slots[0].nativeViewEpoch;
  await h.advance(5000); assert.equal(h.transport.phase, 'error');
  assert.match(h.transport.sourceFailure.detail, /did not render a frame/);
  h.players[0].holdReplacement = true;
  h.transport.retrySource(); await h.settle();
  retired(); await h.settle(); assert.equal(h.transport.slots[0].firstFrameReady, false);
  h.players[0].finishReplacement(); await h.settle(); await h.positionAck(0);
  assert.ok(h.transport.slots[0].nativeViewEpoch > epoch);
  retired(); await h.frame(1); assert.notEqual(h.transport.phase, 'ready');
  await h.frame(0); assert.equal(h.transport.phase, 'ready'); assert.equal(h.timerCount, 0);
  assert.equal(h.calls.some(call => call[0] === 'play'), false);
});

test('iOS legacy: unmount after position ACK cancels the new-epoch frame waiter and rejects its late callback', async () => {
  const h = harness({ platform: 'ios' }); await h.settle(); await h.positionAck(0);
  const frame = h.views[0].onFirstFrameRender;
  h.unmount(); const count = h.calls.length;
  frame(); await h.advance(15000);
  assert.equal(h.calls.length, count); assert.equal(h.timerCount, 0);
  assert.ok(h.players.every(player => player.listenerCount() === 0));
});

test('iOS legacy: position and fresh-view receipts share the original five-second preparation budget', async t => {
  const h = harness({ platform: 'ios' }); t.after(() => h.unmount()); await h.settle();
  await h.advance(4999); assert.notEqual(h.transport.phase, 'error');
  await h.positionAck(0); assert.notEqual(h.transport.phase, 'ready');
  const expired = h.views[0].onFirstFrameRender;
  await h.advance(1); assert.equal(h.transport.phase, 'error');
  assert.match(h.transport.sourceFailure.detail, /did not render a frame/);
  expired(); await h.settle(); assert.equal(h.transport.slots[0].firstFrameReady, false);
  h.transport.retrySource(); await h.complete(); assert.equal(h.transport.phase, 'ready');
  assert.equal(h.timerCount, 0);
});

test('fractional paused target keeps its domain clock through Home and rejects the observed old 6.500s receipt', async t => {
  const endpoint = { ...clip(), sourceStartMs: 0, sourceEndMs: 8000, availableSourceEndMs: 8000 };
  const h = harness({ sourceDurationMs: 8000, clips: [endpoint] }); t.after(() => h.unmount());

  await h.complete(); h.transport.seek(6385.416); await h.settle();
  assert.equal(h.transport.currentMs, 6385.416);
  const retired = h.views[0].onFirstFrameRender;
  h.players[0].holdWindow = true;
  await h.app('background'); await h.app('active');
  const loadView = h.views[0].onFirstFrameRender;
  retired(); loadView();
  h.players[0].emit('timeUpdate', { currentTime: 6.5 }); await h.settle();
  assert.notEqual(h.transport.phase, 'ready'); assert.equal(h.transport.slots[0].firstFrameReady, false);
  h.players[0].emit('timeUpdate', { currentTime: 6.385 }); await h.settle();
  retired(); loadView(); await h.settle(); assert.notEqual(h.transport.phase, 'ready');
  await h.frame(0); assert.notEqual(h.transport.phase, 'ready');
  h.players[0].finishWindow(); await h.settle();
  h.players[0].emit('timeUpdate', { currentTime: 6.5 }); await h.settle();
  assert.notEqual(h.transport.phase, 'ready');
  await h.positionAck(0); assert.equal(h.transport.phase, 'ready');
  assert.equal(h.transport.currentMs, 6385.416); assert.equal(h.players[0].currentTime, 6.385416);
  assert.equal(h.calls.some(call => call[0] === 'play'), false);
});

for (const scenario of ['load', 'seek', 'Home', 'standby', 'composite']) {
  test(`paused ${scenario} preparation accepts native clock and first frame without playing`, async t => {
    const trimmed = { ...clip(), sourceStartMs: 0, sourceEndMs: 6385, availableSourceEndMs: 8000 };
    const first = scenario === 'composite' ? { ...clip(), transitionAfter: { type: 'crossfade', durationMs: 1000 } } : trimmed;
    const h = harness({ sourceDurationMs: first === trimmed ? 8000 : 60000, clips: ['standby', 'composite'].includes(scenario) ? [first, clip('b', 'other')] : [first] });
    t.after(() => h.unmount());
    await h.pausedEvents();
    // Active completion can schedule standby preparation on the next turn.
    await h.pausedEvents();
    assert.equal(h.transport.phase, 'ready');
    if (scenario === 'seek' || scenario === 'Home') {
      h.transport.seek(6385); await h.settle();
      await h.pausedEvents();
      assert.equal(h.transport.player.currentTime, 6.384);
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
      assert.equal(h.transport.currentMs, 6385); assert.equal(h.transport.player.currentTime, 6.384);
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
  h.players[slot].holdWindow = true;
  await h.app('background'); await h.app('active');
  h.transport.play(); await h.settle();
  assert.equal(h.calls.some(call => call[0] === 'play'), false, 'intent waits for preparation');
  await h.positionAck(slot); assert.equal(h.calls.some(call => call[0] === 'play'), false);
  await h.frame(slot); assert.equal(h.calls.some(call => call[0] === 'play'), false);
  h.players[slot].finishWindow(); await h.settle();
  assert.equal(h.calls.some(call => call[0] === 'play'), false);
  await h.positionAck(slot);
  assert.equal(h.transport.phase, 'ready'); assert.equal(h.transport.isPlaying, true);
  assert.equal(h.transport.activeSlot, slot); assert.equal(h.transport.slots[slot].preparedClipId, 'b');
  assert.deepEqual(h.calls.filter(call => call[0] === 'play'), [['play', slot, false]]);
  assert.equal(h.players[slot].playing, true); assert.equal(h.players[1 - slot].playing, false);
});

test('ordinary play and repeated same-clip scrubs keep a ready slot during transient native loading', async t => {
  const h = harness(); t.after(() => h.unmount()); await h.complete();
  const slot = h.transport.activeSlot, token = h.transport.slots[slot].prepareToken;
  const epoch = h.transport.slots[slot].nativeViewEpoch;
  const nativePath = h.views.find(view => view.player === h.players[slot]).nativePath;
  const replacements = h.calls.filter(call => call[0] === 'replace').length;
  h.players[slot].status = 'loading';
  h.players[slot].emit('statusChange', { status: 'loading' });
  h.transport.play(); await h.settle();
  for (const target of [21800, 8000, 8000, 12000]) {
    h.transport.seek(target); await h.settle();
    assert.equal(h.transport.phase, 'ready'); assert.equal(h.transport.activeSlot, slot);
    assert.equal(h.transport.slots[slot].readiness, 'ready');
    assert.equal(h.transport.slots[slot].prepareToken, token);
    assert.equal(h.transport.slots[slot].nativeViewEpoch, epoch);
    assert.equal(h.views.find(view => view.player === h.players[slot]).nativePath, nativePath);
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
    h.players[slot].holdWindow = true;
    h.transport.seek(target); await h.settle();
    assert.ok(h.transport.slots[slot].prepareToken > token, 'seek must exercise preparation');
    assert.equal(h.calls.filter(call => call[0] === 'replace').length, replacements,
      'ordinary same-URI preparation must retain the loaded decoder during transient loading');
    assert.equal(h.transport.slots[slot].readiness, 'preparing');
    await h.positionAck(slot); assert.notEqual(h.transport.phase, 'ready', 'native presentation remains mandatory');
    await h.frame(slot); assert.notEqual(h.transport.phase, 'ready');
    h.players[slot].finishWindow(); await h.settle();
    await h.positionAck(slot);
    assert.equal(h.transport.phase, 'ready'); assert.equal(h.transport.activeSlot, slot);
    assert.equal(h.transport.slots[slot].readiness, 'ready');
    assert.equal(h.transport.currentMs, target); assert.equal(h.transport.isPlaying, false);
    assert.equal(h.players[slot].currentTime, 2.8);
  }
  await h.advance(15000); assert.equal(h.transport.phase, 'ready'); assert.equal(h.timerCount, 0);
  assert.equal(h.calls.filter(call => call[0] === 'replace').length, replacements);
  assert.equal(h.calls.some(call => call[0] === 'play'), false, 'same-URI repreparation remains paused');
});

test('Home detaches actual overlay; resume at 21.8s reloads once and needs native presentation AND playback position', async t => {
  const h = harness(); t.after(() => h.unmount()); await h.complete();
  h.transport.seek(21800); await h.complete();
  const retired = h.views.map(view => view.onFirstFrameRender), tokens = h.transport.slots.map(slot => slot.prepareToken);
  const replacements = h.calls.filter(call => call[0] === 'replace').length;
  await h.app('background'); assert.equal(h.views.length, 0);
  assert.equal(h.transport.slots.some(slot => slot.firstFrameReady), false);
  retired.forEach(callback => callback()); await h.settle();
  assert.equal(h.transport.slots.some(slot => slot.firstFrameReady), false);
  h.players[0].holdWindow = true;
  await h.app('active');
  assert.equal(h.transport.currentMs, 21800); assert.equal(h.transport.isPlaying, false);
  assert.notEqual(h.transport.phase, 'ready');
  const slot = h.transport.slots.findIndex(value => value.readiness === 'preparing');
  assert.ok(slot >= 0); assert.ok(h.transport.slots[slot].prepareToken > tokens[slot]);
  assert.equal(h.players[slot].currentTime, 22.8);
  retired.forEach(callback => callback()); await h.positionAck(slot);
  assert.notEqual(h.transport.phase, 'ready');
  await h.frame(slot); assert.notEqual(h.transport.phase, 'ready');
  h.players[slot].finishWindow(); await h.settle(); await h.positionAck(slot); assert.equal(h.transport.phase, 'ready');
  assert.equal(h.transport.currentMs, 21800); assert.equal(h.players[slot].playing, false);
  assert.equal(h.calls.filter(call => call[0] === 'replace').length, replacements + 1);
  assert.equal(h.calls.filter(call => call[0] === 'play').length, 0);
});

test('diag998 retained ready EOF item needs replacement on all three Home restores', async t => {
  const endpoint = { ...clip(), sourceStartMs: 0, sourceEndMs: 8000, availableSourceEndMs: 8000 };
  const h = harness({ sourceDurationMs: 8000, clips: [endpoint] }); t.after(() => h.unmount());

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
    await h.eofEvents(slot, mediaItem); // load-time frame at zero, clock ack while loading
    assert.notEqual(h.transport.phase, 'ready', 'a frame and clock cannot bypass source readiness');
    await h.advance(6000); assert.notEqual(h.transport.phase, 'error');
    assert.equal(h.calls.filter(call => call[0] === 'play').length, plays);
    player.status = 'readyToPlay'; player.emit('statusChange', { status: 'readyToPlay' }); await h.settle();
    assert.equal(player.currentTime, 7.999, 'native seek stays inside whole-media EOF');
    assert.notEqual(h.transport.phase, 'ready', 'pre-seek clock ack cannot satisfy the new waiter');
    await h.eofEvents(slot, mediaItem);
    assert.equal(h.transport.phase, 'ready'); assert.equal(h.transport.sourceFailure, undefined);
    assert.equal(h.transport.currentMs, 8000); assert.equal(h.transport.isPlaying, false);
    assert.equal(h.players.some(value => value.playing), false);
    assert.equal(player.currentTime, 7.999, 'activation preserves the effective native target');
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
    const h = harness({ sourceDurationMs: 8000, clips: [endpoint] }); t.after(() => h.unmount());

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
      player.holdWindow = true; player.holdReplacement = true; player.replacementStatus = 'loading';
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
      assert.equal(player.currentTime, 7.999, 'native endpoint stays inside the loaded item');
      const epoch = h.transport.slots[slot].nativeViewEpoch;
      await h.frame(slot); await h.positionAck(slot);
      assert.notEqual(h.transport.phase, 'ready', 'public frames and clocks cannot replace native presentation');
      await h.advance(4999); assert.notEqual(h.transport.phase, 'error');
      player.finishWindow(); await h.settle();
      assert.notEqual(h.transport.phase, 'ready', 'pre-presentation ACK cannot satisfy the new waiter');
      await h.positionAck(slot);
      assert.equal(h.transport.slots[slot].nativeViewEpoch, epoch);
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
  h.players[0].holdWindow = true;
  await h.app('background'); await h.app('active');
  const slot = h.transport.slots.findIndex(value => value.readiness === 'preparing');
  retired.forEach(callback => callback()); await h.positionAck(slot);
  await h.advance(4999); assert.notEqual(h.transport.phase, 'error');
  await h.advance(1); assert.equal(h.transport.phase, 'error');
  assert.match(h.transport.sourceFailure.detail, /playback window timed out/);
  assert.equal(h.transport.currentMs, 21800); assert.equal(h.players[slot].playing, false);
  h.players[slot].holdWindow = false;
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
  const h = harness({ holdReplacement: true }); t.after(() => h.unmount()); await h.settle();
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
  const epoch = h.transport.slots[0].nativeViewEpoch;
  const lease = h.transport.suspendForTranslation(); await h.settle(); await lease.ready;
  assert.equal(h.views.length, 0); assert.equal(h.players.every(player => player.status === 'idle'), true);
  const unloadedEpoch = h.transport.slots[0].nativeViewEpoch;
  assert.ok(unloadedEpoch > epoch);
  await h.app('background'); await lease.restore(); await lease.restore(); await h.settle();
  assert.equal(h.transport.phase, 'suspended');
  const count = h.calls.filter(call => call[0] === 'replace').length;
  h.players[0].holdWindow = true;
  await h.app('active'); await h.settle();
  assert.ok(h.transport.slots[0].prepareToken > token);
  assert.ok(h.transport.slots[0].nativeViewEpoch >= unloadedEpoch, 'runtime factory must preserve retired epoch identity');
  const restoredEpoch = h.transport.slots[0].nativeViewEpoch;
  retired.forEach(callback => callback()); await h.positionAck(0);
  assert.notEqual(h.transport.phase, 'ready');
  await h.frame(0); assert.notEqual(h.transport.phase, 'ready');
  h.players[0].finishWindow(); await h.settle(); await h.positionAck(0); assert.equal(h.transport.phase, 'ready');
  assert.equal(h.transport.slots[0].nativeViewEpoch, restoredEpoch, 'presentation retains the restored view');
  assert.equal(h.transport.currentMs, 21800); assert.equal(h.transport.isPlaying, false);
  assert.equal(h.calls.filter(call => call[0] === 'replace').length, count + 1);
});

test('composite consumers cannot reuse detached active/standby frames on foreground', async t => {
  const first = clip(); first.transitionAfter = { type: 'crossfade', durationMs: 1000 };
  const h = harness({ sourceDurationMs: 60000, clips: [first, clip('b', 'other')] }); t.after(() => h.unmount()); await h.complete();
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

for (const duration of [8, 7.999, 7.95, Math.fround(7.95)]) {
  for (const preview of [false, true]) {
    test(`whole-media EOF request normalizes loaded ${duration}s ${preview ? 'preview' : 'local'} and activation retains it`, async t => {
      const endpoint = { ...clip(), sourceStartMs: 0, sourceEndMs: 8000, availableSourceEndMs: 8000 };
      const h = harness({ sourceDurationMs: 8000, clips: [endpoint], nativeDuration: duration, nativeClock: true });
      t.after(() => h.unmount());
      if (preview) h.project.sources[0].previewUri = 'file:///editing-preview.mp4';
      await h.complete(); h.transport.seek(8000); await h.settle(); h.players.forEach(player => { player.holdWindow = true; }); await h.app('background'); await h.app('active');
      const slot = h.transport.slots.findIndex(value => value.readiness === 'preparing');
      const expected = (Math.round(duration * 1000) - 1) / 1000;
      assert.equal(h.calls.filter(call => call[0] === 'nativePosition').at(-1)[2], expected, 'normalize the native request before ACK');
      assert.equal(h.transport.currentMs, 8000);
      const oldFrame = h.views.find(view => view.player === h.players[slot]).onFirstFrameRender;
      oldFrame(); await h.settle();
      const seekCount = h.calls.filter(call => call[0] === 'seek').length;
      for (const stale of [Math.round(duration * 1000) / 1000, expected - .115]) {
        h.players[slot].emit('timeUpdate', { currentTime: stale }); await h.settle(); await h.frame(slot);
        assert.equal(h.transport.slots[slot].firstFrameReady, false, 'only the effective position can arm the frame gate');
      }
      h.players[slot].emit('timeUpdate', { currentTime: expected }); await h.settle();
      assert.notEqual(h.transport.phase, 'ready', 'ACK and public frame cannot replace native presentation');
      oldFrame(); await h.settle(); assert.equal(h.transport.slots[slot].firstFrameReady, false);
      await h.frame(slot); assert.notEqual(h.transport.phase, 'ready');
      h.players[slot].finishWindow(); await h.settle();
      assert.notEqual(h.transport.phase, 'ready', 'clock observation follows native presentation');
      await h.positionAck(slot);
      assert.equal(h.transport.phase, 'ready'); assert.equal(h.transport.currentMs, 8000);
      assert.equal(h.calls.filter(call => call[0] === 'seek').length, seekCount, 'activation must not re-seek raw domain EOF');
      assert.equal(h.transport.sourceFailure, undefined); assert.equal(h.timerCount, 0);
    });
  }
}

for (const duration of [7.75, 6, 0, -1, NaN, Infinity]) {
  test(`invalid or truncated native duration ${duration} cannot certify whole-media EOF`, async t => {
    const h = harness({ sourceDurationMs: 8000, clips: [{ ...clip(), sourceStartMs: 0, sourceEndMs: 8000 }], nativeDuration: duration });
    t.after(() => h.unmount());
    await h.complete(); h.transport.seek(8000); await h.settle(); await h.app('background'); await h.app('active');
    const slot = h.transport.slots.findIndex(value => value.readiness === 'preparing');
    assert.equal(h.calls.filter(call => call[0] === 'nativePosition').at(-1)[2], 8);
    h.players[slot].emit('timeUpdate', { currentTime: Number.isFinite(duration) ? duration - .001 : 7.949 });
    await h.settle(); await h.frame(slot); await h.advance(5000);
    assert.equal(h.transport.phase, 'error'); assert.ok(h.transport.sourceFailure);
    assert.equal(h.transport.currentMs, 8000);
  });
}

for (const endMs of [6385, 6385.9]) {
  test(`capped trim endpoint ${endMs}ms keeps logical clock and seeks inside native EOF in prepare and activation`, async t => {
    const h = harness({ sourceDurationMs: 8000, clips: [{ ...clip(), sourceStartMs: 0, sourceEndMs: endMs }], nativeDuration: 8, nativeClock: true });
    t.after(() => h.unmount());
    const logicalMs = Math.floor(endMs);
    await h.complete(); h.transport.seek(logicalMs); await h.settle(); await h.app('background'); await h.app('active');
    const slot = h.transport.slots.findIndex(value => value.readiness === 'preparing');
    assert.equal(h.calls.filter(call => call[0] === 'window').at(-1)[4], 6385);
    assert.equal(h.calls.filter(call => call[0] === 'nativePosition').at(-1)[2], 6.384);
    assert.equal(h.transport.currentMs, logicalMs);
    h.players[slot].emit('timeUpdate', { currentTime: 6.385 }); await h.settle(); await h.frame(slot);
    assert.notEqual(h.transport.phase, 'ready');
    await h.positionAck(slot); assert.equal(h.transport.phase, 'ready');
    const count = h.calls.filter(call => call[0] === 'seek').length;
    await h.frame(slot); assert.equal(h.transport.phase, 'ready');
    assert.equal(h.transport.currentMs, logicalMs);
    assert.equal(h.calls.filter(call => call[0] === 'seek').length, count, 'activation retains the effective EOF target');
  });
}

for (const platform of ['ios', 'web']) {
  for (const delta of [-.25, .25]) {
    test(`${platform} hook retains legacy ${delta}s ACK window and raw seek target`, async t => {
      const h = harness({ sourceDurationMs: 8000, platform, nativeDuration: 7.95, clips: [{ ...clip(), sourceStartMs: 0, sourceEndMs: 8000 }] });
      t.after(() => h.unmount());
      await h.complete(); h.transport.seek(8000); await h.settle(); await h.app('background'); await h.app('active');
      const slot = h.transport.slots.findIndex(value => value.readiness === 'preparing');
      assert.equal(h.calls.filter(call => call[0] === 'seek').at(-1)[2], 8);
      h.players[slot].emit('timeUpdate', { currentTime: 8 + delta }); await h.settle();
      assert.notEqual(h.transport.phase, 'ready'); await h.frame(slot);
      assert.equal(h.transport.phase, 'ready'); assert.equal(h.transport.currentMs, 8000);
    });
  }
}

for (const interruption of ['native failure', 'cancel', 'new target']) {
  test(`normalized EOF handshake preserves ${interruption} ownership`, async t => {
    const h = harness({ sourceDurationMs: 8000, clips: [{ ...clip(), sourceStartMs: 0, sourceEndMs: 8000 }], nativeDuration: Math.fround(7.95) });
    t.after(() => h.unmount());
    await h.complete(); h.transport.seek(8000); await h.settle();
    await h.app('background'); await h.app('active');
    const slot = h.transport.slots.findIndex(value => value.readiness === 'preparing');
    assert.equal(h.players[slot].currentTime, 7.949);
    await h.positionAck(slot);
    const retired = h.views.find(view => view.player === h.players[slot]).onFirstFrameRender;
    if (interruption === 'native failure') {
      h.players[slot].emit('statusChange', { status: 'error', error: { message: 'decoder failed at EOF' } }); await h.settle();
      retired(); await h.settle();
      assert.equal(h.transport.phase, 'error'); assert.match(h.transport.sourceFailure.detail, /decoder failed at EOF/);
    } else if (interruption === 'cancel') {
      await h.app('background'); retired(); await h.settle();
      assert.equal(h.transport.phase, 'suspended'); assert.equal(h.transport.currentMs, 8000);
    } else {
      h.transport.seek(2000); await h.settle(); retired(); await h.settle();
      // Same-clip preparation can finish for reuse, but its old generation
      // must never activate EOF or overwrite the newly requested domain clock.
      assert.equal(h.transport.currentMs, 2000); await h.complete();
      assert.equal(h.transport.phase, 'ready'); assert.equal(h.transport.currentMs, 2000);
      assert.equal(h.transport.player.currentTime, 2);
    }
    assert.equal(h.timerCount, 0); assert.equal(h.players.some(player => player.playing), false);
  });
}


test('SDK ready precedes native presentation; ACK retains the consumed view without another seek', async t => {
  const h = harness({ sourceDurationMs: 60000, holdReplacement: true }); t.after(() => h.unmount()); await h.settle();
  h.players[0].holdWindow = true;
  await h.settle(); assert.equal(h.calls.some(c => c[0] === 'window'), false);
  h.players[0].finishReplacement(); await h.settle();
  assert.equal(h.calls.filter(c => c[0] === 'window').length, 1);
  assert.equal(h.calls.some(c => c[0] === 'seek'), false);
  await h.frame(0); await h.positionAck(0);
  assert.equal(h.transport.slots[0].firstFrameReady, false);
  assert.notEqual(h.transport.phase, 'ready', 'READY, public frame and ACK cannot bypass held native presentation');
  h.players[0].finishWindow(); await h.settle();
  const epoch = h.transport.slots[0].nativeViewEpoch;
  assert.equal(h.calls.filter(c => c[0] === 'seek').length, 0);
  assert.notEqual(h.transport.phase, 'ready');
  await h.positionAck(0); assert.equal(h.transport.phase, 'ready');
  assert.equal(h.transport.slots[0].nativeViewEpoch, epoch);
  assert.equal(h.calls.filter(c => c[0] === 'seek').length, 0);
});

test('same URI trim change and untrim reload full source through SDK', async t => {
  const h = harness({ sourceDurationMs: 60000 }); t.after(() => h.unmount()); await h.complete();
  for (const end of [6385, 60000]) {
    h.project.clips = [{ ...h.project.clips[0], sourceEndMs: end }];
    h.transport.synchronizeProject(h.project); await h.complete();
    assert.equal(h.transport.phase, 'ready');
    assert.equal(h.players[h.transport.activeSlot].windowEndMs, end === 60000 ? null : end);
  }
  assert.equal(h.calls.filter(c => c[0] === 'replace').length, 3, 'every window contract change reloads through SDK');
  assert.equal(h.calls.filter(c => c[0] === 'window').length, 3, 'full source also requests presentation after SDK contract reload');
});


test('native window, position and frame share five seconds after SDK readiness', async t => {
  const h = harness({ sourceDurationMs: 60000, holdReplacement: true }); t.after(() => h.unmount()); await h.settle();
  h.players[0].holdWindow = true;
  await h.advance(6000); assert.notEqual(h.transport.phase, 'error', 'SDK load has its own existing timeout');
  h.players[0].finishReplacement(); await h.settle();
  await h.advance(4000); h.players[0].finishWindow(); await h.settle();
  await h.advance(999); assert.notEqual(h.transport.phase, 'error');
  await h.advance(1); assert.equal(h.transport.phase, 'error');
  await h.frame(0); assert.equal(h.transport.phase, 'error');
  assert.equal(h.timerCount, 0);
});

for (const sourceDurationMs of [31000, 60000]) {
  for (const reason of ['timeout', 'failure', 'background', 'translation', 'changed trim']) {
    test(`native window ${sourceDurationMs} ${reason} retires its cache and ignores late completion`, async t => {
      const h = harness({ sourceDurationMs, holdReplacement: true }); t.after(() => h.unmount()); await h.settle();
      const player = h.players[0]; player.holdWindow = true;
      player.finishReplacement(); await h.settle();
      const late = player.finishWindow, id = h.calls.find(c => c[0] === 'window')[3];
      let suspension;
      if (reason === 'timeout') await h.advance(5000);
      if (reason === 'failure') { player.failWindow(new Error('window rejected')); await h.settle(); }
      if (reason === 'background') await h.app('background');
      if (reason === 'translation') { suspension = h.transport.suspendForTranslation(); await h.settle(); await suspension.ready; }
      if (reason === 'changed trim') {
        h.project.clips = [{ ...h.project.clips[0], sourceEndMs: 6385 }];
        h.transport.synchronizeProject(h.project); await h.settle();
      }
      if (reason !== 'failure') assert.ok(h.calls.some(c => c[0] === 'cancelWindow' && c[2] === id));
      late(); await h.settle(); await h.frame(0);
      assert.notEqual(h.transport.phase, 'ready', 'late native READY cannot certify a view');
      player.holdWindow = false; player.holdReplacement = false;
      if (reason === 'background') await h.app('active');
      else if (reason === 'translation') await suspension.restore();
      else h.transport.retrySource();
      // The constructor's deliberately held SDK replacement applies to retries too.
      await h.settle(); player.finishReplacement?.(); await h.settle();
      await h.complete();
      assert.equal(h.transport.phase, 'ready');
      const windows = h.calls.filter(c => c[0] === 'window');
      assert.ok(windows.at(-1)[3] > id);
      assert.ok(h.calls.filter(c => c[0] === 'replace' && c[2]).length >= 2, 'retired cache forces SDK reload');
      assert.equal(h.calls.some(c => c[0] === 'play'), false);
      assert.equal(h.timerCount, 0);
    });
  }
}

test('full contiguous source run reuses one presented decoder without another native operation', async t => {
  const a = { ...clip(), sourceStartMs: 0, sourceEndMs: 2000 };
  const b = { ...clip('b'), sourceStartMs: 2000, sourceEndMs: 60000 };
  const h = harness({ sourceDurationMs: 60000, clips: [a, b] }); t.after(() => h.unmount()); await h.complete();
  const token = h.transport.slots[0].prepareToken;
  h.players[0].currentTime = 2; h.transport.seek(2000); await h.settle();
  assert.equal(h.transport.phase, 'ready');
  assert.equal(h.transport.slots[0].preparedClipId, 'b');
  assert.equal(h.transport.slots[0].prepareToken, token);
  assert.equal(h.calls.filter(c => c[0] === 'replace').length, 1);
  assert.equal(h.calls.filter(c => c[0] === 'window').length, 1);
});


test('transition source handles extend the outgoing cap and preserve incoming pretrim clock', async t => {
  const a = { ...clip(), transitionAfter: { type: 'crossfade', durationMs: 1000 } };
  const h = harness({ sourceDurationMs: 60000, clips: [a, clip('b', 'other')] }); t.after(() => h.unmount()); await h.complete();
  assert.equal(h.calls.find(c => c[0] === 'window' && c[1] === 0)[4], 31500);
  assert.equal(h.calls.find(c => c[0] === 'window' && c[1] === 1)[4], 31000);
  h.transport.seek(29750); await h.complete();
  assert.equal(h.players[0].currentTime, 30.75);
  assert.equal(h.players[1].currentTime, .75, 'incoming source pretrim handle remains available because item start is zero');
});

test('new URI full source reloads through SDK before native presentation', async t => {
  const h = harness({ sourceDurationMs: 60000 }); t.after(() => h.unmount()); await h.complete();
  h.project.clips = [{ ...h.project.clips[0], sourceEndMs: 60000 }];
  h.project.sources[0].previewUri = 'file:///new-proxy.mp4';
  h.transport.synchronizeProject(h.project); await h.complete();
  assert.equal(h.transport.phase, 'ready');
  assert.equal(h.calls.filter(c => c[0] === 'replace').at(-1)[2], 'file:///new-proxy.mp4');
  assert.equal(h.calls.filter(c => c[0] === 'window').length, 2, 'new full source needs its own presentation receipt');
});

for (const firstEnd of [10000, 60000]) {
  test(`cancelled standby installation restores the ${firstEnd === 60000 ? 'full' : 'trimmed'} window before reuse`, async t => {
    const a = { ...clip('a'), sourceStartMs: 0, sourceEndMs: firstEnd };
    const b = { ...clip('b', 'other'), sourceStartMs: 0, sourceEndMs: 10000 };
    const c = { ...clip('c'), sourceStartMs: 20000, sourceEndMs: 30000 };
    const h = harness({ sourceDurationMs: 60000, clips: [a, b, c] }); t.after(() => h.unmount());
    await h.complete();
    const standby = h.players[0]; standby.holdWindow = true;
    h.transport.seek(firstEnd + 1000); await h.complete();
    assert.equal(h.transport.activeSlot, 1);
    await h.advance(250);
    assert.equal(standby.windowEndMs, 30000, 'standby item changes before READY');
    const lateReady = standby.finishWindow;
    assert.equal(typeof lateReady, 'function', 'standby READY is still pending');
    const before = h.calls.filter(call => call[0] === 'window').length;
    standby.holdWindow = false;
    h.transport.seek(1000); await h.complete();
    assert.equal(h.transport.phase, 'ready');
    assert.equal(h.transport.currentMs, 1000);
    assert.equal(h.calls.filter(call => call[0] === 'window').length, before + 1,
      'a cancelled installed item cannot reuse the old confirmed-window cache');
    assert.equal(standby.windowEndMs, firstEnd === 60000 ? null : firstEnd);
    lateReady(); await h.settle();
    assert.equal(standby.windowEndMs, firstEnd === 60000 ? null : firstEnd);
    assert.equal(h.transport.phase, 'ready');
    assert.equal(h.calls.some(call => call[0] === 'play'), false);
  });
}

// Finite preparation tests intentionally keep the full 60s SDK source.
test('finite same-end new clip ID at EOF requests a fresh presentation, while ready scrubs reuse it', async t => {
  const h = harness({ sourceDurationMs: 60000, clips: [clip(), clip('b'), clip('c')] });
  t.after(() => h.unmount()); await h.complete();
  const slot = h.transport.activeSlot === 0 ? 1 : 0, player = h.players[slot];
  player.currentTime = 31; player.status = 'idle'; player.holdWindow = true;
  const loads = h.calls.filter(c => c[0] === 'replace').length;
  const windows = h.calls.filter(c => c[0] === 'window').length;
  h.transport.seek(61800); await h.settle();
  assert.equal(h.calls.filter(c => c[0] === 'window').length, windows + 1);
  assert.equal(h.calls.filter(c => c[0] === 'replace').length, loads, 'unchanged contract retains SDK initialization');
  assert.equal(player.windowEndMs, 31000); assert.equal(player.currentTime, 2.8);
  const epoch = h.transport.slots[slot].nativeViewEpoch;
  await h.frame(slot); await h.positionAck(slot); assert.notEqual(h.transport.phase, 'ready');
  player.finishWindow(); await h.settle(); assert.notEqual(h.transport.phase, 'ready');
  const seeks = h.calls.filter(c => c[0] === 'seek').length;
  await h.positionAck(slot);
  assert.equal(h.transport.phase, 'ready'); assert.equal(h.transport.currentMs, 61800);
  assert.equal(h.transport.slots[slot].nativeViewEpoch, epoch);
  assert.equal(h.calls.filter(c => c[0] === 'seek').length, seeks);
  for (const target of [62000, 65000, 65000]) { h.transport.seek(target); await h.settle(); }
  assert.equal(h.calls.filter(c => c[0] === 'window').length, windows + 1, 'ordinary cached scrubs need no presentation request');
});

test('finite contiguous handoff reuses presented source and ready token', async t => {
  const a = { ...clip(), sourceStartMs: 0, sourceEndMs: 2000 };
  const b = { ...clip('b'), sourceStartMs: 2000, sourceEndMs: 6385 };
  const h = harness({ sourceDurationMs: 60000, clips: [a, b] }); t.after(() => h.unmount()); await h.complete();
  const token = h.transport.slots[0].prepareToken;
  h.players[0].currentTime = 2; h.transport.seek(2000); await h.settle();
  assert.equal(h.transport.phase, 'ready'); assert.equal(h.transport.slots[0].preparedClipId, 'b');
  assert.equal(h.transport.slots[0].prepareToken, token);
  assert.equal(h.calls.filter(c => c[0] === 'window').length, 1);
  assert.equal(h.calls.filter(c => c[0] === 'replace').length, 1);
});

for (const duration of [8, 6.38, Math.fround(6.38)]) {
  test(`finite normalization uses SDK full duration ${duration} before installing cap`, async t => {
    const endpoint = { ...clip(), sourceStartMs: 0, sourceEndMs: 6385 };
    const h = harness({ sourceDurationMs: 60000, clips: [endpoint], nativeDuration: duration, nativeClock: true });
    t.after(() => h.unmount()); await h.complete(); h.transport.seek(6385); await h.settle();
    await h.app('background'); await h.app('active');
    const request = h.calls.filter(c => c[0] === 'window').at(-1);
    assert.equal(Math.trunc(request[6]), duration === 8 ? 6384 : 6379);
    const slot = request[1], epoch = h.transport.slots[slot].nativeViewEpoch;
    const seeks = h.calls.filter(c => c[0] === 'seek').length;
    await h.positionAck(slot);
    assert.equal(h.calls.filter(c => c[0] === 'seek').length, seeks, 'activation retains the native effective target'); assert.equal(h.transport.phase, 'ready');
    assert.equal(h.transport.currentMs, 6385); assert.equal(h.transport.slots[slot].nativeViewEpoch, epoch);
    assert.equal(h.timerCount, 0);
  });
}

for (const sourceDurationMs of [31000, 60000]) {
  for (const interruption of ['background', 'translation', 'unmount', 'effect replay']) {
    test(`Android presentation ${sourceDurationMs} cannot survive ${interruption} between ACK and continuation`, async t => {
      const h = harness({ sourceDurationMs }); t.after(() => h.unmount()); await h.settle();
      const player = h.players[0], epoch = h.transport.slots[0].nativeViewEpoch;
      player.emit('timeUpdate', { currentTime: player.currentTime });
      let lease;
      if (interruption === 'background') await h.app('background');
      if (interruption === 'translation') { lease = h.transport.suspendForTranslation(); await h.settle(); await lease.ready; }
      if (interruption === 'unmount') h.unmount();
      if (interruption === 'effect replay') await h.replayEffects();
      await h.settle();
      if (interruption !== 'unmount') {
        assert.notEqual(h.transport.phase, 'ready');
        assert.ok(h.transport.slots[0].nativeViewEpoch > epoch);
        assert.equal(h.transport.slots[0].firstFrameReady, false);
      }
      if (interruption === 'background') await h.app('active');
      if (lease) await lease.restore();
      if (interruption !== 'unmount') { await h.complete(); assert.equal(h.transport.phase, 'ready'); }
      assert.equal(h.timerCount, 0); assert.equal(h.calls.some(c => c[0] === 'play'), false);
    });
  }
}

test('finite endpoint uses SDK Long-to-Float milliseconds before Float division', async t => {
  const end = 16777253;
  assert.notEqual(Math.fround(Math.fround(end) / 1000), Math.fround(end / 1000));
  const h = harness({ sourceDurationMs: 60000000, nativeClock: true,
    clips: [{ ...clip(), sourceStartMs: 0, sourceEndMs: end, availableSourceEndMs: 60000000 }] });
  t.after(() => h.unmount()); await h.complete(); h.transport.seek(end); await h.settle();
  await h.app('background'); await h.app('active');
  const request = h.calls.filter(c => c[0] === 'window').at(-1);
  assert.equal(request[4], end); assert.equal(Math.trunc(request[6]), end - 2);
  const slot = request[1], epoch = h.transport.slots[slot].nativeViewEpoch;
  const seeks = h.calls.filter(c => c[0] === 'seek').length;
  await h.positionAck(slot); assert.equal(h.transport.phase, 'ready');
  assert.equal(h.transport.currentMs, end); assert.equal(h.transport.slots[slot].nativeViewEpoch, epoch);
  assert.equal(h.calls.filter(c => c[0] === 'seek').length, seeks);
});

for (const sourceDurationMs of [31000, 60000]) {
  test(`rotation retains Android ${sourceDurationMs} SDK view during presentation and after ACK`, async t => {
    const h = harness({ sourceDurationMs, holdReplacement: true }); t.after(() => h.unmount()); await h.settle();
    const player = h.players[0]; player.holdWindow = true;
    player.finishReplacement(); await h.settle();
    const path = h.views.find(v => v.player === player).nativePath;
    const epoch = h.transport.slots[0].nativeViewEpoch;
    await h.rotate(); await h.frame(0); await h.positionAck(0);
    assert.notEqual(h.transport.phase, 'ready', 'a layout/public frame cannot satisfy native presentation');
    assert.equal(h.views.find(v => v.player === player).nativePath, path);
    player.finishWindow(); await h.settle(); await h.rotate();
    assert.notEqual(h.transport.phase, 'ready', 'presentation still requires its position ACK');
    await h.positionAck(0); assert.equal(h.transport.phase, 'ready');
    await h.rotate();
    assert.equal(h.views.find(v => v.player === player).nativePath, path);
    assert.equal(h.transport.slots[0].nativeViewEpoch, epoch);
    assert.equal(h.calls.filter(c => c[0] === 'replace').length, 1);
    assert.equal(h.calls.filter(c => c[0] === 'seek').length, 0);
    assert.equal(h.timerCount, 0);
  });
}

test('whole Android source fences zero-frame readiness and retains its final view and target', async t => {
  const h = harness({ holdReplacement: true, clips: [{ ...clip(), sourceStartMs: 0 }] });
  t.after(() => h.unmount()); await h.settle();
  const player = h.players[0]; player.holdWindow = true;
  player.finishReplacement(); await h.settle();
  const request = h.calls.find(c => c[0] === 'window');
  assert.ok(request, 'whole source must request native presentation after SDK initialization');
  assert.equal(request[4], null); assert.equal(request[6], 0);
  const epoch = h.transport.slots[0].nativeViewEpoch;
  const path = h.views.find(v => v.player === player).nativePath;
  await h.frame(0); await h.positionAck(0);
  assert.notEqual(h.transport.phase, 'ready');
  assert.equal(h.transport.slots[0].firstFrameReady, false);
  player.finishWindow(); await h.settle();
  assert.notEqual(h.transport.phase, 'ready', 'native presentation still needs clock observation');
  await h.positionAck(0);
  assert.equal(h.transport.phase, 'ready'); assert.equal(player.currentTime, 0);
  assert.equal(h.transport.currentMs, 0);
  assert.equal(h.transport.slots[0].nativeViewEpoch, epoch);
  assert.equal(h.views.find(v => v.player === player).nativePath, path);
  assert.equal(h.calls.filter(c => c[0] === 'seek').length, 0);
  assert.equal(h.calls.filter(c => c[0] === 'replace').length, 1);
  assert.equal(h.timerCount, 0);
});

test('paused main and PiP independently require native presentation and retain both views through rotation', async t => {
  const h = harness({ pip: true, clips: [{ ...clip(), sourceStartMs: 0 }] });
  t.after(() => h.unmount()); await h.complete();
  assert.equal(h.transport.phase, 'ready'); const pip = h.players[2];
  assert.equal(h.calls.filter(c => c[0] === 'window' && c[1] === 2).length, 0,
    'main readiness cannot certify the separate PiP source');
  pip.status = 'readyToPlay'; pip.emit('statusChange', { status: 'readyToPlay' }); await h.settle();
  const request = h.calls.find(c => c[0] === 'window' && c[1] === 2);
  assert.ok(request, 'PiP must use the same native presentation contract as the main preview');
  assert.equal(request[4], null); assert.equal(request[6], 0);
  assert.equal(h.transport.phase, 'ready'); assert.equal(pip.playing, false);
  const paths = h.views.map(v => v.nativePath);
  pip.finishWindow(); await h.settle(); await h.rotate();
  assert.deepEqual(h.views.map(v => v.nativePath), paths);
  assert.equal(h.calls.filter(c => c[0] === 'window' && c[1] === 2).length, 1);
  assert.equal(h.calls.some(c => c[0] === 'play'), false);
  assert.equal(h.timerCount, 0);
});

for (const sourceDurationMs of [31000, 60000]) {
  test(`superseding target while SDK replacement is pending waits for a loaded source: ${sourceDurationMs}`, async t => {
    const h = harness({ holdReplacement: true, sourceDurationMs });
    t.after(() => h.unmount()); await h.settle();
    const player = h.players[0], finishOld = player.finishReplacement;
    h.transport.seek(3000); await h.settle();
    assert.equal(h.calls.filter(call => call[0] === 'window').length, 0,
      'a desired URI is not proof that the SDK has installed it');
    assert.notEqual(h.transport.phase, 'error');
    assert.equal(player.finishReplacement, finishOld, 'replacement mutations serialize while the lease stays masked');
    finishOld(); await h.settle();
    const finishCurrent = player.finishReplacement;
    if (finishCurrent !== finishOld) {
      assert.equal(h.calls.filter(call => call[0] === 'window').length, 0,
        'a retired SDK completion cannot certify its replacement');
      finishCurrent();
    }
    await h.complete();
    assert.equal(h.transport.phase, 'ready');
    assert.equal(h.transport.currentMs, 3000);
    assert.equal(h.calls.some(call => call[0] === 'play'), false);
  });
}

test('cleanup disposes the latest actual native mask ID after repeated preparations', async t => {
  const h = harness({ clips: ['source', 'other', 'source', 'other'].map((source, i) => clip(`dispose-${i}`, source)) });
  t.after(() => h.unmount());
  await h.complete(); h.transport.play(); await h.complete();
  h.players[0].emit('playToEnd', {}); await h.complete();
  h.players[1].emit('playToEnd', {}); await h.complete();
  const latest = [0, 1].map(slot => h.calls.filter(call => call[0] === 'maskAcquire' && call[1] === slot).at(-1)[2]);
  assert.ok(latest.some(id => id > 1), 'exercise a renewed native lease, not just mount-time IDs');
  h.unmount(); await h.settle();
  assert.deepEqual(h.calls.filter(call => call[0] === 'maskDispose').map(call => call.slice(1)),
    [[0, latest[0]], [1, latest[1]]], 'cleanup must dispose the actual lease IDs without snapshotting initial numbers');
});

// Use the complete controller/overlay harness and its installed Expo Long/Float
// nativeClock boundary. Short sources use valid bounds and their own cut time.
for (const endpoint of [1002, 6385, 8000]) for (const full of [false, true]) for (const nativeFloat of [false, true]) test(
  `EOF seconds precision survives actual overlay: end=${endpoint}, full=${full}, Float=${nativeFloat}`, async t => {
  const length = Math.min(endpoint, 3000);
  const outgoing = { ...clip('precision-out'), sourceStartMs: endpoint - length, sourceEndMs: endpoint,
    availableSourceEndMs: endpoint, transitionAfter: { type: 'crossfade', durationMs: 650 } };
  const h = harness({ clips: [outgoing, { ...clip('precision-in', 'other'), sourceStartMs: 0, sourceEndMs: length }],
    sourceDurationMs: full ? endpoint : 10000, nativeClock: true,
    nativeDuration: nativeFloat ? Math.fround(Math.fround(endpoint) / 1000) : undefined });
  t.after(() => h.unmount()); await h.complete();
  assert.ok(outgoing.sourceStartMs >= 0);
  const timelineMs = length + 324; // one ms before this actual transition window ends
  h.transport.seek(timelineMs); await h.complete();
  const slot = h.transport.slots.findIndex(s => s.preparedClipId === outgoing.id);
  const player = h.players[slot];
  assert.equal(player.windowEndMs, full ? null : endpoint);
  const actualSeek = h.calls.filter(c => c[0] === 'seek' && c[1] === slot).at(-1)?.[2];
  assert.equal(typeof actualSeek, 'number', 'production synchronizer issued the source seek');
  t.diagnostic(JSON.stringify({ endpoint, full, nativeFloat, timelineMs, reportedDuration: player.duration, actualSeek, nativeLongMs: Math.trunc(actualSeek * 1000) }));
  assert.equal(Math.trunc(actualSeek * 1000), endpoint - 1, 'preserve the helper ULP through the real Expo seek boundary');
  assert.equal(player.currentTime, Math.fround(Math.fround(endpoint - 1) / 1000), 'actual nativeClock landed on the final readable ms');
  assert.equal(h.transport.currentMs, timelineMs, 'source bound must not change the logical timeline');
  assert.equal(player.playing, false);
});

for (const [logicalMs, nativeDuration, expectedMs] of [
  [7900, Math.fround(7.95), 7900], [7960, Math.fround(7.95), 7949], [7990, Math.fround(7.95), 7949],
  [8000, Math.fround(7.95), 7949], [7990, Math.fround(7.5), 7990], [8000, Math.fround(7.5), 7999],
]) test(`EOF native playable bound in actual overlay: logical=${logicalMs}, native=${nativeDuration}`, async t => {
  const outgoing = { ...clip('native-bound-out'), sourceStartMs: 5000, sourceEndMs: 8000,
    availableSourceEndMs: 8000, transitionAfter: { type: 'crossfade', durationMs: 650 } };
  const h = harness({ clips: [outgoing, { ...clip('native-bound-in', 'other'), sourceStartMs: 0, sourceEndMs: 3000 }],
    sourceDurationMs: 8000, nativeClock: true, nativeDuration });
  t.after(() => h.unmount()); await h.complete();
  const timelineMs = logicalMs === 8000 ? 3324 : 2675 + (logicalMs - 7675) * 2;
  h.transport.seek(timelineMs); await h.complete();
  const slot = h.transport.slots.findIndex(s => s.preparedClipId === outgoing.id);
  const actualSeek = h.calls.filter(c => c[0] === 'seek' && c[1] === slot).at(-1)?.[2];
  t.diagnostic(JSON.stringify({ logicalMs, nativeDuration, actualSeek, nativeLongMs: Math.trunc(actualSeek * 1000) }));
  assert.equal(Math.trunc(actualSeek * 1000), expectedMs, 'bound near-EOF seeks even before declared EOF; preserve interior targets and >250ms mismatch policy');
  assert.equal(h.transport.currentMs, timelineMs);
  assert.equal(h.players[slot].playing, false);
});
