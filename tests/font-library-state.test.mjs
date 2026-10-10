import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createFontLibraryController } from '../src/lib/font-library-controller.ts';

const defaults = ['bungee', 'monoton', 'rubik-glitch'];
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const library = (extra = {}) => ({ imported: [], favorites: defaults, recent: [], ...extra });
const choice = (id) => ({ font: { id, family: id, source: 'imported' }, name: id, mood: 'Custom', treatment: 'solid' });
function harness() {
  const loads = [], imports = [], writes = [], notices = [];
  const services = {
    loadFontLibrary() { const d = deferred(); loads.push(d); return d.promise; },
    importFontFromDevice() { const d = deferred(); imports.push(d); return d.promise; },
    saveFontFavorites(ids) { const d = deferred(); writes.push({ kind: 'favorites', ids: [...ids], ...d }); return d.promise; },
    saveRecentFonts(ids) { const d = deferred(); writes.push({ kind: 'recent', ids: [...ids], ...d }); return d.promise; },
  };
  const c = createFontLibraryController(services, (...args) => notices.push(args));
  return { c, services, loads, imports, writes, notices };
}

test('late load rejection is silent after close and cannot notify a reopened session', async () => {
  const h = harness(); const close = h.c.open(); close();
  const closeAgain = h.c.open();
  h.loads[0].reject(Error('old failure')); await flush();
  assert.equal(h.notices.length, 0);
  h.loads[1].resolve(library({ favorites: ['fresh'] })); await flush();
  assert.deepEqual(h.c.getSnapshot().favorites, ['fresh']); closeAgain();
});

test('old load success cannot overwrite reopened state; current failure can recover', async () => {
  const h = harness(); const close = h.c.open(); close(); h.c.open();
  h.loads[1].resolve(library({ favorites: ['new'] })); await flush();
  h.loads[0].resolve(library({ favorites: ['old'] })); await flush();
  assert.deepEqual(h.c.getSnapshot().favorites, ['new']);
  const stop = h.c.open(); h.loads[2].reject(Error('current')); await flush();
  assert.equal(h.notices.length, 1); stop(); h.c.open();
  h.loads[3].resolve(library({ recent: ['recovered'] })); await flush();
  assert.deepEqual(h.c.getSnapshot().recent, ['recovered']);
});

test('hydration defers writes and rebases preferences on disk', async () => {
  const h = harness(); h.c.open();
  h.c.toggleFavorite('clicked'); h.c.rememberFont('chosen'); await flush();
  assert.equal(h.writes.length, 0);
  h.loads[0].resolve(library({ favorites: ['disk'], recent: ['history'] })); await flush();
  assert.deepEqual(h.c.getSnapshot().favorites, ['disk', 'clicked']);
  assert.deepEqual(h.c.getSnapshot().recent, ['chosen', 'history']);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.writes[0].ids, ['disk', 'clicked']);
  h.writes[0].resolve(); await flush();
  assert.deepEqual(h.writes[1].ids, ['chosen', 'history']);
  h.writes[1].resolve(); await flush();
});

test('failed initial read retains queued operations until retry', async () => {
  const h = harness(); const close = h.c.open();
  h.c.toggleFavorite('clicked'); h.loads[0].reject(Error('unreadable')); await flush();
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.notices, [['Could not load fonts', 'unreadable']]);
  h.c.rememberFont('chosen'); h.c.toggleFavorite('clicked'); await flush();
  assert.equal(h.writes.length, 0);
  close(); h.c.open();
  h.loads[1].resolve(library({ favorites: ['disk'], recent: ['history'] })); await flush();
  assert.deepEqual(h.c.getSnapshot().favorites, ['disk']);
  assert.deepEqual(h.c.getSnapshot().recent, ['chosen', 'history']);
  h.writes[0].reject(Error('old owner')); await flush();
  assert.equal(h.notices.length, 1);
  h.writes[1].resolve(); await flush(); h.writes[2].resolve(); await flush();
  assert.deepEqual(h.writes.map((w) => [w.kind, w.ids]), [
    ['favorites', ['disk', 'clicked']], ['recent', ['chosen', 'history']], ['favorites', ['disk']],
  ]);
});

test('preload toggle replays against loaded membership', async () => {
  const h = harness(); h.c.open(); h.c.toggleFavorite('disk');
  h.loads[0].resolve(library({ favorites: ['disk'] })); await flush();
  assert.deepEqual(h.c.getSnapshot().favorites, []);
  assert.deepEqual(h.writes[0].ids, []);
  h.writes[0].resolve(); await flush();
});

