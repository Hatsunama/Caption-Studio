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
function createHarness(type, reverse = false, platform = 'android') {
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
    'react-native': { Platform: { OS: platform, Version: 36 }, View: 'view', Text: 'text' }, 'expo-video': { VideoView: 'video' } };
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
    retireComposite() {
      props.setCompositeClock();
      players.forEach((player, slot) => {
        if (slot !== props.activeSlot) { player.muted = true; player.pause(); }
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
  return { props, players, calls, windows, render, nodes, videos,
    frame() { videos().forEach(v => v.props.onFirstFrameRender()); render(); },
    phase(phase) { render({ timelineMs: 3500 + phase * 1000 }); },
    unmount() { mounted = false; render(); },
  };
}

const compositeRecipes = ['crossfade', 'push-left', 'push-right', 'push-up', 'push-down',
  'split-horizontal', 'split-vertical', 'iris-circle', 'iris-diamond',
  'fold-horizontal', 'fold-vertical', 'zoom-in', 'zoom-out', 'spin'];

for (const platform of ['android', 'ios', 'web']) for (const recipe of compositeRecipes) {
  test(`composite alpha owner: ${platform}, ${recipe}`, () => {
    for (const reverse of [false, true]) {
      const h = createHarness(recipe, reverse, platform);
      try {
        h.render();
        const identities = () => h.videos().map(v => [...v.ancestors, v].map(node => node.id));
        const ids = identities();
        const check = () => {
          assert.deepEqual(identities(), ids, 'video and every wrapper survive entry, phase changes and exit');
          const owners = h.videos().map(v => v.ancestors[2]);
          for (const owner of owners) {
            const fractional = owner.style.opacity > 0 && owner.style.opacity < 1;
            assert.equal(owner.props.needsOffscreenAlphaCompositing === true,
              platform === 'android' && fractional,
              'only the Android fractional-opacity layer opts into group alpha');
          }
          for (const node of [...h.nodes('view'), ...h.videos()]) {
            const owner = owners.find(owner => owner.id === node.id);
            const cache = platform === 'android' && Boolean(owner)
              && owner.style.opacity > 0 && owner.style.opacity < 1;
            assert.equal(node.props.renderToHardwareTextureAndroid === true, cache,
              'only the fractional Android opacity owner may cache its group');
            if (!owners.some(owner => owner.id === node.id)) {
              assert.notEqual(node.props.needsOffscreenAlphaCompositing, true, 'group alpha belongs only to the opacity owner');
            }
          }
        };
        check(); // Ordinary playback, including the hidden Android standby.
        for (const phase of [0, .025, .25, .5, .75, .975, 1]) {
          h.phase(phase);
          check(); // Includes zero alpha and the opaque outgoing layer.
        }
        h.phase(.5); check(); // Re-enter after the end boundary.
        h.render({ timelineMs: 3000 }); check();
      } finally {
        h.unmount();
      }
    }
    // Mocked host props prove the opt-in contract, not Android GPU pixel output.
  });
}

for (const reverse of [false, true]) for (const activeSlot of [0, 1]) {
  test(`crossfade host ancestor presentation: reverse=${reverse}, active=${activeSlot}`, t => {
    const h = createHarness('crossfade', reverse); t.after(() => h.unmount());
    h.render({ activeSlot });
    const ids = h.videos().map(v => v.id);
    const trace = [];
    const presentation = video => {
      const path = [...video.ancestors, video];
      return { alpha: path.reduce((alpha, node) => alpha * (node.style.opacity ?? 1), 1),
        backgrounds: path.filter(node => node.style.backgroundColor != null) };
    };
    for (const phase of [0, .025, .25, .5, .75, .975]) {
      h.render({ timelineMs: 3500 + phase * 1000, setCompositeClock: () => {} });
      const outgoing = h.videos().find(v => v.props.player === h.players[reverse ? 1 : 0]);
      const incoming = h.videos().find(v => v.props.player === h.players[reverse ? 0 : 1]);
      const a = presentation(outgoing), b = presentation(incoming);
      assert.equal(a.alpha, 1, 'outgoing host has no effective JS ancestor concealment');
      assert.equal(b.alpha, phase, 'incoming host effective alpha equals recipe phase');
      assert.equal(a.backgrounds.length, 2, 'common stage plus opaque outgoing input matte');
      assert.equal(b.backgrounds.length, 2, 'common stage plus opaque incoming input matte');
      assert.equal(a.backgrounds[0].id, b.backgrounds[0].id, 'background belongs to common stage behind both layers');
      assert.equal(a.backgrounds[0].style.backgroundColor, '#123456');
      assert.notEqual(a.backgrounds[1].id, b.backgrounds[1].id, 'each input owns its full frame matte');
      for (const video of [outgoing, incoming]) {
        assert.equal(video.ancestors[2].style.backgroundColor, undefined, 'elevated wrapper stays background free');
        assert.equal(video.ancestors[4].style.backgroundColor, '#123456', 'matte is inside clipping and outside user transform');
      }
      assert.ok(h.videos().every(v => v.props.surfaceType === 'textureView' && v.props.useExoShutter === false));
      assert.deepEqual(h.videos().map(v => v.id), ids);
      trace.push({ phase, outgoingAlpha: a.alpha, incomingAlpha: b.alpha,
        backgroundOwner: a.backgrounds[0].id, outgoingHost: outgoing.id, incomingHost: incoming.id });
    }
    h.render({ timelineMs: 4500 });
    assert.deepEqual(h.videos().map(v => v.id), ids);
    for (const video of h.videos()) assert.equal(presentation(video).alpha,
      video.props.player === h.players[activeSlot] ? 1 : 0, 'exit restores ordinary Android ownership');
    // Host styles cannot inspect native VideoView/TextureView alpha or determine
    // whether decoded/letterboxed pixels are black. This trace is JS evidence only.
    t.diagnostic(JSON.stringify(trace));
  });
}

for (const recipe of compositeRecipes) for (const reverse of [false, true]) for (const activeSlot of [0, 1]) {
  test(`parent callback churn preserves ${recipe}: reverse=${reverse}, active=${activeSlot}`, t => {
    const h = createHarness(recipe, reverse); t.after(() => h.unmount());
    const callbacks = [];
    const clock = () => {
      const calls = []; callbacks.push(calls);
      // Match the controller's inline callback: fresh identity every parent render.
      return value => calls.push(value);
    };
    h.render({ timelineMs: 3750, isPlaying: true, activeSlot, setCompositeClock: clock() });
    const ids = h.videos().map(v => v.id);
    const seeks = [];
    for (const [slot, player] of h.players.entries()) {
      let time = player.currentTime;
      Object.defineProperty(player, 'currentTime', { get: () => time,
        set(value) { seeks.push([slot, value]); time = value; } });
    }
    h.calls.length = 0;
    // Native playback advances by 50ms between controller timeUpdate renders.
    for (const timelineMs of [3800, 3850, 3900, 3950, 4000, 4050]) {
      h.players.forEach(player => { player.currentTime += .05; }); seeks.length = 0;
      h.render({ timelineMs, setCompositeClock: clock() });
      assert.deepEqual(h.videos().map(v => v.id), ids);
      assert.deepEqual(seeks, [], 'a running in-sync pair must not seek on parent rerender');
      assert.deepEqual(h.calls.filter(c => c[0] === 'pause'), [], 'callback identity is not composite exit');
      assert.ok(h.players.every(p => p.playing));
      const incoming = h.videos().find(v => v.props.player === h.players[reverse ? 0 : 1]);
      if (recipe === 'crossfade') assert.equal(incoming.ancestors.find(a => (a.style.elevation ?? a.style.zIndex) === 1).style.opacity, (timelineMs - 3500) / 1000);
      assert.ok(h.videos().every(v => v.ancestors.every(a => a.style.opacity !== 0)), 'both retained layers remain presented');
    }
    assert.ok(callbacks.slice(0, -1).every(calls => !calls.includes(undefined)), 'no false clock teardown');
    h.unmount();
    assert.equal(callbacks.at(-1).at(-1), undefined, 'real exit clears the latest parent clock');
    assert.equal(h.players[activeSlot === 0 ? 1 : 0].playing, false);
    assert.equal(h.players[activeSlot === 0 ? 1 : 0].muted, true);
  });
}

test('real pause, drift correction, active-slot changes and keyed rebind still retire the right player', t => {
  const h = createHarness('crossfade'); t.after(() => h.unmount());
  const clocks = [];
  const callback = () => value => clocks.push(value);
  h.render({ timelineMs: 3750, isPlaying: true, setCompositeClock: callback() });
  h.players[1].currentTime = 0;
  h.render({ timelineMs: 3800, setCompositeClock: callback() });
  assert.equal(h.players[1].currentTime, .8, 'large drift still seeks');
  h.render({ isPlaying: false, setCompositeClock: callback() });
  assert.ok(h.players.every(p => !p.playing), 'real pause stops both sources');
  h.render({ isPlaying: true, activeSlot: 1, setCompositeClock: callback() });
  assert.ok(h.players.every(p => p.playing));
  const ids = h.videos().map(v => v.id);
  const clears = clocks.filter(v => v === undefined).length;
  h.props.slots = h.props.slots.map(s => ({ ...s, prepareToken: s.prepareToken + 1 }));
  h.render({ setCompositeClock: callback() });
  assert.equal(clocks.filter(v => v === undefined).length, clears + 1, 'new preparation retires the old keyed composite');
  assert.deepEqual(h.videos().map(v => v.id), ids, 'preparation token does not remount native owners');
  assert.equal(clocks.at(-1).prepareToken, h.props.slots[1].prepareToken);
  h.render({ timelineMs: 5000, setCompositeClock: callback() });
  assert.equal(h.players[0].playing, false, 'latest non-active player pauses at exit');
  assert.equal(h.players[1].playing, true, 'active transport survives exit');
  assert.equal(clocks.at(-1), undefined);
});

test('failed or cancelled readiness still conceals the pair and retires its clock', t => {
  const h = createHarness('crossfade'); t.after(() => h.unmount());
  const clocks = [];
  h.render({ timelineMs: 3800, isPlaying: true, setCompositeClock: value => clocks.push(value) });
  const ids = h.videos().map(v => v.id);
  for (const readiness of ['cancelled', 'error']) {
    h.props.slots[1] = { ...h.props.slots[1], readiness, firstFrameReady: false };
    h.render({ setCompositeClock: value => clocks.push(value) });
    assert.deepEqual(h.videos().map(v => v.id), ids);
    assert.ok(h.videos().every(v => v.ancestors.some(a => a.style.opacity === 0)));
    assert.equal(h.players[1].playing, false);
    assert.equal(clocks.at(-1), undefined);
  }
});

// Exercise the actual exported component with independent recipe expectations.
// Mocked native hosts cannot prove Android pixels, moving frames or GPU memory.
const alphaRecipes = ['crossfade', 'fold-horizontal', 'fold-vertical', 'zoom-in', 'zoom-out', 'spin'];
const coverRecipes = ['fade-dark', 'dip-black', 'dip-white', 'flash', 'shutter', 'color-wash-cyan', 'color-wash-magenta'];
for (const platform of ['android', 'ios', 'web']) for (const reverse of [false, true]) {
  for (const recipe of [...compositeRecipes, ...coverRecipes]) {
    test('bounded hardware group lifecycle: ' + [platform, reverse, recipe].join('/'), () => {
      const h = createHarness(recipe, reverse, platform);
      try {
        h.render();
        const identities = () => h.videos().map(v => [...v.ancestors, v].map(node => node.id));
        const initial = identities(), incomingSlot = reverse ? 0 : 1;
        const count = phase => Number(platform === 'android' && alphaRecipes.includes(recipe) && phase > 0 && phase < 1);
        const check = (expectedCount, expectedAlpha) => {
          const videos = h.videos();
          assert.equal(videos.length, 2, 'exactly two retained native hosts');
          assert.deepEqual(identities(), initial, 'every native ancestor retains identity');
          const incoming = videos.find(v => v.props.player === h.players[incomingSlot]);
          const owner = incoming.ancestors[2];
          if (expectedAlpha != null) assert.equal(owner.style.opacity, expectedAlpha, 'independent recipe alpha');
          const nodes = [...h.nodes('view'), ...videos, ...h.nodes('text')];
          const cached = nodes.filter(node => node.props.renderToHardwareTextureAndroid === true);
          assert.equal(cached.length, expectedCount, 'bounded transient group cache count');
          for (const node of nodes) {
            const layer = videos.some(v => v.ancestors[2].id === node.id);
            const allowed = expectedCount === 1 && node.id === owner.id;
            if (layer) {
              assert.equal(node.props.renderToHardwareTextureAndroid === true, allowed,
                'explicitly disable caching outside incoming fractional opacity');
              assert.equal(node.props.needsOffscreenAlphaCompositing, allowed,
                'both grouping properties share the existing opacity boundary');
              assert.equal(node.props.collapsable, false, 'concrete native group');
            } else {
              assert.notEqual(node.props.renderToHardwareTextureAndroid, true, 'no other node cached');
              assert.notEqual(node.props.needsOffscreenAlphaCompositing, true, 'no other alpha group');
            }
          }
          if (expectedCount) {
            assert.equal(cached[0].id, owner.id, 'cache shares the alpha owner');
            assert.equal(owner.style.backgroundColor, undefined, 'elevated boundary has no drawable');
            assert.equal(incoming.ancestors[4].style.backgroundColor, '#123456', 'matte remains inside group');
          }
          for (const player of h.players) {
            const hosts = videos.filter(video => video.props.player === player);
            assert.equal(hosts.length, 1, 'one native host per original player');
            assert.equal(hosts[0].props.surfaceType, 'textureView');
            assert.equal(hosts[0].props.useExoShutter, false);
          }
        };
        // First Android alpha check must fail on the missing group, before any
        // assertion about explicitly false endpoint props on unmodified code.
        h.phase(.25); check(count(.25));
        h.render({ timelineMs: 3000 }); check(0);
        for (const isPlaying of [false, true]) {
          h.render({ isPlaying });
          for (const phase of [0, .025, .25, .5, .75, .975, 1]) {
            h.phase(phase);
            check(count(phase), alphaRecipes.includes(recipe) && phase < 1 ? phase : undefined);
          }
          h.phase(.5); check(count(.5));
          h.render({ activeSlot: incomingSlot, width: 200, height: 300 }); check(count(.5));
          h.render({ visible: false }); check(0);
          h.render({ visible: true }); check(count(.5));
          h.render({ transportReady: false }); check(0);
          h.render({ transportReady: true }); check(count(.5));
          const readySlots = h.props.slots;
          for (const readiness of ['cancelled', 'error']) {
            h.render({ slots: readySlots.map((slot, index) => index === incomingSlot
              ? { ...slot, readiness, firstFrameReady: false } : slot) });
            check(0);
            h.render({ slots: readySlots }); check(count(.5));
          }
          h.render({ timelineMs: 5000 }); check(0);
          h.phase(.5); check(count(.5));
        }
        h.render({ admitted: false });
        assert.equal(h.videos().length, 0, 'leaving admission removes both native hosts');
        assert.equal(h.nodes('view').filter(node => node.props.renderToHardwareTextureAndroid === true).length, 0);
        h.unmount();
        assert.equal(h.nodes('view').length, 0, 'unmount retains no cached group');
      } finally {
        h.unmount();
      }
    });
  }
}
