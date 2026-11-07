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
function harness(type, reverse = false) {
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
    'react-native': { View: 'view', Text: 'text' }, 'expo-video': { VideoView: 'video' },
    'expo-image': { Image: 'image' } };
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
    slots: order.map((preparedClipId, i) => ({ preparedClipId, prepareToken: 10 + i, firstFrameReady: true, readiness: 'ready' })),
    activeSlot: reverse ? 1 : 0, currentTransform: clips[0].transform, currentClipId: 'out',
    onFirstFrameRender(slot, token) { calls.push(['frame', slot, token]); },
    setCompositeClock(clock) { calls.push(['clock', clock]); } };
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

const recipes = ['crossfade', 'push-left', 'push-right', 'push-up', 'push-down', 'split-horizontal', 'split-vertical',
  'iris-circle', 'iris-diamond', 'fold-horizontal', 'fold-vertical', 'zoom-in', 'zoom-out', 'spin',
  'fade-dark', 'dip-black', 'dip-white', 'flash', 'shutter', 'color-wash-cyan', 'color-wash-magenta'];

for (const recipe of recipes) for (const reverse of [false, true]) {
  test(`${recipe}, reversed slots=${reverse}: actual rendered ownership and retained host identity`, t => {
    const h = harness(recipe, reverse); t.after(() => h.unmount());
    const initial = h.render().map(v => v.id);
    assert.equal(initial.length, 2);
    for (const phase of [0, .5, 1, .5, 0]) {
      h.phase(phase);
      for (const player of h.players) assert.equal(h.videos().filter(v => v.props.player === player).length, 1,
        `${recipe} phase ${phase}: exactly one mounted VideoView per player, including hidden views`);
      assert.deepEqual(h.videos().map(v => v.id), initial, 'native identity retained entering, scrubbing, exiting');
      h.frame();
      assert.deepEqual(h.videos().map(v => v.id), initial, 'first-frame callback must not replace hosts');
      assert.ok(h.videos().every(v => v.ancestors.every(a => a.props.collapsable === false)),
        'native wrapper ancestry must also survive React Native flattening');
      // Both directions across the boundary switch the active transport slot.
      for (const activeSlot of [0, 1]) {
        h.render({ activeSlot });
        assert.deepEqual(h.videos().map(v => v.id), initial, 'active-slot controls cannot replace surfaces');
      }
    }
    h.render({ timelineMs: 5000 });
    assert.deepEqual(h.videos().map(v => v.id), initial);
    h.render({ visible: false }); assert.deepEqual(h.videos().map(v => v.id), initial);
    h.render({ admitted: false }); assert.equal(h.videos().length, 0);
    h.render({ admitted: true }); assert.equal(h.videos().length, 2);
    assert.ok(h.videos().every(v => !initial.includes(v.id)), 'background admission creates fresh surfaces');
    h.unmount(); assert.equal(h.videos().length, 0);
  });
}

test('waiting and failed composites retain ordinary pair and show an error notice', t => {
  const h = harness('crossfade'); t.after(() => h.unmount());
  const initial = h.render().map(v => v.id);
  h.props.slots[1] = { ...h.props.slots[1], readiness: 'preparing', firstFrameReady: false };
  h.phase(.5); assert.deepEqual(h.videos().map(v => v.id), initial);
  assert.ok(h.nodes('text').some(v => v.children === 'Waiting for video frames.'));
  h.props.slots[1] = { ...h.props.slots[1], readiness: 'error' };
  h.render(); assert.deepEqual(h.videos().map(v => v.id), initial);
  h.render({ transportReady: false }); assert.deepEqual(h.videos().map(v => v.id), initial);
});

