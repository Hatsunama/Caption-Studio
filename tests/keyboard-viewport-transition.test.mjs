import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { keyboardViewportOverlap } from '../src/lib/keyboard-viewport.ts';

const source = stripTypeScriptTypes(readFileSync(new URL('../src/hooks/use-keyboard-viewport.ts', import.meta.url), 'utf8'))
  .replace(/^import .*;$/gm, '').replace('export function', 'function');
const loadHook = new Function('dependencies', 'const { useCallback, useEffect, useRef, useState, Keyboard, Platform, useWindowDimensions, keyboardViewportOverlap } = dependencies;\n'
  + source + '\nreturn useKeyboardViewport;');

function mount({ visible = true, platform = 'android' } = {}) {
  const slots = [], effects = [], measurements = [], listeners = new Map();
  let cursor = 0, writes = 0, attached;
  let keyboard = { screenX: 0, screenY: 180, width: 800, height: 220 };
  const window = { width: 890, height: 400, fontScale: 1 };
  const slot = initial => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [index, slots[index]];
  };
  const hook = loadHook({
    useRef: initial => slot(() => ({ current: initial }))[1],
    useState: initial => {
      const [index, value] = slot(initial);
      return [value, next => {
        writes++;
        slots[index] = typeof next === 'function' ? next(slots[index]) : next;
      }];
    },
    useCallback: callback => slot(() => callback)[1],
    useEffect(callback, dependencies) {
      const [index, old] = slot(undefined);
      if (!old || dependencies.some((value, i) => !Object.is(value, old.dependencies[i]))) {
        effects.push(() => {
          old?.cleanup?.();
          slots[index] = { dependencies, cleanup: callback() };
        });
      }
    },
    useWindowDimensions: () => window,
    Platform: { OS: platform },
    Keyboard: {
      isVisible: () => visible,
      metrics: () => visible ? keyboard : undefined,
      addListener(name, callback) {
        const registrations = listeners.get(name) ?? new Set();
        registrations.add(callback);
        listeners.set(name, registrations);
        return { remove() {
          registrations.delete(callback);
          if (!registrations.size) listeners.delete(name);
        } };
      },
    },
    keyboardViewportOverlap,
  });
  const native = { measureInWindow: callback => measurements.push(callback) };
  const render = (enabled = true) => {
    cursor = 0;
    const value = hook(enabled);
    if (typeof value.attachFrame === 'function') {
      if (attached !== value.attachFrame) {
        attached?.(null);
        value.attachFrame(native);
        attached = value.attachFrame;
      }
    } else value.frameRef.current = native;
    return value;
  };
  const flush = () => { while (effects.length) effects.shift()(); };
  const measure = (frame, index = measurements.length - 1) =>
    measurements[index](frame.x, frame.y, frame.width, frame.height);
  const emit = (name, frame = keyboard) => {
    if (name === 'keyboardDidHide') visible = false;
    else { visible = true; keyboard = frame; }
    for (const callback of [...(listeners.get(name) ?? [])]) callback({ endCoordinates: frame });
  };
  const dispose = () => {
    attached?.(null);
    for (const value of slots) value?.cleanup?.();
  };
  render(); flush();
  return { render, flush, measure, measurements, listeners, window, emit, dispose,
    get writes() { return writes; } };
}
const full = { x: 20, y: 30, width: 760, height: 360 };

test('rotation retains measured keyboard protection until replacement measurement arrives', () => {
  const h = mount(); h.measure(full);
  assert.equal(h.render().bottomOverlap, 210);
  h.window.width = 400; h.window.height = 890;
  h.render(); h.flush();
  assert.equal(h.render().bottomOverlap, 210, 'remeasurement must not expose covered content');
  h.measure({ x: 0, y: 80, width: 400, height: 810 });
  assert.equal(h.render().bottomOverlap, 710);
  h.dispose();
});
test('disabling avoidance stops reserving space before passive effects run', () => {
  const h = mount(); h.measure(full);
  assert.equal(h.render(false).bottomOverlap, 0);
  h.flush(); h.dispose();
});
test('obsolete subscription cannot clear the new generation keyboard reservation', () => {
  const h = mount(); h.measure(full);
  const oldHide = [...h.listeners.get('keyboardDidHide')][0];
  h.window.width = 400; h.window.height = 890;
  h.render(); h.flush(); h.measure({ x: 0, y: 80, width: 400, height: 810 });
  const writes = h.writes; oldHide();
  assert.equal(h.writes, writes);
  assert.equal(h.render().bottomOverlap, 710);
  h.dispose();
});
test('obsolete keyboard callback after unmount cannot mutate state', () => {
  const h = mount(); h.measure(full);
  const oldShow = [...h.listeners.get('keyboardDidShow')][0];
  h.dispose(); const writes = h.writes;
  oldShow({ endCoordinates: { screenX: 0, screenY: 100, width: 800, height: 300 } });
  assert.equal(h.writes, writes);
});
test('only callback attachment is exposed and replacement views invalidate pending measurements', () => {
  const h = mount(); h.measure(full);
  const value = h.render();
  assert.equal(typeof value.attachFrame, 'function');
  assert.equal(value.frameRef, undefined);
  value.onLayout(); const stale = h.measurements.length - 1;
  value.attachFrame({ measureInWindow: callback => h.measurements.push(callback) });
  h.measure({ ...full, height: 150 });
  h.measure(full, stale);
  assert.equal(h.render().bottomOverlap, 0);
  h.dispose();
});
test('an unmeasurable native frame cannot erase the last valid keyboard reservation', () => {
  const h = mount(); h.measure(full); h.render().onLayout();
  h.measure({ x: 0, y: 0, width: 0, height: 0 });
  assert.equal(h.render().bottomOverlap, 210);
  h.dispose();
});
test('Android registers only supported keyboard events and height changes use DidShow', () => {
  const h = mount(); h.measure(full);
  assert.deepEqual([...h.listeners.keys()].sort(), ['keyboardDidHide', 'keyboardDidShow']);
  h.emit('keyboardDidShow', { screenX: 0, screenY: 100, width: 800, height: 300 });
  assert.equal(h.render().bottomOverlap, 290);
  h.emit('keyboardDidHide'); assert.equal(h.render().bottomOverlap, 0);
  h.dispose(); assert.equal(h.listeners.size, 0);
});
test('pending reservations are bounded after a shorter window replaces the measured frame', () => {
  const h = mount(); h.measure(full);
  h.window.height = 120; h.render(); h.flush();
  assert.ok(h.render().bottomOverlap > 0);
  assert.ok(h.render().bottomOverlap <= 120);
  h.dispose();
});
