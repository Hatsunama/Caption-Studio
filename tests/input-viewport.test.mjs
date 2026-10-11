import assert from 'node:assert/strict';
import test from 'node:test';

let inputScrollOffset;
try {
  ({ inputScrollOffset } = await import('../src/lib/input-viewport.ts'));
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  inputScrollOffset = (_field, _viewport, offset) => offset;
}

const viewport = { y: 100, height: 60 };

test('reveals the focused field after the keyboard reduces the native viewport', () => {
  assert.equal(inputScrollOffset({ y: 180, height: 44 }, viewport, 20), 84);
});
test('reveals an earlier field without assuming the scroll starts at zero', () => {
  assert.equal(inputScrollOffset({ y: 70, height: 44 }, viewport, 80), 50);
});
test('does not move a fully visible field', () => {
  assert.equal(inputScrollOffset({ y: 108, height: 44 }, viewport, 30), 30);
});
test('keeps the start of a tall input accessible instead of jumping to its end', () => {
  assert.equal(inputScrollOffset({ y: 130, height: 120 }, viewport, 10), 40);
});
test('clamps scrolling at the beginning of the content', () => {
  assert.equal(inputScrollOffset({ y: 50, height: 44 }, viewport, 10), 0);
});
test('ignores incomplete or nonfinite native measurements', () => {
  for (const field of [{ y: NaN, height: 44 }, { y: 180, height: 0 }, { y: 180, height: Infinity }]) {
    assert.equal(inputScrollOffset(field, viewport, 10), 10);
  }
  assert.equal(inputScrollOffset({ y: 180, height: 44 }, { y: 100, height: 0 }, 10), 10);
});
