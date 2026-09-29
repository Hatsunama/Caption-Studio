import assert from 'node:assert/strict';
import test from 'node:test';
import { exportProgressPresentation } from '../src/lib/export-progress-presentation.ts';

test('unknown rendering progress is indeterminate rather than a false zero', () => {
  assert.deepEqual(exportProgressPresentation({ stage: 'rendering', percent: null }),
    { kind: 'indeterminate', label: 'Rendering video' });
  assert.deepEqual(exportProgressPresentation({ stage: 'rendering', percent: 42 }),
    { kind: 'determinate', percent: 42, label: 'Rendering video · 42%' });
});
