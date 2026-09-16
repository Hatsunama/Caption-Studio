import assert from 'node:assert/strict';
import test from 'node:test';
import { canReuseVideoSource, loadPlayableVideoSource, videoSourceFailure } from '../src/lib/video-source-recovery.ts';

const source = { id: 'source-1', uri: 'content://com.android.providers.media.documents/document/video%3A7121', displayName: 'clip1.mp4' };
function fakePlayer(replace = async () => {}) {
  const listeners = new Set();
  return {
    status: 'idle', listeners, replaceAsync: replace,
    addListener(_event, listener) { listeners.add(listener); return { remove: () => listeners.delete(listener) }; },
    emit(status, message) { this.status = status; for (const listener of [...listeners]) listener({ status, error: message ? { message } : undefined }); },
  };
}

test('SAF SecurityException becomes source-specific, actionable recovery without exposing raw URI', () => {
  const failure = videoSourceFailure(source, { message: 'java.lang.SecurityException: Permission Denial' });
  assert.equal(failure.sourceId, source.id);
  assert.equal(failure.uri, source.uri);
  assert.match(failure.message, /cannot read this video/);
  assert.match(failure.message, /reopen this project/);
  assert.doesNotMatch(failure.message, /content:\/\/|SecurityException/);
  assert.match(failure.detail, /SecurityException/);
});

test('decoder errors do not claim permission loss', () => {
  assert.match(videoSourceFailure(source, new Error('Decoder init failed')).message, /could not be played/);
});

test('same ID with a relinked URI or failed/loading player cannot reuse the decoder', () => {
  assert.equal(canReuseVideoSource(source, source, 'readyToPlay'), true);
  assert.equal(canReuseVideoSource(source, { ...source, uri: 'content://new' }, 'readyToPlay'), false);
  for (const status of ['error', 'loading', 'idle']) assert.equal(canReuseVideoSource(source, source, status), false);
  assert.equal(canReuseVideoSource(undefined, source, 'readyToPlay'), false);
});

test('replacement completion alone does not clear failure; native ready is required', async () => {
  const player = fakePlayer();
  let ready = false;
  const operation = loadPlayableVideoSource(player, source.uri).then(() => { ready = true; });
  await Promise.resolve();
  assert.equal(ready, false);
  player.emit('readyToPlay');
  await operation;
  assert.equal(ready, true);
  assert.equal(player.listeners.size, 0);
});

test('native error during replacement rejects and late completion cannot revive it', async () => {
  let complete;
  const player = fakePlayer(() => new Promise((resolve) => { complete = resolve; }));
  const operation = loadPlayableVideoSource(player, source.uri);
  player.emit('error', 'SecurityException: Permission Denial');
  await assert.rejects(operation, /SecurityException/);
  complete();
  player.emit('readyToPlay');
  assert.equal(player.listeners.size, 0);
});

test('rejected replacement and readiness timeout both clean up subscriptions', async () => {
  const rejected = fakePlayer(async () => { throw new Error('provider offline'); });
  await assert.rejects(loadPlayableVideoSource(rejected, source.uri), /provider offline/);
  assert.equal(rejected.listeners.size, 0);
  const stalled = fakePlayer();
  await assert.rejects(loadPlayableVideoSource(stalled, source.uri, 5), /did not become ready/);
  assert.equal(stalled.listeners.size, 0);
});

test('explicit retry actually replaces the same URI and waits for fresh readiness', async () => {
  const attempts = [];
  const player = fakePlayer(async (uri) => { attempts.push(uri); player.emit(attempts.length === 1 ? 'error' : 'readyToPlay', 'Permission denied'); });
  await assert.rejects(loadPlayableVideoSource(player, source.uri), /Permission denied/);
  await loadPlayableVideoSource(player, source.uri);
  assert.deepEqual(attempts, [source.uri, source.uri]);
});
