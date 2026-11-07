import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = { durationMs: 8000, width: 360, height: 640, frameRate: 24 };
const target = 6385.416507720947;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function loadHelper() {
  const logs = [], exports = {};
  const code = ts.transpileModule(readFileSync(resolve(root, 'src/components/editor/private-paused-thumbnail-diagnostic.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, console: { info: (...args) => logs.push(args) } });
  return { ...exports, logs };
}
function thumbnail() {
  return { requestedTime: target / 1000, actualTime: 6.375, width: 360, height: 640, releases: 0,
    release() { assert.equal(++this.releases, 1, 'release exactly once'); } };
}
function player() {
  const pending = [], calls = [];
  return { pending, calls, currentTime: target / 1000, duration: 8,
    videoTrack: { size: { width: 360, height: 640 }, frameRate: 24 },
    generateThumbnailsAsync(time) { calls.push(time); return new Promise((resolve, reject) => pending.push({ resolve, reject })); } };
}

test('private predicate admits only numeric paused fixture and bounded target', () => {
  const { isPausedThumbnailFixture: accepts } = loadHelper();
  for (const time of [6380, target, 6390]) assert.equal(accepts(fixture, time, true), true);
  for (const time of [6379.99, 6390.01, NaN, Infinity]) assert.equal(accepts(fixture, time, true), false);
  assert.equal(accepts(fixture, target, false), false);
  for (const key of Object.keys(fixture)) {
    assert.equal(accepts({ ...fixture, [key]: fixture[key] + 1 }, target, true), false);
    assert.equal(accepts({ ...fixture, [key]: undefined }, target, true), false);
  }
});

test('late cancellation, fresh view, and token invalidation release results without publishing', async () => {
  const { createPausedThumbnailDiagnostic } = loadHelper();
  const session = createPausedThumbnailDiagnostic(), p = player(), published = [];
  const cancel = session.request(p, fixture, target, 5000, 10, true, () => true, image => published.push(image));
  cancel(); session.retire(); session.collect([]);
  const old = thumbnail(); p.pending[0].resolve([old]); await flush();
  assert.equal(old.releases, 1); assert.equal(published.length, 0);
  let current = true;
  session.request(p, fixture, target, 5000, 11, false, () => current, image => published.push(image));
  current = false;
  const stale = thumbnail(); p.pending[1].resolve([stale]); await flush();
  assert.equal(stale.releases, 1); assert.equal(published.length, 0);
});

test('diagnostic metadata getter failure cannot interrupt preparation or extraction ownership', async () => {
  const { createPausedThumbnailDiagnostic } = loadHelper();
  const session = createPausedThumbnailDiagnostic(), p = player(), published = [];
  Object.defineProperty(p, 'videoTrack', { get() { throw new Error('retired native diagnostic metadata'); } });
  assert.doesNotThrow(() => session.request(p, fixture, target, 5000, 10, false, () => true, value => published.push(value)));
  const image = thumbnail(); p.pending[0].resolve([image]); await flush();
  assert.equal(published[0].image, image);
  session.retire(); session.collect([]); assert.equal(image.releases, 1);
});

test('published image survives until removal commit; extras and uncommitted images are released', async () => {
  const { createPausedThumbnailDiagnostic, logs } = loadHelper();
  const session = createPausedThumbnailDiagnostic(), p = player(), published = [];
  session.request(p, fixture, target, 5000, 10, true, () => true, value => published.push(value));
  const image = thumbnail(), extra = thumbnail(); p.pending[0].resolve([image, extra]); await flush();
  assert.equal(extra.releases, 1); assert.equal(published[0].image, image);
  assert.equal(published[0].prepareToken, 10); assert.equal(published[0].timelineMs, 5000);
  session.retire(); session.collect([image]); assert.equal(image.releases, 0);
  assert.equal(published.at(-1), undefined);
  session.collect([]); session.collect([]); assert.equal(image.releases, 1);
  session.request(p, fixture, target, 5000, 11, false, () => true, value => published.push(value));
  const uncommitted = thumbnail(); p.pending[1].resolve([uncommitted]); await flush();
  session.retire(); session.collect([]); assert.equal(uncommitted.releases, 1);
  assert.deepEqual(p.calls, [target / 1000, target / 1000]);
  for (const [tag, json] of logs) {
    assert.equal(tag, 'CS_PAUSED_THUMB');
    assert.ok(Object.values(JSON.parse(json)).every(v => typeof v === 'number' && Number.isFinite(v)));
  }
  const ready = JSON.parse(logs[1][1]);
  assert.equal(ready.thumbnailEstimatedActualTimeSeconds, 6.375);
  assert.equal(ready.resolvedPreview, 1); assert.equal(JSON.parse(logs[2][1]).resolvedPreview, 0);
});

test('overlapping preparations never publish the retired token or wrong slot', async () => {
  const { createPausedThumbnailDiagnostic } = loadHelper();
  const session = createPausedThumbnailDiagnostic(), p = player(), published = [];
  session.request(p, fixture, target, 5000, 10, true, () => true, value => published.push(['old', value]));
  session.request(p, fixture, target, 5000, 11, true, () => true, value => published.push(['new', value]));
  const fresh = thumbnail(), old = thumbnail(), oldExtra = thumbnail();
  p.pending[1].resolve([fresh]); await flush();
  p.pending[0].resolve([old, oldExtra]); await flush();
  assert.equal(published.length, 1); assert.equal(published[0][0], 'new');
  assert.equal(published[0][1].prepareToken, 11);
  assert.equal(old.releases, 1); assert.equal(oldExtra.releases, 1); assert.equal(fresh.releases, 0);
  session.retire(); session.collect([]); assert.equal(fresh.releases, 1);
});

test('four requests total across remounts; nonfixture, failure and empty result stay bounded', async () => {
  const { createPausedThumbnailDiagnostic, logs } = loadHelper();
  const p = player(); let published = 0;
  createPausedThumbnailDiagnostic().request(p, { ...fixture, width: 1 }, target, 0, 1, false, () => true, () => published++);
  assert.equal(p.calls.length, 0);
  for (let i = 0; i < 6; i++) {
    const session = createPausedThumbnailDiagnostic();
    session.request(p, fixture, target, 0, i, false, () => true, () => published++);
    if (i < 4) {
      if (i % 2) p.pending[i].reject(new Error('PRIVATE URI MUST NOT BE LOGGED'));
      else p.pending[i].resolve([]);
      await flush();
    }
    session.retire(); session.collect([]);
  }
  assert.equal(p.calls.length, 4); assert.equal(logs.length, 8); assert.equal(published, 0);
  assert.ok(!JSON.stringify(logs).includes('PRIVATE URI'));
});

// Run the actual overlay and actual policy modules. Host identity includes the
// full keyed ancestry; no native player behavior is replaced by this diagnostic.
test('thumbnail is a sibling cover with identical transform/fit; native ancestry stays unchanged', () => {
  const cache = new Map();
  const jsx = (type, props, key) => ({ type, props, key });
  const mocks = { 'react/jsx-runtime': { jsx, jsxs: jsx },
    react: { useState: () => [undefined, () => {}], useMemo: fn => fn(), useCallback: fn => fn,
      useRef: value => ({ current: value }), useEffect: () => {} },
    'react-native': { View: 'view', Text: 'text' }, 'expo-video': { VideoView: 'video' }, 'expo-image': { Image: 'image' } };
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText;
    vm.runInNewContext(code, { exports, require(id) {
      if (id in mocks) return mocks[id];
      const stem = id.startsWith('@/') ? resolve(root, 'src', id.slice(2)) : resolve(dirname(file), id);
      if (stem.endsWith('.json')) return JSON.parse(readFileSync(stem, 'utf8'));
      return load(stem + (stem.endsWith('video-transition-overlay') ? '.tsx' : '.ts'));
    } });
    return exports;
  }
  const { VideoTransitionOverlay } = load(resolve(root, 'src/components/editor/video-transition-overlay.tsx'));
  const transform = { fit: 'fill', position: { x: .3, y: .7 }, scale: 1.5, rotation: 17 };
  const props = { entries: [], sources: [], timelineMs: target, isPlaying: false, transportReady: true,
    admitted: true, visible: true, width: 360, height: 640, backgroundColor: '#000',
    players: [{}, {}], slots: [0, 1].map(() => ({ prepareToken: 4, readiness: 'ready', firstFrameReady: true })),
    activeSlot: 0, currentTransform: transform, onFirstFrameRender() {}, setCompositeClock() {} };
  function hosts() {
    const found = [];
    function walk(node, path = 'root', parents = []) {
      if (Array.isArray(node)) { node.forEach((child, i) => walk(child, `${path}/${child?.key ?? i}`, parents)); return; }
      if (!node || typeof node !== 'object') return;
      const identity = `${path}:${typeof node.type === 'function' ? node.type.name : node.type}`;
      if (typeof node.type === 'function') { walk(node.type(node.props), identity, parents); return; }
      const host = { ...node, identity, parents }; found.push(host);
      walk(node.props?.children, identity, [...parents, host]);
    }
    walk(jsx(VideoTransitionOverlay, props)); return found;
  }
  const baseline = hosts().filter(n => n.type === 'video');
  props.slots[0].diagnosticThumbnail = { image: thumbnail(), timelineMs: target, prepareToken: 4 };
  const covered = hosts(), image = covered.find(n => n.type === 'image');
  assert.ok(image, 'diagnostic actually renders');
  assert.deepEqual(covered.filter(n => n.type === 'video').map(n => n.identity), baseline.map(n => n.identity));
  const video = covered.find(n => n.type === 'video');
  assert.equal(image.parents.at(-1), video.parents.at(-1));
  assert.equal(image.props.contentFit, video.props.contentFit); assert.equal(image.props.pointerEvents, 'none');
  assert.equal(image.props.transition, 0);
  assert.equal(video.props.player, baseline[0].props.player);
  assert.equal(JSON.stringify(video.props), JSON.stringify(baseline[0].props));
  assert.equal(JSON.stringify(video.parents.map(n => n.props.style)), JSON.stringify(baseline[0].parents.map(n => n.props.style)));
  for (const patch of [{ isPlaying: true }, { timelineMs: target + 1 }, { transportReady: false }]) {
    const saved = { ...props }; Object.assign(props, patch);
    assert.equal(hosts().filter(n => n.type === 'image').length, 0); Object.assign(props, saved);
  }
  props.slots[0].prepareToken++;
  assert.equal(hosts().filter(n => n.type === 'image').length, 0);
  delete props.slots[0].diagnosticThumbnail;
  assert.equal(hosts().filter(n => n.type === 'image').length, 0);
});
