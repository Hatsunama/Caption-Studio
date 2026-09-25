import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { timelineHandleLayout, timelineHandleMarkerLayout, timelineVideoHandleLayout } from '../src/lib/timeline-handle-layout.ts';

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
    assert.equal(compact.gripWidth, 24);
    assert.equal(compact.moveLeft, 0);
    assert.equal(compact.moveWidth, width);
  }

  const wide = timelineHandleLayout(true, 240);
  assert.equal(wide.showTrimGrips, true);
  assert.equal(wide.gripWidth, 24);
  assert.equal(wide.moveLeft, 0);
  assert.equal(wide.moveWidth, 240);
});

test('timeline trim markers remain outside the item at every zoom width', () => {
  for (const width of [0.5, 8, 24, 240]) {
    const markers = timelineHandleMarkerLayout(100, width, 24);
    assert.equal(markers.startLeft, 76);
    assert.equal(markers.endLeft, 100 + width);
  }
});

test('selected video grips sit outside the artwork inside a touchable interaction shell', () => {
  for (const width of [2, 8, 24, 240]) {
    const layout = timelineVideoHandleLayout(100, width, 400, true);
    assert.equal(layout.left, 76);
    assert.equal(layout.width, width + 48);
    assert.equal(layout.visualLeft, 24);
    assert.equal(layout.startGripLeft, 0);
    assert.equal(layout.endGripLeft, width + 24);
  }
  assert.deepEqual(timelineVideoHandleLayout(100, 80, 400, false), {
    left: 100, width: 80, visualLeft: 0, visualWidth: 80, startGripLeft: 0, endGripLeft: 56,
  });
  assert.equal(timelineVideoHandleLayout(0, 80, 400, true).startGripLeft, 0);
  assert.equal(timelineVideoHandleLayout(320, 80, 400, true).endGripLeft, 80);

  const source = readFileSync(new URL('../src/components/editor/layer-timeline.tsx', import.meta.url), 'utf8');
  const videoBlock = source.slice(source.indexOf('function VideoClipBlock('), source.indexOf('function ClipFrameThumb('));
  assert.match(videoBlock, /overflow: 'visible'/);
  assert.match(videoBlock, /pointerEvents="none"[\s\S]*overflow: 'hidden'/);
  assert.match(videoBlock, /VideoMoveGrip \{\.\.\.props\} bodyLeft=\{handleLayout\.visualLeft\}/);
  assert.match(videoBlock, /showTrimGrips \? \(/);
});

test('animation browser exposes one live line-spacing control through the existing caption scopes', () => {
  const browser = readFileSync(new URL('../src/components/editor/animation-browser.tsx', import.meta.url), 'utf8');
  const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');

  assert.match(browser, /LINE SPACING/);
  assert.match(browser, /onLineHeightChange/);
  assert.match(editor, /onLineHeightChange/);
  assert.match(editor, /lineHeight:/);
});
