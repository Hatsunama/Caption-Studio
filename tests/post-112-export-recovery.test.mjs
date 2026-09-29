import assert from 'node:assert/strict';
import test from 'node:test';
import { createEditorSession } from '../src/services/editor-session.ts';

test('durably recovered video access enters the session without becoming undoable', async () => {
  const original = { id: 'project', sources: [{ id: 'video', uri: 'content://lost' }] };
  const recovered = { ...original, sources: [{ ...original.sources[0], uri: 'content://restored' }] };
  const published = [];
  const remembered = [];
  const writes = [];
  const session = createEditorSession(original, (project) => published.push(project),
    async (project) => { writes.push(project); return project; },
    (project) => remembered.push(project));

  const receipt = await session.commit(async (before) => {
    assert.equal(before, original);
    writes.push(recovered); // The recovery service saved this before returning.
    return recovered;
  }, true, false);

  assert.equal(receipt.project, recovered);
  assert.equal(session.current(), recovered);
  assert.deepEqual(published, [recovered]);
  assert.deepEqual(remembered, []);
  assert.deepEqual(writes, [recovered]);
});
