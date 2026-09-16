import assert from 'node:assert/strict';
import test from 'node:test';
import { assertExportSourcesAvailable } from '../src/lib/export-source-availability.ts';

const media = { hasVideo: true, hasAudio: true, durationMs: 1000 };
const plan = (overrides = {}) => ({ clips: [{ id: 'clip1', uri: 'content://video/7121' }], audioClips: [], layers: [], ...overrides });
const probe = (overrides = {}) => ({ media: async () => media, image: async () => ({ width: 10, height: 10 }), ...overrides });

test('revoked provider access fails closed before render can start', async () => {
  let rendered = false;
  const cause = new Error('java.lang.SecurityException');
  await assert.rejects(async () => {
    await assertExportSourcesAvailable(plan(), probe({ media: async () => { throw cause; } }));
    rendered = true;
  }, (error) => {
    assert.match(error.message, /Cannot export.*video.*clip1.*cannot be read/);
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(rendered, false);
});

test('checks each required URI once per media kind, sequentially', async () => {
  const calls = [];
  let active = 0;
  await assertExportSourcesAvailable(plan({
    clips: [{ id: 'a', uri: 'video' }, { id: 'b', uri: 'video' }],
    audioClips: [{ id: 'audio1', uri: 'audio' }],
    layers: [{ id: 'hidden', kind: 'image', visible: false, uri: 'hidden' }, { id: 'image1', kind: 'image', visible: true, uri: 'image' }],
  }), probe({
    media: async (uri) => { assert.equal(active++, 0); calls.push(uri); await Promise.resolve(); active--; return media; },
    image: async (uri) => { calls.push(uri); return { width: 10, height: 10 }; },
  }));
  assert.deepEqual(calls, ['video', 'audio', 'image']);
});

test('missing video track, invalid duration, audio and image failure block export', async () => {
  for (const result of [{ ...media, hasVideo: false }, { ...media, durationMs: 0 }, { ...media, durationMs: NaN }]) {
    await assert.rejects(assertExportSourcesAvailable(plan(), probe({ media: async () => result })), /Cannot export/);
  }
  await assert.rejects(assertExportSourcesAvailable(plan({ clips: [], audioClips: [{ id: 'a', uri: 'audio' }] }), probe({ media: async () => ({ ...media, hasAudio: false }) })), /audio source/);
  await assert.rejects(assertExportSourcesAvailable(plan({ layers: [{ id: 'i', kind: 'image', visible: true, uri: 'image' }] }), probe({ image: async () => { throw new Error('missing'); } })), /image source/);
});

test('empty URI fails closed and source checks are fresh on every export attempt', async () => {
  await assert.rejects(assertExportSourcesAvailable(plan({ clips: [{ id: 'a', uri: '' }] }), probe()), /cannot be read/);
  let available = true;
  const provider = probe({ media: async () => { if (!available) throw new Error('revoked'); return media; } });
  await assertExportSourcesAvailable(plan(), provider);
  available = false;
  await assert.rejects(assertExportSourcesAvailable(plan(), provider), /cannot be read/);
});
