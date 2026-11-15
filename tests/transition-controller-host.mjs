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
export function harness({ clips = [clip()], missingSource = false, holdReplacement = false, frameOnPublish = false, platform = 'android', nativeDuration, nativeClock = false, sourceDurationMs = 31000, allowGapClock = false, pip = false } = {}) {
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
        foreground: view.ancestors.some(style => (style.elevation ?? style.zIndex) === 1)
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
    'react-native': {  View: 'view', Text: 'text', AppState: appState, Platform: { OS: platform, Version: 36 } },
    'expo-video': { VideoView: 'video', useVideoPlayer(source, setup) {
      const player = players[playerCursor++]; const ref = react.useRef(false);
      if (!ref.current) { if (source) { player.loadedUri = source; player.status = 'loading'; }
        setup(player); ref.current = true; } return player; } },
    expo: { useEventListener(player, event, callback) {
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
  function renderNode(node, path, seen, ancestors = []) {
    if (Array.isArray(node)) return node.forEach((child, i) => renderNode(child, `${path}/${child?.key ?? i}`, seen, ancestors));
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'function') {
      seen.add(path); host = hosts.get(path) ?? { cells: [] }; hosts.set(path, host); cursor = 0;
      const child = node.type(node.props); renderNode(child, `${path}/result`, seen, ancestors);
    } else {
      if (node.type === 'video') views.push({ ...node.props, ancestors, nativePath: path });
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
