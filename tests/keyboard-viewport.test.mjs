import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
const url = new URL('../src/lib/keyboard-viewport.ts', import.meta.url);
const policy = existsSync(url) ? await import(url) : undefined;
const overlap = (frame, keyboard) => policy?.keyboardViewportOverlap(frame, keyboard) ?? 0;
test('Seeker edge-to-edge landscape excludes the keyboard-covered screen region', () => {
  assert.equal(overlap({ x: 78, y: 110, width: 2556, height: 1018 },
    { screenX: 78, screenY: 430, width: 2556, height: 698 }), 698);
});
test('Samsung edge-to-edge landscape excludes the keyboard-covered screen region', () => {
  assert.equal(overlap({ x: 103, y: 90, width: 2057, height: 990 },
    { screenX: 103, screenY: 490, width: 2057, height: 590 }), 590);
});
test('a native-resized root is not reduced a second time', () => {
  assert.equal(overlap({ x: 78, y: 110, width: 2556, height: 320 },
    { screenX: 78, screenY: 430, width: 2556, height: 698 }), 0);
});
test('a partially resized root reserves only its remaining overlap', () => {
  assert.equal(overlap({ x: 0, y: 80, width: 400, height: 400 },
    { screenX: 0, screenY: 430, width: 400, height: 300 }), 50);
});
test('closed, detached and invalid keyboard frames do not alter layout', () => {
  const frame = { x: 20, y: 50, width: 350, height: 700 };
  for (const keyboard of [undefined, { screenX: 500, screenY: 400, width: 300, height: 300 },
    { screenX: 0, screenY: 800, width: 400, height: 100 },
    { screenX: 0, screenY: NaN, width: 400, height: 300 },
    { screenX: 0, screenY: 400, width: 0, height: 300 }]) assert.equal(overlap(frame, keyboard), 0);
});
test('nested windows use screen coordinates rather than subtracting the full keyboard height', () => {
  assert.equal(overlap({ x: 20, y: 100, width: 360, height: 500 },
    { screenX: 0, screenY: 550, width: 400, height: 300 }), 50);
});
