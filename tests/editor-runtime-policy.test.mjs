import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveEditorRuntimePolicy } from '../src/lib/editor-runtime-policy.ts';

test('editor admits media only while active with no blocking interface', () => {
  assert.deepEqual(
    resolveEditorRuntimePolicy({ appState: 'active', blockingUi: false }),
    { mediaAdmitted: true },
  );
  assert.equal(resolveEditorRuntimePolicy({ appState: 'active', blockingUi: true }).mediaAdmitted, false);
  assert.equal(resolveEditorRuntimePolicy({ appState: 'background', blockingUi: false }).mediaAdmitted, false);
  assert.equal(resolveEditorRuntimePolicy({ appState: 'inactive', blockingUi: false }).mediaAdmitted, false);
});