test('queued hydration actions survive close and reopen with imports and ordered rapid toggles', async () => {
  const h = harness(); const close = h.c.open();
  h.c.toggleFavorite('x'); h.c.rememberFont('a'); h.c.toggleFavorite('x');
  const imported = h.c.importFont(); close();
  h.imports[0].resolve(choice('durable')); assert.equal(await imported, false);
  h.loads[0].resolve(library({ favorites: ['obsolete'] })); await flush();
  assert.equal(h.writes.length, 0);
  h.c.open(); h.c.rememberFont('b'); h.c.toggleFavorite('y'); h.c.rememberFont('a');
  h.loads[1].resolve(library({ favorites: ['disk'], recent: ['history'] })); await flush();
  assert.deepEqual(h.c.getSnapshot().favorites, ['disk', 'y']);
  assert.deepEqual(h.c.getSnapshot().recent, ['a', 'b', 'history']);
  assert.deepEqual(h.c.getSnapshot().imported.map((c) => c.font.id), ['durable']);
  for (let i = 0; i < 6; i++) {
    assert.equal(h.writes.length, i + 1); h.writes[i].resolve(); await flush();
  }
  assert.deepEqual(h.writes.map((w) => [w.kind, w.ids]), [
    ['favorites', ['disk', 'x']], ['recent', ['a', 'history']], ['favorites', ['disk']],
    ['recent', ['b', 'a', 'history']], ['favorites', ['disk', 'y']], ['recent', ['a', 'b', 'history']],
  ]);
  assert.equal(h.notices.length, 0);
});

test('rebased favorite failures roll back to loaded or last confirmed favorites and recover', async () => {
  const h = harness(); h.c.open(); h.c.toggleFavorite('x'); h.c.toggleFavorite('y');
  h.loads[0].resolve(library({ favorites: ['disk'] })); await flush();
  h.writes[0].reject(Error('older')); await flush();
  assert.deepEqual(h.c.getSnapshot().favorites, ['disk', 'x', 'y']);
  h.writes[1].reject(Error('latest')); await flush();
  assert.deepEqual(h.c.getSnapshot().favorites, ['disk']);
  assert.deepEqual(h.notices, [
    ['Could not save favorites', 'older'], ['Could not save favorites', 'latest'],
  ]);
  h.c.toggleFavorite('saved'); await flush(); h.writes[2].resolve(); await flush();
  h.c.toggleFavorite('bad'); await flush(); h.writes[3].reject(Error('bad')); await flush();
  assert.deepEqual(h.c.getSnapshot().favorites, ['disk', 'saved']);
});

test('rapid toggles and history writes serialize in invocation order and cap history at eight', async () => {
  const h = harness(); h.c.open(); h.loads[0].resolve(library()); await flush();
  h.c.toggleFavorite('x'); h.c.toggleFavorite('x'); h.c.toggleFavorite('y');
  for (let i = 0; i < 10; i++) h.c.rememberFont(String(i));
  h.c.rememberFont('5'); await flush();
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.c.getSnapshot().recent, ['5', '9', '8', '7', '6', '4', '3', '2']);
  for (let i = 0; i < 14; i++) { assert.equal(h.writes.length, i + 1); h.writes[i].resolve(); await flush(); }
  assert.deepEqual(h.writes.slice(0, 3).map((w) => w.ids), [[...defaults, 'x'], defaults, [...defaults, 'y']]);
  assert.deepEqual(h.writes.at(-1).ids, h.c.getSnapshot().recent);
});

test('favorite failures rollback only the latest action to the last confirmed save; queue recovers', async () => {
  const h = harness(); h.c.open(); h.loads[0].resolve(library()); await flush();
  h.c.toggleFavorite('x'); h.c.toggleFavorite('y'); await flush();
  h.writes[0].reject(Error('older')); await flush();
  assert.deepEqual(h.c.getSnapshot().favorites, [...defaults, 'x', 'y']);
  h.writes[1].reject(Error('latest')); await flush();
  assert.deepEqual(h.c.getSnapshot().favorites, defaults);
  h.c.toggleFavorite('z'); await flush(); h.writes[2].resolve(); await flush();
  h.c.toggleFavorite('bad'); await flush(); h.writes[3].reject(Error('bad')); await flush();
  assert.deepEqual(h.c.getSnapshot().favorites, [...defaults, 'z']);
});

