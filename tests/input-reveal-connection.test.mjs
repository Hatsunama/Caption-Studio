import assert from 'node:assert/strict';
import test from 'node:test';
import * as inputViewport from '../src/lib/input-viewport.ts';

function harness() {
  const frames = new Map();
  let id = 0;
  const connection = inputViewport.createInputRevealConnection({
    requestFrame(callback) { frames.set(++id, callback); return id; },
    cancelFrame(frame) { frames.delete(frame); },
  });
  const moves = [];
  const viewport = { measureInWindow(callback) { callback(0, 100, 400, 60); } };
  const field = { measureInWindow(callback) { callback(0, 180, 100, 44); } };
  const flush = () => {
    for (const [frame, callback] of [...frames]) { frames.delete(frame); callback(); }
  };
  return { connection, frames, moves, viewport, field, flush };
}

test('construction and focus do not measure native views before commit connections exist', () => {
  const h = harness();
  let measurements = 0;
  h.connection.focus({ measureInWindow() { measurements++; } });
  h.flush();
  assert.equal(measurements, 0);
  assert.equal(h.frames.size, 0);
});

test('the view and scrolling command must both be connected before revealing a field', () => {
  const h = harness();
  h.connection.focus(h.field);
  h.connection.connectViewport(h.viewport);
  assert.equal(h.frames.size, 0);
  h.connection.connectScrollToOffset(offset => h.moves.push(offset));
  h.flush();
  assert.deepEqual(h.moves, [64]);
});

test('replacing the native viewport rejects measurements belonging to the previous view', () => {
  const h = harness();
  const measurements = [];
  let oldViewportReads = 0;
  h.connection.connectViewport({ measureInWindow() { oldViewportReads++; } });
  h.connection.connectScrollToOffset(offset => h.moves.push(offset));
  h.connection.focus({ measureInWindow(callback) { measurements.push(callback); } });
  h.flush();
  h.connection.connectViewport({ measureInWindow(callback) { callback(0, 80, 400, 60); } });
  measurements[0](0, 180, 100, 44);
  assert.equal(oldViewportReads, 0);
  assert.deepEqual(h.moves, []);
  h.flush();
  measurements[1](0, 180, 100, 44);
  assert.deepEqual(h.moves, [84]);
});

test('replacing the scrolling command rejects a pending result for its former owner', () => {
  const h = harness();
  const measurements = [], oldMoves = [];
  h.connection.connectViewport(h.viewport);
  h.connection.connectScrollToOffset(offset => oldMoves.push(offset));
  h.connection.focus({ measureInWindow(callback) { measurements.push(callback); } });
  h.flush();
  h.connection.connectScrollToOffset(offset => h.moves.push(offset));
  measurements[0](0, 180, 100, 44);
  assert.deepEqual(oldMoves, []);
  assert.deepEqual(h.moves, []);
  h.flush();
  measurements[1](0, 180, 100, 44);
  assert.deepEqual(h.moves, [64]);
});

test('disconnecting a command cancels work and reconnection reveals the still-focused field', () => {
  const h = harness();
  h.connection.connectViewport(h.viewport);
  h.connection.connectScrollToOffset(offset => h.moves.push(offset));
  h.connection.focus(h.field);
  h.connection.connectScrollToOffset(undefined);
  h.flush();
  assert.deepEqual(h.moves, []);
  h.connection.connectScrollToOffset(offset => h.moves.push(offset));
  h.flush();
  assert.deepEqual(h.moves, [64]);
});

test('native ref detachment and unmount prevent late callbacks from moving a replacement view', () => {
  const h = harness();
  const measurements = [];
  h.connection.connectViewport(h.viewport);
  h.connection.connectScrollToOffset(offset => h.moves.push(offset));
  h.connection.focus({ measureInWindow(callback) { measurements.push(callback); } });
  h.flush();
  h.connection.connectViewport(null);
  h.connection.detach();
  measurements[0](0, 180, 100, 44);
  h.flush();
  assert.deepEqual(h.moves, []);
  h.connection.attach();
  h.connection.connectViewport(h.viewport);
  h.flush();
  assert.deepEqual(h.moves, []);
  h.connection.focus(h.field);
  h.flush();
  assert.deepEqual(h.moves, [64]);
});

test('committed scrolling retains the actual offset rather than resetting after a callback update', () => {
  const h = harness();
  h.connection.connectViewport(h.viewport);
  h.connection.connectScrollToOffset(offset => h.moves.push(offset));
  h.connection.recordScroll(100);
  h.connection.focus(h.field);
  h.flush();
  assert.deepEqual(h.moves, [164]);
});
