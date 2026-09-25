import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('accepted batches use the durable project commit callback', async () => {
  const service = await readFile(new URL('src/services/caption-translation.ts', root), 'utf8');
  const hook = await readFile(new URL('src/hooks/use-project-caption-translation.ts', root), 'utf8');
  assert.match(service, /await options\.onAcceptedBatch\(operation\.id, \{ captions, needsReview, failureReasons, provider \}\)/);
  assert.match(service, /await CaptionTranslation\.getNaturalCaptionAcceptedBatches\(requestId\)/);
  assert.match(hook, /onAcceptedBatch: async \(batch\)/);
  assert.match(hook, /await optionsRef\.current\.commitProject\(current, updated\)/);
});

test('incremental refresh rejects a batch when any source or cue changed', async () => {
  const hook = await readFile(new URL('src/hooks/use-project-caption-translation.ts', root), 'utf8');
  assert.match(hook, /safe\.length !== batchCaptions\.length/);
  assert.match(hook, /if \(!committed\) throw new Error/);
});
