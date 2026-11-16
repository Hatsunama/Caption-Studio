import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(resolve(root, 'package.json'));
const ts = require('typescript');
const compiled = new Map();
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const transform = { position: { x: .5, y: .5 }, scale: 1, rotation: 0, fit: 'fit' };
const flatten = style => Object.assign({}, ...(Array.isArray(style) ? style.flat(Infinity) : [style]).filter(Boolean));

// Executes the actual exported overlay and every component it returns. Native host
// identity follows keyed parent/type ancestry, including all wrapper components.
// Only React scheduling and native hosts are substituted; policy modules are real.
export function createHarness(type, reverse = false, platform = 'android') {
  const hosts = new Map(), natives = new Map(), cache = new Map();
  const context = vm.createContext({});
  const effects = [], calls = [];
  let owner, cursor = 0, dirty = false, sequence = 0, tree, mounted = true;
  const players = [0, 1].map(slot => ({ currentTime: 0, playbackRate: 1, muted: false, playing: false,
    play() { this.playing = true; calls.push(['play', slot, this.muted]); },
    pause() { this.playing = false; calls.push(['pause', slot]); } }));
  const react = {
    useRef(value) { return owner.cells[cursor++] ??= { current: value }; },
    useState(initial) { const host = owner, i = cursor++;
      if (!(i in host.cells)) host.cells[i] = typeof initial === 'function' ? initial() : initial;
      return [host.cells[i], next => { const value = typeof next === 'function' ? next(host.cells[i]) : next;
        if (!Object.is(host.cells[i], value)) { host.cells[i] = value; dirty = true; } }]; },
    useMemo(fn, deps) { const i = cursor++; if (!same(owner.cells[i]?.deps, deps)) owner.cells[i] = { deps, value: fn() }; return owner.cells[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const i = cursor++, cell = owner.cells[i] ??= {};
      if (!same(cell.deps, deps)) { cell.deps = deps; effects.push(() => { cell.cleanup?.(); cell.cleanup = fn(); }); } },
  };
  const jsx = (type, props, key) => ({ type, props, key });
  const mocks = { react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'react-native': {  Platform: { OS: platform, Version: 36 }, View: 'view', Text: 'text' }, 'expo-video': { VideoView: 'video' },
    expo: { requireNativeView(moduleName, viewName) {
      assert.equal(platform, 'android', 'transition pair native factory is Android only');
      assert.equal(moduleName, 'CaptionMedia');
      assert.equal(viewName, 'CaptionTransitionPair');
      return 'transition-pair';
    } } };
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    if (!compiled.has(file)) compiled.set(file, ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText);
    const exports = {}; cache.set(file, exports);
    const evaluate = vm.runInContext(`(function(exports, require) { ${compiled.get(file)}\n})`, context, { filename: file });
    evaluate(exports, id => {
      if (id in mocks) return mocks[id];
      if (id.startsWith('@/') || id.startsWith('.')) {
        const stem = id.startsWith('@/') ? resolve(root, 'src', id.slice(2)) : resolve(dirname(file), id);
        if (stem.endsWith('.json')) return JSON.parse(readFileSync(stem, 'utf8'));
        return load(stem + (stem.endsWith('video-transition-overlay') ? '.tsx' : '.ts'));
      }
      return require(id);
    });
    return exports;
  }
  const { VideoTransitionOverlay } = load(resolve(root, 'src/components/editor/video-transition-overlay.tsx'));
  const preview = load(resolve(root, 'src/lib/video-transition-preview.ts'));
  const clips = ['out', 'in'].map((id, index) => ({ id, sourceId: id, sourceStartMs: 1000, sourceEndMs: 5000,
    availableSourceStartMs: 0, availableSourceEndMs: 10000, gapBeforeMs: 0, gapAfterMs: 0,
    playbackRate: 1, muted: false, volume: 1, transform: { ...transform, rotation: index ? -8 : 12 },
    transitionAfter: { type: index ? 'none' : type, durationMs: index ? 0 : 1000 } }));
  const sources = clips.map(c => ({ id: c.id, uri: `file:///${c.id}.mp4`, durationMs: 10000 }));
  const entries = clips.map((clip, i) => ({ clip, gapStartMs: i * 4000, startMs: i * 4000, endMs: (i + 1) * 4000, afterGapEndMs: (i + 1) * 4000 }));
  const windows = preview.buildVideoTransitionPreviewWindows(entries, sources);
  const order = reverse ? ['in', 'out'] : ['out', 'in'];
  const props = { entries, sources, timelineMs: 3000, isPlaying: false, transportReady: true,
    width: 300, height: 200, backgroundColor: '#123456', admitted: true, visible: true, players,
    slots: order.map((preparedClipId, i) => ({ preparedClipId, prepareToken: 10 + i, nativeViewEpoch: 100 + i, firstFrameReady: true, readiness: 'ready' })),
    activeSlot: reverse ? 1 : 0, currentTransform: clips[0].transform, currentClipId: 'out',
    onFirstFrameRender(slot, token) { calls.push(['frame', slot, token]); },
    setCompositeClock(clock) { calls.push(['clock', clock]); },
    retireComposite(allowOrdinaryPlayback = true) {
      calls.push(['retire', allowOrdinaryPlayback]);
      props.setCompositeClock();
      // Stub only the controller boundary. Integrated controller tests verify
      // ordinary source position/rate restoration using the real callback.
      const active = props.slots[props.activeSlot];
      const ordinary = allowOrdinaryPlayback && props.admitted && props.visible && props.transportReady
        && props.isPlaying && active.readiness === 'ready' && active.firstFrameReady;
      players.forEach((player, slot) => {
        player.muted = true; player.volume = 0;
        if (slot !== props.activeSlot || !ordinary) player.pause();
        else if (!player.playing) player.play();
      });
    } };
  function walk(node, path, seen, nativeSeen) {
    if (Array.isArray(node)) return node.map((child, i) => walk(child, `${path}/${child?.key ?? i}`, seen, nativeSeen));
    if (!node || typeof node !== 'object') return node;
    const identity = `${path}:${typeof node.type === 'function' ? node.type.name : node.type}`;
    if (typeof node.type === 'function') {
      seen.add(identity); owner = hosts.get(identity) ?? { cells: [] }; hosts.set(identity, owner); cursor = 0;
      return walk(node.type(node.props), `${identity}/result`, seen, nativeSeen);
    }
    nativeSeen.add(identity);
    if (!natives.has(identity)) natives.set(identity, ++sequence);
    return { type: node.type, id: natives.get(identity), props: node.props, style: flatten(node.props?.style),
      children: walk(node.props?.children, `${identity}/children`, seen, nativeSeen) };
  }
  function render(patch = {}) {
    Object.assign(props, patch);
    let tries = 0;
    do {
      assert.ok(++tries < 25, 'render settles'); dirty = false;
      const seen = new Set(), nativeSeen = new Set();
      tree = mounted ? walk(jsx(VideoTransitionOverlay, props), 'root', seen, nativeSeen) : null;
      for (const [key, host] of hosts) if (!seen.has(key)) { host.cells.forEach(cell => cell?.cleanup?.()); hosts.delete(key); }
      for (const key of natives.keys()) if (!nativeSeen.has(key)) natives.delete(key);
      while (effects.length) effects.shift()();
    } while (dirty);
    return videos();
  }
  function nodes(type, node = tree, ancestors = [], result = []) {
    if (Array.isArray(node)) { node.forEach(child => nodes(type, child, ancestors, result)); return result; }
    if (!node || typeof node !== 'object') return result;
    if (node.type === type) result.push({ ...node, ancestors });
    if (node.children != null) nodes(type, node.children, [...ancestors, node], result); return result;
  }
  const videos = () => nodes('video');
  return { props, players, calls, windows, render, nodes, videos, load, preview,
    frame() { videos().forEach(v => v.props.onFirstFrameRender()); render(); },
    phase(phase) { render({ timelineMs: 3500 + phase * 1000 }); },
    unmount() { mounted = false; render(); },
  };
}
