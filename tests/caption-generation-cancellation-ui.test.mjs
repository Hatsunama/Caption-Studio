import assert from 'node:assert/strict';
import test from 'node:test';

import { runCaptionCancellationRequest } from '../src/components/editor/caption-generation-cancellation-ui.ts';

test('a failed stop reports the error and immediately permits a retry', async () => {
  const cancelling = [];
  const errors = [];
  const finished = new Promise(() => {});
  const result = await runCaptionCancellationRequest(
    async () => ({ status: 'stop-failed', failures: [new Error('native stop failed')], finished }),
    (value) => cancelling.push(value),
    (message) => errors.push(message),
  );
  assert.deepEqual(cancelling, [true, false]);
  assert.match(errors[0], /native stop failed/);
  assert.match(result.interruptionError, /native stop failed/);
});

test('a successful stop keeps cancellation pending until the work exits', async () => {
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const cancelling = [];
  let settled = false;
  const stopping = runCaptionCancellationRequest(
    async () => ({ status: 'stopping', finished }),
    (value) => cancelling.push(value),
    () => assert.fail('No error expected'),
  ).then(() => { settled = true; });
  await Promise.resolve();
  assert.deepEqual(cancelling, [true]);
  assert.equal(settled, false, 'foreground interruption must await actual work exit');
  finish();
  await stopping;
  assert.deepEqual(cancelling, [true, false]);
});

test('no active work and a thrown cancellation request both release controls', async () => {
  const cancelling = [];
  const errors = [];
  await runCaptionCancellationRequest(
    async () => ({ status: 'idle' }),
    (value) => cancelling.push(value),
    (message) => errors.push(message),
  );
  await runCaptionCancellationRequest(
    async () => { throw new Error('bridge failed'); },
    (value) => cancelling.push(value),
    (message) => errors.push(message),
  );
  assert.deepEqual(cancelling, [true, false, true, false]);
  assert.match(errors[0], /bridge failed/);
});
