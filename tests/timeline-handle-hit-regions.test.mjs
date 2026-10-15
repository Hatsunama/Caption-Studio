import assert from 'node:assert/strict';
import test from 'node:test';
import * as handles from '../src/lib/timeline-handle-layout.ts';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const right = (rect) => rect.left + rect.width;
const contains = (rect, x, y) => rect && x >= rect.left && x < right(rect) && y >= rect.top && y < rect.top + rect.height;
const targetsAt = (layout, x, y) => ['startHit', 'moveHit', 'endHit'].filter((key) => contains(layout[key], x, y));

for (const seconds of [0.12, 1, 2]) {
  const width = seconds / 60 * 960;
  for (const blockLeft of [0, 400, 960 - width]) {
    test(`selected video ${seconds}s at ${blockLeft}px retains complete external grips`, () => {
      const layout = handles.timelineVideoHandleLayout(blockLeft, width, 960, true);
      const clearance = Math.max(0, 8 - width) / 2;
      close(layout.left, blockLeft - 24 - clearance);
      close(layout.width, width + 48 + 2 * clearance);
      close(layout.visualLeft, 24 + clearance);
      close(layout.startGripLeft, 0);
      close(layout.endGripLeft, layout.width - 24);
      close(layout.left + layout.visualLeft, blockLeft);
      close(layout.visualWidth, width);
    });
  }
}

test('shared body-relative geometry partitions trim and move targets across zoom widths', () => {
  assert.equal(typeof handles.timelineHandleHitLayout, 'function');
  for (const width of [0.5, 1.92, 2, 7.99, 8, 16, 24, 32, 240, 1200]) {
    const layout = handles.timelineHandleHitLayout(true, width);
    const clearance = Math.max(0, 8 - width) / 2;
    assert.equal(layout.showTrimGrips, true);
    close(layout.envelope.left, -24 - clearance);
    close(layout.envelope.width, Math.max(8, width) + 48);
    close(layout.moveHit.left, -clearance);
    assert.equal(layout.moveHit.width, Math.max(8, width));
    close(layout.startLeft, layout.startHit.left);
    close(layout.endLeft, layout.endHit.left);
    assert.equal(layout.startHit.width, 24);
    assert.equal(layout.endHit.width, 24);
    assert.equal(right(layout.startHit), layout.moveHit.left);
    assert.equal(right(layout.moveHit), layout.endHit.left);
    close(layout.startHit.left, layout.envelope.left);
    close(right(layout.endHit), right(layout.envelope));
    for (const key of ['startHit', 'moveHit', 'endHit']) {
      const rect = layout[key];
      assert.equal(rect.top, 0);
      assert.equal(rect.height, 38);
      for (const y of [0, 19, 37.999]) {
        assert.deepEqual(targetsAt(layout, rect.left + rect.width / 2, y), [key]);
      }
    }
    assert.deepEqual(targetsAt(layout, layout.moveHit.left, 19), ['moveHit']);
    assert.deepEqual(targetsAt(layout, layout.endHit.left, 19), ['endHit']);
    assert.deepEqual(targetsAt(layout, layout.envelope.left - 0.001, 19), []);
    assert.deepEqual(targetsAt(layout, right(layout.envelope), 19), []);
    assert.deepEqual(targetsAt(layout, 0, -0.001), []);
    assert.deepEqual(targetsAt(layout, 0, 38), []);
  }
});

test('legacy selected geometry delegates to the complete hit envelope', () => {
  for (const width of [0.5, 1.92, 2, 7.99, 8, 24, 240]) {
    const hit = handles.timelineHandleHitLayout(true, width);
    const legacy = handles.timelineHandleLayout(true, width);
    assert.equal(legacy.interactionInset, -hit.envelope.left);
    assert.equal(legacy.moveLeft, hit.moveHit.left);
    assert.equal(legacy.moveWidth, hit.moveHit.width);
    assert.equal(legacy.gripWidth, hit.startHit.width);
  }
});

test('shell-local seams have one owner after fractional track translation', () => {
  for (const width of [1.92, 7.99, 8.01, 31.99, 240.123]) {
    for (const blockLeft of [0, 0.1, 400.123, 960 - width]) {
      const video = handles.timelineVideoHandleLayout(blockLeft, width, 960, true);
      const shell = {
        startHit: { left: video.startGripLeft, width: 24, top: 0, height: 38 },
        moveHit: { left: video.moveLeft, width: video.moveWidth, top: 0, height: 38 },
        endHit: { left: video.endGripLeft, width: 24, top: 0, height: 38 },
      };
      assert.equal(right(shell.startHit), shell.moveHit.left);
      assert.equal(right(shell.moveHit), shell.endHit.left);
      assert.equal(right(shell.endHit), video.width);
      assert.deepEqual(targetsAt(shell, shell.moveHit.left, 19), ['moveHit']);
      assert.deepEqual(targetsAt(shell, shell.endHit.left, 19), ['endHit']);
      close(video.left + video.visualLeft, blockLeft);
      assert.equal(video.visualWidth, width);
    }
  }
});

test('video delegates to the shared geometry without changing body or temporal bounds', () => {
  assert.equal(typeof handles.timelineHandleHitLayout, 'function');
  for (const width of [1.92, 8, 16, 32, 240]) {
    const shared = handles.timelineHandleHitLayout(true, width);
    for (const trackWidth of [0, 960]) {
      const video = handles.timelineVideoHandleLayout(0, width, trackWidth, true);
      assert.deepEqual(video.hitLayout, shared);
      close(video.moveLeft, shared.moveHit.left - shared.envelope.left);
      close(video.moveWidth, shared.moveHit.width);
      assert.equal(video.height, 38);
      close(video.visualLeft + video.left, 0);
      assert.equal(video.visualWidth, width);
    }
  }
});

test('unselected and empty bodies expose no trim targets or phantom move area', () => {
  assert.equal(typeof handles.timelineHandleHitLayout, 'function');
  for (const [selected, width] of [[false, 80], [false, -1], [true, 0], [true, -1]]) {
    const layout = handles.timelineHandleHitLayout(selected, width);
    const bodyWidth = Math.max(0, width);
    assert.equal(layout.showTrimGrips, false);
    assert.equal(layout.startHit, null);
    assert.equal(layout.endHit, null);
    assert.deepEqual(layout.moveHit, { left: 0, top: 0, width: bodyWidth, height: 38 });
    assert.deepEqual(layout.envelope, layout.moveHit);
  }
  assert.deepEqual(handles.timelineHandleLayout(false, 80), {
    showTrimGrips: false, gripWidth: 0, interactionInset: 0, minimumMoveWidth: 0, moveLeft: 0, moveWidth: 80,
  });
  assert.deepEqual(handles.timelineVideoHandleLayout(100, 80, 400, false), {
    left: 100, width: 80, visualLeft: 0, visualWidth: 80, startGripLeft: 0, endGripLeft: 56,
  });
});
