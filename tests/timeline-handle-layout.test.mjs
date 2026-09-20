import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { timelineHandleLayout } from '../src/lib/timeline-handle-layout.ts';

test('timeline trim grips are selected-only and remain proportionate at every width', () => {
  assert.deepEqual(timelineHandleLayout(false, 240), {
    showTrimGrips: false,
    gripWidth: 0,
    moveLeft: 0,
    moveWidth: 240,
  });

  const compact = timelineHandleLayout(true, 30);
  assert.equal(compact.showTrimGrips, false);
  assert.equal(compact.gripWidth, 0);
  assert.equal(compact.moveWidth, 30);

  const wide = timelineHandleLayout(true, 240);
  assert.equal(wide.showTrimGrips, true);
  assert.ok(wide.gripWidth >= 8 && wide.gripWidth <= 16);
  assert.equal(wide.moveLeft, wide.gripWidth);
  assert.equal(wide.moveWidth, 240 - 2 * wide.gripWidth);
});

test('animation browser exposes one live line-spacing control through the existing caption scopes', () => {
  const browser = readFileSync(new URL('../src/components/editor/animation-browser.tsx', import.meta.url), 'utf8');
  const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');

  assert.match(browser, /LINE SPACING/);
  assert.match(browser, /onLineHeightChange/);
  assert.match(editor, /onLineHeightChange/);
  assert.match(editor, /lineHeight:/);
});
