import assert from 'node:assert/strict';
import test from 'node:test';
import { createInputRevealController } from '../src/lib/input-viewport.ts';

function harness() {
  const frames = new Map(), inputReads = [], viewportReads = [], scrolls = [];
  let id = 0;
  let viewport = { measureInWindow: callback => viewportReads.push(callback) };
  const input = { measureInWindow: callback => inputReads.push(callback) };
  const controller = createInputRevealController({
    viewport: () => viewport, scrollToOffset: value => scrolls.push(value),
    requestFrame: callback => { frames.set(++id, callback); return id; },
    cancelFrame: id => frames.delete(id),
  });
  return { controller, input, inputReads, viewportReads, scrolls,
    frame() { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); },
    replaceViewport() { viewport = { measureInWindow: callback => viewportReads.push(callback) }; },
    finish() { inputReads.shift()(0, 180, 120, 44); viewportReads.shift()?.(0, 100, 200, 60); },
  };
}
test('a measured keyboard resize reveals the same input without resetting its value', () => {
  const h = harness(); h.controller.recordScroll(20); h.controller.focus(h.input); h.frame(); h.finish();
  assert.deepEqual(h.scrolls, [84]);
});
for (const stop of ['detach', 'beginDrag']) {
  test(stop + ' revokes an in-flight native measurement', () => {
    const h = harness(); h.controller.focus(h.input); h.frame(); h.controller[stop](); h.finish();
    assert.deepEqual(h.scrolls, []);
  });
}
test('native results from a replaced viewport cannot move the new list', () => {
  const h = harness(); h.controller.focus(h.input); h.frame(); h.replaceViewport(); h.finish();
  assert.deepEqual(h.scrolls, []);
});
test('changing focus revokes both stages of the old measurement', () => {
  const h = harness(); h.controller.focus(h.input); h.frame();
  h.inputReads.shift()(0, 180, 120, 44);
  h.controller.focus({ measureInWindow() {} });
  h.viewportReads.shift()(0, 100, 200, 60);
  assert.deepEqual(h.scrolls, []);
});
test('blur of an earlier field cannot clear the current field', () => {
  const h = harness(); h.controller.focus(h.input); h.controller.blur({ measureInWindow() {} });
  h.frame(); h.finish(); assert.deepEqual(h.scrolls, [64]);
});
test('reattaching after effect cleanup does not revive old measurements', () => {
  const h = harness(); h.controller.focus(h.input); h.frame();
  h.controller.detach(); h.controller.attach(); h.finish(); assert.deepEqual(h.scrolls, []);
  h.controller.focus(h.input); h.frame(); h.finish(); assert.deepEqual(h.scrolls, [64]);
});
test('reflow coalesces pending reveal frames instead of scheduling duplicate scrolls', () => {
  const h = harness(); h.controller.focus(h.input); h.controller.reveal(); h.controller.reveal();
  h.frame(); assert.equal(h.inputReads.length, 1); h.finish(); assert.deepEqual(h.scrolls, [64]);
});
