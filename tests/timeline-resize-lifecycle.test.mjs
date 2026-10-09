import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

import * as timing from '../src/lib/timeline-gesture.ts';

// Execute the production responder callbacks without installing React Native.
const source = readFileSync(new URL('../src/components/editor/layer-timeline.tsx', import.meta.url), 'utf8');
const timingHook = source.slice(source.indexOf('function useTimelineTimingPanHandlers('), source.indexOf('function DirectTimelineGestureSurface('));
const videoHook = source.slice(source.indexOf('function VideoMoveGrip('), source.indexOf('  const moveWidth = props.selected')) + '\n  return responder.panHandlers;\n}\n';
const layoutCallback = source.slice(source.indexOf('onLayout={') + 'onLayout={'.length, source.indexOf('\n      onStartShouldSetResponderCapture=')).trim().slice(0, -1);
const executable = stripTypeScriptTypes(`
export function load(dependencies) {
  const { useRef, useMemo, useEffect, useContext, useCallback, PanResponder, TimelineGestureGeometryContext,
    createTimelineTimingGesture, clamp, REORDER_TILE, REORDER_GAP } = dependencies;
  ${timingHook}
  ${videoHook}
  return { useTimelineTimingPanHandlers, VideoMoveGrip };
}
export function layout(gestureGeometry, setViewportWidth) {
  const scrubEndTimer = { current: null };
  const scrubbingRef = { current: true };
  const selectionOwnsViewportRef = { current: true };
  const pinch = { current: { distance: 100 } };
  return ${layoutCallback};
}
`);
const production = await import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`);

function harness() {
  const cancellations = new Set();
  // The fallback lets the baseline execute its actual resize handler and fail
  // on stale behavior, instead of failing on an import for the new helper.
  const geometry = timing.createTimelineGestureGeometry?.({ viewportWidth: 360, scale: 16 }) ?? {
    subscribe(cancel) { cancellations.add(cancel); return () => cancellations.delete(cancel); },
    update() { for (const cancel of cancellations) cancel(); },
  };
  const cleanups = [];
  let width = 360;
  const hooks = production.load({
    useRef: (current) => ({ current }),
    useMemo: (factory) => factory(),
    useEffect: (effect) => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); },
    useContext: () => geometry,
    useCallback: (callback) => callback,
    PanResponder: { create: (panHandlers) => ({ panHandlers }) },
    TimelineGestureGeometryContext: {},
    createTimelineTimingGesture: timing.createTimelineTimingGesture,
    clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
    REORDER_TILE: 72,
    REORDER_GAP: 8,
  });
  return {
    ...hooks, geometry,
    resize: production.layout(geometry, (next) => { width = next; }),
    get width() { return width; },
    unmount() { for (const cleanup of cleanups) cleanup(); },
  };
}

const touch = { nativeEvent: { touches: [{}] } };
const layout = (width) => ({ nativeEvent: { layout: { width } } });

for (const edge of ['start', 'end', 'move']) {
  test(`viewport resize invalidates active ${edge} before another move or release`, () => {
    const fixture = harness();
    const changes = [];
    const locks = [];
    let starts = 0;
    let commits = 0;
    let cancels = 0;
    const handlers = fixture.useTimelineTimingPanHandlers({
      startMs: 1_000, endMs: 2_000, durationMs: 5_000, trackWidth: 1_000,
      onPress() {}, onChangeStart() { starts += 1; },
      onChange(...change) { changes.push(change); },
      onEnd() { commits += 1; }, onCancel() { cancels += 1; },
    }, edge, (locked) => locks.push(locked));
    handlers.onPanResponderGrant();
    handlers.onPanResponderMove(touch, { dx: 60, dy: 0 });
    fixture.resize(layout(720));
    handlers.onPanResponderMove(touch, { dx: 120, dy: 0 });
    handlers.onPanResponderRelease();
    assert.equal(fixture.width, 720);
    assert.equal(changes.length, 1, 'resized coordinates must not reach the editor');
    assert.equal(starts, 1);
    assert.equal(cancels, 1);
    assert.equal(commits, 0, 'video trim must not commit a stale draft');
    assert.deepEqual(locks, [true, false]);
    fixture.unmount();
  });
}

test('duplicate layout leaves a normal trim active and able to commit', () => {
  const fixture = harness();
  let commits = 0;
  const changes = [];
  const handlers = fixture.useTimelineTimingPanHandlers({
    startMs: 1_000, endMs: 2_000, durationMs: 5_000, trackWidth: 1_000,
    onPress() {}, onChangeStart() {}, onChange(...args) { changes.push(args); },
    onEnd() { commits += 1; }, onCancel() { assert.fail('normal trim cancelled'); },
  }, 'end');
  handlers.onPanResponderGrant();
  handlers.onPanResponderMove(touch, { dx: 60, dy: 0 });
  fixture.resize(layout(360));
  handlers.onPanResponderMove(touch, { dx: 80, dy: 0 });
  handlers.onPanResponderRelease();
  assert.equal(changes.length, 2);
  assert.equal(commits, 1);
  fixture.unmount();
});

for (const mode of ['pending hold', 'gap', 'reorder']) {
  test(`resize cancels video ${mode}, including its pending long press`, async () => {
    const fixture = harness();
    const previews = [];
    const commits = [];
    let cancels = 0;
    const handlers = fixture.VideoMoveGrip({
      leadingGapMs: 0, clipIndex: 0, clipCount: 3, trackWidth: 1_000, durationMs: 5_000,
      onPress() {}, onGestureLock() {},
      onGapPreview(value) { previews.push(value); },
      onReorderPreview(value) { previews.push(value); },
      onGapCommit(value) { commits.push(value); },
      onReorderCommit(value) { commits.push(value); },
      onReorderCancel() { cancels += 1; }, onGestureCancel() { cancels += 1; },
    });
    handlers.onPanResponderGrant();
    if (mode === 'gap') handlers.onPanResponderMove(touch, { dx: 60, dy: 0 });
    if (mode === 'reorder') await new Promise((resolve) => setTimeout(resolve, 380));
    const beforeResize = previews.length;
    fixture.resize(layout(720));
    await new Promise((resolve) => setTimeout(resolve, 380));
    handlers.onPanResponderMove(touch, { dx: 160, dy: 0 });
    handlers.onPanResponderRelease();
    assert.equal(previews.length, beforeResize, 'cancelled touch must not create another draft');
    assert.deepEqual(commits, []);
    assert.equal(cancels, 1);
    fixture.unmount();
  });
}

test('zoom invalidates an active gesture through the same geometry lifecycle', () => {
  const fixture = harness();
  const changes = [];
  const handlers = fixture.useTimelineTimingPanHandlers({
    startMs: 1_000, endMs: 2_000, durationMs: 5_000, trackWidth: 1_000,
    onPress() {}, onChangeStart() {}, onChange(...args) { changes.push(args); }, onEnd() {},
  }, 'move');
  handlers.onPanResponderGrant();
  handlers.onPanResponderMove(touch, { dx: 60, dy: 0 });
  fixture.geometry.update({ scale: 24 });
  handlers.onPanResponderMove(touch, { dx: 120, dy: 0 });
  handlers.onPanResponderRelease();
  assert.equal(changes.length, 1);
  fixture.unmount();
});
