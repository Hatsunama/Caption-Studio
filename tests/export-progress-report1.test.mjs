import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');

test('idle progress stays in preparation and never invents publishing', () => {
  assert.ok(/if \(progress\.stage === 'idle'\) return 'Preparing export'/.test(editor));
  assert.ok(!/return \{ stage: 'publishing', percent: 99 \}/.test(editor));
});

test('a failed progress poll preserves the last good progress and records the error', () => {
  assert.ok(/catch \(caught\) \{\s*if \(active\) setExportProgressPollError\(/.test(editor));
  assert.ok(!/catch \{\s*if \(active\) setExportProgress\(\{ stage: 'rendering', percent: null \}\)/.test(editor));
});

test('share failures are reported with the completed library save', () => {
  const service = readFileSync(new URL('../src/services/project-export.ts', import.meta.url), 'utf8');
  assert.ok(/sharingWarning/.test(service));
  assert.ok(/result\.sharingWarning/.test(editor));
});
