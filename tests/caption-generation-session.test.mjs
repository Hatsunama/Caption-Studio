import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CaptionGenerationCancelledError,
  CaptionGenerationStopError,
  createCaptionGenerationSession,
} from '../src/services/caption-generation-session.ts';

test('caption cancellation stops native extraction and the active Whisper operation', async () => {
  let nativeStops = 0;
  let whisperStops = 0;
  let finishOperation;
  const operation = new Promise((resolve) => { finishOperation = resolve; });
  const session = createCaptionGenerationSession(async () => { nativeStops += 1; });
  const running = session.run(async (context) => {
    context.registerStopper(async () => {
      whisperStops += 1;
      finishOperation();
    });
    await operation;
    context.throwIfCancelled();
    return 'finished';
  });

  await Promise.resolve();
  const cancellation = await session.cancel();
  assert.equal(cancellation.status, 'stopping');
  await assert.rejects(running, CaptionGenerationCancelledError);
  assert.equal(nativeStops, 1);
  assert.equal(whisperStops, 1);
  assert.equal((await session.cancel()).status, 'idle');
});

test('a completed or cancelled caption session never poisons the next generation', async () => {
  const session = createCaptionGenerationSession(async () => undefined);
  assert.equal(await session.run(async (context) => {
    context.throwIfCancelled();
    return 1;
  }), 1);

  let finishOperation;
  const operation = new Promise((resolve) => { finishOperation = resolve; });
  const cancelled = session.run(async (context) => {
    context.registerStopper(async () => finishOperation());
    await operation;
    context.throwIfCancelled();
  });
  await Promise.resolve();
  await session.cancel();
  await assert.rejects(cancelled, CaptionGenerationCancelledError);

  assert.equal(await session.run(async () => 2), 2);
});

test('a real work failure remains visible when cancellation races with it', async () => {
  let failWork;
  const pending = new Promise((_resolve, reject) => { failWork = reject; });
  const failure = new Error('Model download checksum failed');
  const session = createCaptionGenerationSession(async () => undefined);
  const running = session.run(async () => pending);
  const rejection = assert.rejects(running, (error) => error === failure);
  await session.cancel();
  failWork(failure);
  await rejection;
  assert.equal(await session.run(async () => 'next attempt'), 'next attempt');
});

test('failed native and registered stops are both reported while work remains active', async () => {
  const nativeFailure = new Error('native stop failed');
  const stopperFailure = new Error('Whisper stop failed');
  const calls = [];
  let releaseWork;
  const workHeld = new Promise((resolve) => { releaseWork = resolve; });
  const session = createCaptionGenerationSession(() => {
    calls.push('native');
    throw nativeFailure;
  });
  const running = session.run(async (context) => {
    context.registerStopper(() => {
      calls.push('stopper');
      throw stopperFailure;
    });
    await workHeld;
    context.throwIfCancelled();
  });

  const result = await session.cancel();
  assert.equal(result.status, 'stop-failed');
  assert.deepEqual(result.failures, [nativeFailure, stopperFailure]);
  assert.deepEqual(calls, ['native', 'stopper']);
  let exited = false;
  void result.finished.then(() => { exited = true; });
  await Promise.resolve();
  assert.equal(exited, false);
  await assert.rejects(session.run(async () => 'too early'), /already underway/);

  const completion = assert.rejects(running, CaptionGenerationStopError);
  releaseWork();
  await completion;
  await result.finished;
  assert.equal(exited, true);
  assert.equal(await session.run(async () => 'next run'), 'next run');
});

test('a failed stop can be retried without freeing a still-running session', async () => {
  let stopAttempts = 0;
  let releaseWork;
  const workHeld = new Promise((resolve) => { releaseWork = resolve; });
  const session = createCaptionGenerationSession(async () => {
    stopAttempts += 1;
    if (stopAttempts === 1) throw new Error('temporary native failure');
  });
  const running = session.run(async (context) => {
    await workHeld;
    context.throwIfCancelled();
  });

  assert.equal((await session.cancel()).status, 'stop-failed');
  assert.equal((await session.cancel()).status, 'stopping');
  assert.equal(stopAttempts, 2);
  await assert.rejects(session.run(async () => 'too early'), /already underway/);
  const completion = assert.rejects(running, CaptionGenerationCancelledError);
  releaseWork();
  await completion;
  assert.equal((await session.cancel()).status, 'idle');
});

test('new work waits for an in-flight native stop after the old work exits', async () => {
  let finishStop;
  const stopHeld = new Promise((resolve) => { finishStop = resolve; });
  let releaseWork;
  const workHeld = new Promise((resolve) => { releaseWork = resolve; });
  const session = createCaptionGenerationSession(async () => stopHeld);
  const running = session.run(async () => workHeld);
  const rejection = assert.rejects(running, CaptionGenerationCancelledError);
  const cancellation = session.cancel();
  releaseWork();
  await Promise.resolve();
  await assert.rejects(session.run(async () => 'too early'), /already underway/);
  finishStop();
  assert.equal((await cancellation).status, 'stopping');
  await rejection;
  assert.equal(await session.run(async () => 'next run'), 'next run');
});