test('paused first-frame readiness belongs to retained surfaces; no new frame event is required on entry', t => {
  const h = harness('iris-circle'); t.after(() => h.unmount());
  h.props.slots = h.props.slots.map(slot => ({ ...slot, firstFrameReady: false, readiness: 'preparing' }));
  const initial = h.render().map(v => v.id); h.phase(0);
  const concealed = () => h.videos().every(v => v.ancestors.some(a => a.style.opacity === 0));
  assert.equal(concealed(), true);
  assert.ok(h.nodes('view').some(v => v.style.backgroundColor === '#123456'));
  h.frame();
  assert.deepEqual(h.calls.filter(c => c[0] === 'frame').map(c => c.slice(1)), [[0, 10], [1, 11]]);
  h.props.slots = h.props.slots.map(slot => ({ ...slot, firstFrameReady: true, readiness: 'ready' }));
  h.render(); h.phase(.5);
  assert.equal(concealed(), false, 'already rendered paused surfaces reveal without another native callback');
  assert.deepEqual(h.videos().map(v => v.id), initial);
  assert.ok(h.players.every(p => !p.playing));
  assert.equal(h.nodes('text').length, 0);
});

for (const reverse of [false, true]) test(`recipe ordering, phase-zero and exit geometry, reversed slots=${reverse}`, t => {
  for (const recipe of recipes) {
    const h = harness(recipe, reverse); t.after(() => h.unmount());
    const initial = h.render().map(v => v.id); h.phase(0);
    const incoming = h.videos().find(v => v.props.player === h.players[reverse ? 0 : 1]);
    const outgoing = h.videos().find(v => v.props.player === h.players[reverse ? 1 : 0]);
    const styles = v => v.ancestors.map(a => a.style);
    const composite = !['fade-dark', 'dip-black', 'dip-white', 'flash', 'shutter', 'color-wash-cyan', 'color-wash-magenta'].includes(recipe);
    if (composite) {
      assert.ok(styles(incoming).some(s => s.zIndex === 1));
      assert.ok(styles(outgoing).some(s => s.zIndex === 0));
      assert.equal(styles(incoming).some(s => s.backgroundColor != null), true, 'stage retains project background');
      assert.equal(styles(incoming).filter(s => s.backgroundColor != null).length, 1, 'individual composite layers remain transparent');
      if (recipe.startsWith('push-')) {
        const axis = ['push-left', 'push-right'].includes(recipe) ? 'translateX' : 'translateY';
        const offset = { 'push-left': 300, 'push-right': -300, 'push-up': 200, 'push-down': -200 }[recipe];
        assert.ok(styles(incoming).some(s => JSON.stringify(s.transform) === JSON.stringify([{ [axis]: offset }])));
      } else if (recipe.startsWith('split-')) {
        assert.ok(styles(incoming).some(s => s.overflow === 'hidden' && (recipe === 'split-horizontal' ? s.height === 0 : s.width === 0)));
      } else assert.ok(styles(incoming).some(s => s.opacity === 0), `${recipe} reveals no incoming image at phase zero`);
      h.phase(.5);
      for (const activeSlot of [0, 1]) {
        h.render({ activeSlot });
        const layers = h.videos();
        assert.ok(layers.find(v => v.props.player === h.players[reverse ? 0 : 1]).ancestors.some(a => a.style.zIndex === 1));
      }
    }
    h.phase(1);
    assert.deepEqual(h.videos().map(v => v.id), initial);
    for (const v of h.videos()) {
      assert.ok(v.ancestors.some(a => a.style.zIndex === (v.props.player === h.players[h.props.activeSlot] ? 1 : 0)));
      assert.equal(v.ancestors.some(a => a.style.width === 0 || a.style.height === 0), false, 'exit clears clipped geometry');
      assert.equal(v.ancestors.some(a => a.style.opacity === 0), false, 'exit clears transition opacity');
      assert.ok(v.ancestors.some(a => JSON.stringify(a.style.transform) === JSON.stringify([
        { translateX: 0 }, { translateY: 0 }, { rotate: '12deg' }, { scaleX: 1 }, { scaleY: 1 },
      ])), 'ordinary transform restored at endpoint');
    }
    h.unmount();
  }
});