test('recent failure keeps selection/history, survives reopen, and later persistence recovers', async () => {
  const h = harness(); const close = h.c.open(); h.loads[0].resolve(library()); await flush();
  h.c.rememberFont('chosen'); await flush(); close();
  h.writes[0].reject(Error('disk full')); await flush();
  assert.deepEqual(h.c.getSnapshot().recent, ['chosen']); assert.equal(h.notices.length, 0);
  h.c.open(); h.loads[1].resolve(library({ recent: ['stale'] })); await flush();
  assert.deepEqual(h.c.getSnapshot().recent, ['chosen']);
  h.c.rememberFont('next'); await flush(); h.writes[1].resolve(); await flush();
  assert.deepEqual(h.writes[1].ids, ['next', 'chosen']);
});

test('successful import after close remains available on reopen without changing old UI', async () => {
  const h = harness(); const close = h.c.open(); h.loads[0].resolve(library()); await flush();
  const result = h.c.importFont(); close(); h.c.open();
  h.imports[0].resolve(choice('durable')); assert.equal(await result, false);
  h.loads[1].resolve(library()); await flush();
  assert.deepEqual(h.c.getSnapshot().imported.map((c) => c.font.id), ['durable']);
  assert.equal(h.notices.length, 0);
});

test('current import succeeds, cancellation is false, and old import rejection is silent', async () => {
  const h = harness(); const close = h.c.open();
  let result = h.c.importFont(); h.imports[0].resolve(choice('one')); assert.equal(await result, true);
  result = h.c.importFont(); h.imports[1].resolve(null); assert.equal(await result, false);
  result = h.c.importFont(); close(); h.c.open(); h.imports[2].reject(Error('old'));
  assert.equal(await result, false); assert.equal(h.notices.length, 0);
  result = h.c.importFont(); h.imports[3].reject(Error('current'));
  assert.equal(await result, false); assert.equal(h.notices.length, 1);
});

test('pending favorites survive reopen and obsolete cleanup cannot close the new session', async () => {
  const h = harness(); const oldClose = h.c.open(); h.loads[0].resolve(library()); await flush();
  h.c.toggleFavorite('pending'); await flush(); oldClose(); h.c.open(); oldClose();
  h.loads[1].resolve(library({ favorites: [] })); await flush();
  assert.deepEqual(h.c.getSnapshot().favorites, [...defaults, 'pending']);
  h.writes[0].reject(Error('old session')); await flush();
  assert.deepEqual(h.c.getSnapshot().favorites, defaults); assert.equal(h.notices.length, 0);
});

test('hook binds services, invalidates on layout cleanup, and performs no updater I/O', async () => {
  const h = harness(); let state, cleanup, dependencies, pending;
  const source = stripTypeScriptTypes(readFileSync(new URL('../src/hooks/use-font-library.ts', import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\s*/gm, '').replace('export function', 'function');
  const context = {
    ...h.services, createFontLibraryController, Alert: { alert: (...args) => h.notices.push(args) },
    useState(init) { state ??= init(); return [state, () => assert.fail('no state updater needed')]; },
    useSyncExternalStore(subscribe, get) { return get(); },
    useLayoutEffect(effect, deps) {
      if (!dependencies || deps.some((v, i) => v !== dependencies[i])) {
        pending = () => { cleanup?.(); cleanup = effect(); }; dependencies = deps;
      }
    },
  };
  runInNewContext(`${source}; this.hook = useFontLibrary;`, context);
  const render = (visible) => { const api = context.hook(visible); pending?.(); pending = undefined; return api; };
  const first = render(true); assert.deepEqual(Object.keys(first).sort(), ['favorites', 'importFont', 'imported', 'recent', 'rememberFont', 'toggleFavorite']);
  render(false); render(true); h.loads[0].reject(Error('obsolete')); await flush();
  assert.equal(h.notices.length, 0);
  h.loads[1].resolve(library()); await flush();
  const api = render(true); assert.equal(api.toggleFavorite, first.toggleFavorite);
  api.toggleFavorite('wired'); await flush(); assert.equal(h.writes.length, 1);
  cleanup(); h.writes[0].reject(Error('unmounted')); await flush(); assert.equal(h.notices.length, 0);
});
