import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CaptionGenerationCancelledError,
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
  assert.equal(await session.cancel(), true);
  await assert.rejects(running, CaptionGenerationCancelledError);
  assert.equal(nativeStops, 1);
  assert.equal(whisperStops, 1);
  assert.equal(await session.cancel(), false);
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

test('cancelling generation rolls durable checkpoints back before later editor saves', () => {
  const workflows = readFileSync(new URL('../src/services/project-workflows.ts', import.meta.url), 'utf8');
  const generation = workflows.slice(
    workflows.indexOf('export async function generateAndSaveProjectCaptions'),
    workflows.indexOf('export async function appendProjectVideoAudioToProject'),
  );
  assert.match(generation, /error instanceof CaptionGenerationCancelledError/);
  assert.match(generation, /await saveProject\(project\)/);
  assert.match(generation, /partial checkpoint could not be rolled back/);
});
