import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import * as geometry from '../src/lib/keyboard-viewport.ts';

const source = stripTypeScriptTypes(readFileSync(new URL('../src/hooks/use-keyboard-viewport.ts', import.meta.url), 'utf8'))
  .replace(/^import .*;$/gm, '').replace('export function', 'function');
const load = new Function('dependencies', 'const { useCallback, useEffect, useMemo, useRef, useState, Keyboard, Platform, useWindowDimensions, keyboardViewportOverlap, keyboardViewportCoversBottom } = dependencies;\n' + source + '\nreturn useKeyboardViewport;');
function mount({ visible = false, metrics, platform = 'android' } = {}) {
  const slots = [], effects = [], callbacks = [], listeners = new Map();
  let cursor = 0, writes = 0;
  const window = { width: 890, height: 400, fontScale: 1 };
  const slot = initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [i, slots[i]]; };
  const hook = load({
    useRef: initial => slot(() => ({ current: initial }))[1],
    useState: initial => { const [i, value] = slot(initial); return [value, next => { writes++; slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
    useCallback: callback => { const [, value] = slot(() => callback); return value; },
    useMemo(factory, deps) {
      const [i, old] = slot(undefined);
      if (!old || deps.some((v, n) => !Object.is(v, old.deps[n]))) slots[i] = { deps, value: factory() };
      return slots[i].value;
    },
    useEffect(callback, deps) {
      const [i, old] = slot(undefined);
      if (!old || deps.some((v, n) => !Object.is(v, old.deps[n]))) {
        effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: callback() }; });
      }
    },
    useWindowDimensions: () => window, Platform: { OS: platform },
    Keyboard: {
      isVisible: () => visible, metrics: () => metrics,
      addListener(name, callback) { listeners.set(name, callback); return { remove: () => listeners.delete(name) }; },
    },
    ...geometry,
  });
  const native = { measureInWindow: callback => callbacks.push(callback) };
  const render = (enabled = true) => { cursor = 0; const value = hook(enabled); value.attachFrame(native); return value; };
  const flush = () => { while (effects.length) effects.shift()(); };
  const measure = (frame, index = callbacks.length - 1) => callbacks[index](frame.x, frame.y, frame.width, frame.height);
  render(); flush();
  return { render, flush, measure, callbacks, listeners, window, get writes() { return writes; },
    show(frame) { visible = true; metrics = frame; listeners.get('keyboardDidShow')({ endCoordinates: frame }); },
    hide() { visible = false; listeners.get('keyboardDidHide')(); },
    dispose() { for (const slot of slots) slot?.cleanup?.(); },
  };
}
const full = { x: 20, y: 30, width: 760, height: 360 };
const keyboard = { screenX: 0, screenY: 180, width: 800, height: 220 };

test('actual hook excludes overlap, then recovers all space on dismissal', () => {
  const h = mount(); h.measure(full); h.show(keyboard);
  assert.equal(h.render().bottomOverlap, 210);
  h.measure({ ...full, height: 150 }); assert.equal(h.render().bottomOverlap, 0);
  h.hide(); assert.equal(h.render().bottomOverlap, 0);
  assert.equal(h.listeners.size, 2); h.dispose(); assert.equal(h.listeners.size, 0);
});
test('a viewport opened while the keyboard is already visible measures its current frame', () => {
  const h = mount({ visible: true, metrics: keyboard }); h.measure(full);
  assert.equal(h.render().bottomOverlap, 210);
});
test('out-of-order callbacks cannot restore obsolete bounds', () => {
  const h = mount(); h.measure(full); h.show(keyboard);
  const old = h.callbacks.length - 1; h.render().onLayout();
  h.measure({ ...full, height: 150 }); h.measure(full, old);
  assert.equal(h.render().bottomOverlap, 0);
});
test('rotation rejects pending measurements and keeps one listener per event', () => {
  const h = mount({ visible: true, metrics: keyboard });
  const old = h.callbacks.length - 1;
  h.window.width = 400; h.window.height = 890; h.render(); h.flush();
  h.measure(full, old); assert.equal(h.render().bottomOverlap, 0);
  h.measure({ x: 0, y: 80, width: 400, height: 810 });
  assert.equal(h.render().bottomOverlap, 710); assert.equal(h.listeners.size, 2);
});
test('unmount rejects native callbacks without writing state', () => {
  const h = mount(); const old = h.callbacks.length - 1; h.dispose();
  const writes = h.writes; h.measure(full, old); assert.equal(h.writes, writes);
});
test('disabled and iOS viewports leave avoidance to the existing native behavior', () => {
  const ios = mount({ platform: 'ios', visible: true, metrics: keyboard });
  assert.equal(ios.listeners.size, 0); assert.equal(ios.render().bottomOverlap, 0);
  const android = mount(); android.render(false); android.flush();
  assert.equal(android.listeners.size, 0); assert.equal(android.render(false).bottomOverlap, 0);
});
