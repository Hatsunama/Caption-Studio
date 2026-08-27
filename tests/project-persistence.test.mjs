import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { publishAfterDurableWrite } from '../src/lib/persistence-boundaries.ts';

const project = { id: 'project', updatedAt: '2026-08-27T00:00:00.000Z' };

test('project state is published only after its durable write succeeds', async () => {
  const events = [];
  const stored = await publishAfterDurableWrite(
    project,
    async (value) => { events.push(`write:${value.id}`); },
    (value) => events.push(`publish:${value.id}`),
  );
  assert.equal(stored, project);
  assert.deepEqual(events, ['write:project', 'publish:project']);

  let published = false;
  await assert.rejects(
    publishAfterDurableWrite(
      project,
      async () => { throw new Error('write failed'); },
      () => { published = true; },
    ),
    /write failed/,
  );
  assert.equal(published, false);
});

test('editor save and translation workflows cannot swallow persistence failures', () => {
  const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
  const scriptEditor = readFileSync(new URL('../src/components/editor/script-editor.tsx', import.meta.url), 'utf8');
  const translationController = readFileSync(new URL('../src/hooks/use-project-caption-translation.ts', import.meta.url), 'utf8');
  const persistenceService = readFileSync(new URL('../src/services/project-persistence.ts', import.meta.url), 'utf8');

  assert.match(editor, /publishProjectAfterDurableSave\(next, publish\)/);
  assert.match(editor, /commitProject:\s*async[\s\S]*await commitPersistedProject\(next/);
  assert.match(editor, /catch \(caught\)[\s\S]*setPersistenceError\(message\)[\s\S]*throw caught/);
  assert.match(scriptEditor, /await props\.onSave\(draftCaptions\)[\s\S]*setSaveError/);
  assert.match(translationController, /await optionsRef\.current\.commitProject\(baseline, next\)/);
  assert.match(persistenceService, /throw new ProjectPersistenceError\(cause\)/);
  assert.match(persistenceService, /publishAfterDurableWrite/);
});
