import assert from 'node:assert/strict';
import test from 'node:test';
import { assertExportSourcesAvailable } from '../src/lib/export-source-availability.ts';
import { createVideoExportSession } from '../src/services/video-export-session.ts';

const media = { hasVideo: true, hasAudio: true, durationMs: 1000 };
const plan = (overrides = {}) => {
  const value = { clips: [{ id: 'clip1', uri: 'content://video/7121' }], audioClips: [], layers: [], ...overrides };
  return { ...value, audioClips: value.audioClips.map((clip) => ({ muted: false, volume: 1, ...clip })) };
};
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

// readMediaInfo reports audio independently; an audio-only source has no video
// dimensions and short-circuits probeVideoFrame rather than rejecting the call.
const audioOnly = { durationMs: 1000, hasAudio: true, hasVideo: false, hasVideoTrack: false, width: 0, height: 0 };

test('extracted and imported audio-only sources pass without video metadata', async () => {
  for (const uri of ['file:///project/extracted.m4a', 'content://audio/imported']) {
    const calls = [];
    await assertExportSourcesAvailable(plan({ clips: [], audioClips: [{ id: 'a', uri }] }), probe({
      media: async (input) => { calls.push(input); return audioOnly; },
    }));
    assert.deepEqual(calls, [uri]);
  }
});

test('required audio-only source failure prevents rendering and preserves the cause', async () => {
  const cause = new Error('Provider permission revoked');
  let rendered = false;
  await assert.rejects(async () => {
    await assertExportSourcesAvailable(plan({ clips: [], audioClips: [{ id: 'a', uri: 'content://audio/a' }] }), probe({
      media: async () => { throw cause; },
    }));
    rendered = true;
  }, (error) => {
    assert.match(error.message, /audio source for "a" cannot be read/);
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(rendered, false);
});

test('muted and zero-volume audio do not require access; an audible reuse still does', async () => {
  const audioClips = [
    { id: 'muted', uri: 'revoked', muted: true },
    { id: 'silent', uri: 'revoked', volume: 0 },
  ];
  const calls = [];
  const provider = probe({ media: async (uri) => { calls.push(uri); throw new Error('revoked'); } });
  await assertExportSourcesAvailable(plan({ clips: [], audioClips }), provider);
  assert.deepEqual(calls, []);
  await assert.rejects(assertExportSourcesAvailable(plan({ clips: [], audioClips: [
    ...audioClips, { id: 'audible', uri: 'revoked' },
  ] }), provider), /audio source for "audible"/);
  assert.deepEqual(calls, ['revoked']);
});

test('repeated audio URIs are deduplicated without sharing the video track verdict', async () => {
  const calls = [];
  await assertExportSourcesAvailable(plan({ clips: [], audioClips: [
    { id: 'a', uri: 'shared' }, { id: 'b', uri: 'shared' },
  ] }), probe({ media: async (uri) => { calls.push(uri); return audioOnly; } }));
  assert.deepEqual(calls, ['shared']);
  await assert.rejects(assertExportSourcesAvailable(plan({
    clips: [{ id: 'v', uri: 'shared' }], audioClips: [{ id: 'a', uri: 'shared' }],
  }), probe({ media: async () => ({ ...media, hasAudio: false }) })), /audio source/);
  await assert.rejects(assertExportSourcesAvailable(plan(), probe({ media: async () => audioOnly })), /video source/);
});

test('visible image URIs use image validation once and invalid dimensions fail closed', async () => {
  const layers = [
    { id: 'i1', kind: 'image', visible: true, uri: 'shared' },
    { id: 'i2', kind: 'image', visible: true, uri: 'shared' },
    { id: 'hidden', kind: 'image', visible: false, uri: 'revoked' },
    { id: 'text', kind: 'text', visible: true },
    { id: 'captions', kind: 'captions', visible: true },
  ];
  const calls = [];
  await assertExportSourcesAvailable(plan({ clips: [], layers }), probe({
    media: async () => { assert.fail('Images must not use getMediaInfo'); },
    image: async (uri) => { calls.push(uri); return { width: 10, height: 10 }; },
  }));
  assert.deepEqual(calls, ['shared']);
  await assert.rejects(assertExportSourcesAvailable(plan({ clips: [], layers }), probe({
    image: async () => ({ width: 0, height: 10 }),
  })), /image source for "i1"/);
});

test('native rejection after successful audio preflight propagates and permits retry', async () => {
  const session = createVideoExportSession(async () => {});
  const cause = new Error('Native provider read failed after preflight');
  const audioPlan = plan({ clips: [], audioClips: [{ id: 'a', uri: 'content://audio/a' }] });
  await assert.rejects(session.run(async (attempt) => {
    await attempt.waitFor(assertExportSourcesAvailable(audioPlan, probe({ media: async () => audioOnly })));
    return attempt.startNative(async () => { throw cause; });
  }), (error) => error === cause);
  assert.equal(await session.run(async (attempt) => attempt.startNative(async () => 'retried')), 'retried');
});
