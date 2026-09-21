import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { timelineHandleLayout } from '../src/lib/timeline-handle-layout.ts';

test('timeline trim grips are selected-only and remain visible at every positive width', () => {
  assert.deepEqual(timelineHandleLayout(false, 240), {
    showTrimGrips: false,
    gripWidth: 0,
    interactionInset: 0,
    minimumMoveWidth: 0,
    moveLeft: 0,
    moveWidth: 240,
  });

  for (const width of [0.5, 2, 8, 30]) {
    const compact = timelineHandleLayout(true, width);
    assert.equal(compact.showTrimGrips, true);
    assert.ok(compact.gripWidth >= 2 && compact.gripWidth <= 8);
    assert.equal(compact.moveLeft, 0);
    assert.equal(compact.moveWidth, width);
  }

  const wide = timelineHandleLayout(true, 240);
  assert.equal(wide.showTrimGrips, true);
  assert.ok(wide.gripWidth >= 2 && wide.gripWidth <= 8);
  assert.equal(wide.moveLeft, 0);
  assert.equal(wide.moveWidth, 240);
});

test('animation browser exposes one live line-spacing control through the existing caption scopes', () => {
  const browser = readFileSync(new URL('../src/components/editor/animation-browser.tsx', import.meta.url), 'utf8');
  const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');

  assert.match(browser, /LINE SPACING/);
  assert.match(browser, /onLineHeightChange/);
  assert.match(editor, /onLineHeightChange/);
  assert.match(editor, /lineHeight:/);
});