test('native synchronization failure keeps owners and reports unavailable', t => {
  const h = harness('crossfade'); t.after(() => h.unmount());
  const initial = h.render().map(v => v.id);
  Object.defineProperty(h.players[1], 'currentTime', { get: () => 0, set() { throw new Error('native seek failure'); } });
  h.phase(.5);
  assert.deepEqual(h.videos().map(v => v.id), initial);
  assert.ok(h.nodes('text').some(v => v.children === 'A transition frame could not be rendered.'));
  assert.equal(h.calls.filter(c => c[0] === 'clock').at(-1)[1], undefined);
});

test('edited clip transform, fit and resize update the retained surface inside its recipe', t => {
  const h = harness('split-vertical'); t.after(() => h.unmount());
  const initial = h.render().map(v => v.id); h.phase(.5);
  const currentTransform = { position: { x: .25, y: .75 }, scale: 1.5, scaleX: 2, scaleY: .5, rotation: 37, fit: 'fill' };
  for (const currentClipId of ['out', 'in']) {
    h.render({ currentClipId, currentTransform });
    const view = h.videos().find(v => v.props.player === h.players[currentClipId === 'out' ? 0 : 1]);
    assert.equal(view.props.contentFit, 'cover');
    assert.ok(view.ancestors.some(a => JSON.stringify(a.style.transform) === JSON.stringify([
      { translateX: -75 }, { translateY: 50 }, { rotate: '37deg' }, { scaleX: 3 }, { scaleY: .75 },
    ])));
    assert.deepEqual(h.videos().map(v => v.id), initial);
  }
  h.render({ width: 600, height: 400 });
  const incoming = h.videos().find(v => v.props.player === h.players[1]);
  assert.ok(incoming.ancestors.some(a => a.style.left === 150 && a.style.width === 300 && a.style.height === 400));
  assert.deepEqual(h.videos().map(v => v.id), initial);
});

for (const reverse of [false, true]) test(`clock, muting and cleanup use retained players, reversed slots=${reverse}`, t => {
  const h = harness('crossfade', reverse); t.after(() => h.unmount()); h.render();
  h.render({ isPlaying: true }); h.phase(.5); h.frame();
  assert.equal(h.players[reverse ? 1 : 0].currentTime, 5);
  assert.equal(h.players[reverse ? 0 : 1].currentTime, 1);
  assert.ok(h.players.every(p => p.playing));
  assert.equal(h.players[reverse ? 0 : 1].muted, true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.filter(c => c[0] === 'clock').at(-1)[1])), {
    key: h.windows[0].key, slot: reverse ? 1 : 0, prepareToken: reverse ? 11 : 10,
  });
  h.render({ timelineMs: 5000 });
  assert.equal(h.players[reverse ? 0 : 1].playing, false);
  assert.equal(h.players[reverse ? 0 : 1].muted, true);
  assert.equal(h.calls.filter(c => c[0] === 'clock').at(-1)[1], undefined);
});

// Independent recipe expectations use fixed 300x200 geometry. Do not derive these
// values from production helpers or compare generated source strings.
for (const reverse of [false, true]) test(`recipe geometry at midpoint, reversed slots=${reverse}`, t => {
  for (const recipe of recipes) {
    const h = harness(recipe, reverse); t.after(() => h.unmount()); h.render(); h.phase(.5); h.frame();
    const outgoing = h.videos().filter(v => v.props.player === h.players[reverse ? 1 : 0]).at(-1);
    const incoming = h.videos().filter(v => v.props.player === h.players[reverse ? 0 : 1]).at(-1);
    const styles = view => view.ancestors.map(a => a.style);
    const has = (view, expected) => assert.ok(styles(view).some(style => Object.entries(expected).every(([k, v]) =>
      JSON.stringify(style[k]) === JSON.stringify(v))), `${recipe}: expected ancestor style ${JSON.stringify(expected)}`);
    assert.equal(outgoing.props.contentFit, 'contain'); assert.equal(incoming.props.surfaceType, 'textureView');
    assert.equal(incoming.props.nativeControls, false); assert.equal(incoming.props.useExoShutter, false);
    has(outgoing, { transform: [{ translateX: 0 }, { translateY: 0 }, { rotate: '12deg' }, { scaleX: 1 }, { scaleY: 1 }] });
    const composite = !['fade-dark', 'dip-black', 'dip-white', 'flash', 'shutter', 'color-wash-cyan', 'color-wash-magenta'].includes(recipe);
    if (composite) has(incoming, { transform: [{ translateX: 0 }, { translateY: 0 }, { rotate: '-8deg' }, { scaleX: 1 }, { scaleY: 1 }] });
    if (recipe.startsWith('push-')) {
      const axis = ['push-left', 'push-right'].includes(recipe) ? 'translateX' : 'translateY';
      const amount = { 'push-left': -150, 'push-right': 150, 'push-up': -100, 'push-down': 100 }[recipe];
      has(outgoing, { transform: [{ [axis]: amount }] }); has(incoming, { transform: [{ [axis]: -amount }] });
    }
    if (recipe === 'split-horizontal') {
      has(incoming, { left: 0, top: 50, width: 300, height: 100, overflow: 'hidden' });
      has(incoming, { left: 0, top: -50, width: 300, height: 200 });
    }
    if (recipe === 'split-vertical') {
      has(incoming, { left: 75, top: 0, width: 150, height: 200, overflow: 'hidden' });
      has(incoming, { left: -75, top: 0, width: 300, height: 200 });
    }
    if (recipe.startsWith('iris-')) {
      const size = recipe === 'iris-circle' ? Math.sqrt(130000) / 2 : 250 / Math.SQRT2;
      has(incoming, { left: (300 - size) / 2, top: (200 - size) / 2, width: size, height: size,
        overflow: 'hidden', borderRadius: recipe === 'iris-circle' ? size / 2 : 0,
        transform: [{ rotate: recipe === 'iris-circle' ? '0deg' : '45deg' }] });
      has(incoming, { left: (size - 300) / 2, top: (size - 200) / 2, width: 300, height: 200,
        transform: [{ rotate: recipe === 'iris-circle' ? '0deg' : '-45deg' }] });
    }
    if (recipe.startsWith('fold-')) has(incoming, { opacity: .5, transform: [{ [recipe === 'fold-horizontal' ? 'scaleY' : 'scaleX']: .5 }] });
    if (['zoom-in', 'zoom-out', 'spin'].includes(recipe)) has(incoming, { opacity: .5,
      transform: [{ scale: recipe === 'zoom-out' ? 1.4 : .675 }, { rotate: recipe === 'spin' ? '140deg' : '0deg' }] });
    if (recipe === 'crossfade') has(incoming, { opacity: .5 });
    const viewHas = expected => assert.ok(h.nodes('view').some(v => Object.entries(expected).every(([k, value]) =>
      Object.is(v.style[k], value))), `${recipe}: expected cover ${JSON.stringify(expected)}`);
    if (recipe === 'fade-dark' || recipe === 'dip-black') viewHas({ backgroundColor: '#000000', opacity: 1 });
    if (recipe === 'dip-white' || recipe === 'flash') viewHas({ backgroundColor: '#FFFFFF', opacity: 1 });
    if (recipe === 'shutter') { viewHas({ top: 0, height: 100, backgroundColor: '#000000' }); viewHas({ bottom: 0, height: 100, backgroundColor: '#000000' }); }
    if (recipe.startsWith('color-wash-')) {
      const cyan = recipe.endsWith('cyan'); viewHas({ backgroundColor: cyan ? '#00D9FF' : '#FF168F', opacity: 1 });
      viewHas({ width: 300, backgroundColor: cyan ? '#651FFF' : '#FFEA00', opacity: 92 / 255 });
    }
    h.unmount();
  }
});
