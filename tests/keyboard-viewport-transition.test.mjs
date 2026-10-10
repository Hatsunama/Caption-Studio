import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import * as geometry from '../src/lib/keyboard-viewport.ts';

const source = stripTypeScriptTypes(readFileSync(new URL('../src/hooks/use-keyboard-viewport.ts', import.meta.url), 'utf8'))
  .replace(/^import .*;$/gm, '').replace('export function', 'function');
const loadHook = new Function('dependencies', 'const { useCallback, useEffect, useMemo, useRef, useState, Keyboard, Platform, useWindowDimensions, keyboardViewportOverlap, keyboardViewportCoversBottom } = dependencies;\n'
  + source + '\nreturn useKeyboardViewport;');

function mount({ visible = true, platform = 'android', missingMetrics = false } = {}) {
  const slots = [], effects = [], measurements = [], listeners = new Map();
  let cursor = 0, writes = 0, effectWrites = 0, inEffect = false, attached;
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
        if (inEffect) effectWrites++;
        slots[index] = typeof next === 'function' ? next(slots[index]) : next;
      }];
    },
    useCallback: callback => slot(() => callback)[1],
    useMemo(factory, deps) {
      const [i, old] = slot(undefined);
      if (!old || deps.some((v, n) => !Object.is(v, old.deps[n]))) slots[i] = { deps, value: factory() };
      return slots[i].value;
    },
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
    Platform: { get OS() { return platform; } },
    Keyboard: {
      isVisible: () => visible,
      metrics: () => visible && !missingMetrics ? keyboard : undefined,
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
    ...geometry,
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
  const flush = () => {
    while (effects.length) {
      inEffect = true;
      try { effects.shift()(); } finally { inEffect = false; }
    }
  };
  const measure = (frame, index = measurements.length - 1) =>
    measurements[index](frame.x, frame.y, frame.width, frame.height);
  const emit = (name, frame = keyboard) => {
    if (name === 'keyboardDidHide') visible = false;
    else { visible = true; missingMetrics = false; keyboard = frame; }
    for (const callback of [...(listeners.get(name) ?? [])]) callback({ endCoordinates: frame });
  };
  const dispose = () => {
    attached?.(null);
    for (const value of slots) value?.cleanup?.();
  };
  render(); flush();
  return { render, flush, measure, measurements, listeners, window, emit, dispose,
    setPlatform(value) { platform = value; },
    get writes() { return writes; }, get effectWrites() { return effectWrites; } };
}
const full = { x: 20, y: 30, width: 760, height: 360 };

test('bottom inset coverage follows measured show, resized adjacency, floating frames and hide', () => {
  const h = mount({ visible: false });
  assert.equal(h.render().bottomInsetCovered, false);
  h.emit('keyboardDidShow');
  assert.equal(h.render().bottomInsetCovered, false, 'Visibility alone cannot remove the inset');
  h.measure(full);
  assert.equal(h.render().bottomInsetCovered, true);
  h.render().onLayout(); h.measure({ ...full, height: 150 });
  assert.equal(h.render().bottomOverlap, 0);
  assert.equal(h.render().bottomInsetCovered, true, 'Adjacent resized frame still covers the inset');
  h.emit('keyboardDidShow', { screenX: 0, screenY: 100, width: 800, height: 50 });
  assert.equal(h.render().bottomInsetCovered, false, 'Floating keyboard ends above frame bottom');
  h.emit('keyboardDidShow', { screenX: 0, screenY: 180, width: 800, height: 220 });
  assert.equal(h.render().bottomInsetCovered, true);
  const stale = h.measurements.length - 1;
  h.emit('keyboardDidHide');
  assert.equal(h.render().bottomInsetCovered, false);
  h.measure(full, stale);
  assert.equal(h.render().bottomInsetCovered, false);
  h.measure(full);
  assert.equal(h.render().bottomOverlap, 0);
  h.dispose();
});

test('rotation, invalid measurement, frame detach and replacement restore safe inset until recovery', () => {
  const h = mount(); h.measure(full);
  assert.equal(h.render().bottomInsetCovered, true);
  const oldShow = [...h.listeners.get('keyboardDidShow')][0];
  h.window.width = 800;
  assert.equal(h.render().bottomInsetCovered, false, 'Rotation is safe before passive effects');
  h.flush();
  oldShow({ endCoordinates: { screenX: 0, screenY: 0, width: 800, height: 400 } });
  assert.equal(h.render().bottomInsetCovered, false);
  h.measure(full); assert.equal(h.render().bottomInsetCovered, true);
  h.render().onLayout();
  assert.equal(h.render().bottomInsetCovered, false, 'Layout invalidates coverage while measuring');
  h.measure({ ...full, width: 0 });
  assert.equal(h.render().bottomInsetCovered, false);
  assert.equal(h.render().bottomOverlap, 210, 'Invalid measure retains existing overlap protection');
  h.emit('keyboardDidShow');
  assert.equal(h.render().bottomInsetCovered, false, 'Invalid frame cannot be reused');
  h.measure(full); assert.equal(h.render().bottomInsetCovered, true);
  const value = h.render(); value.onLayout();
  const stale = h.measurements.length - 1;
  value.attachFrame(null);
  assert.equal(h.render().bottomInsetCovered, false);
  h.measure(full, stale); assert.equal(h.render().bottomInsetCovered, false);
  value.attachFrame({ measureInWindow: callback => h.measurements.push(callback) });
  assert.equal(h.render().bottomInsetCovered, false);
  h.measure(full); assert.equal(h.render().bottomInsetCovered, true);
  h.dispose();
});

test('disable, reenable, missing metrics and iOS preserve normal inset safety', () => {
  const h = mount(); h.measure(full);
  assert.equal(h.render(false).bottomInsetCovered, false);
  h.flush();
  assert.equal(h.render().bottomInsetCovered, false, 'Reenable waits for current measurement');
  h.flush(); h.measure(full);
  assert.equal(h.render().bottomInsetCovered, true);
  h.dispose();
  const ios = mount({ platform: 'ios' });
  assert.equal(ios.render().bottomInsetCovered, false);
  assert.equal(ios.listeners.size, 0); ios.dispose();
  const missing = mount({ missingMetrics: true }); missing.measure(full);
  assert.equal(missing.render().bottomInsetCovered, false);
  assert.equal(missing.render().bottomOverlap, 0);
  missing.emit('keyboardDidShow');
  assert.equal(missing.render().bottomInsetCovered, true); missing.dispose();
});

test('pending or invalid layout still updates legacy overlap while refusing inset coverage', () => {
  const h = mount(); h.measure(full);
  h.render().onLayout();
  h.emit('keyboardDidShow', { screenX: 0, screenY: 100, width: 800, height: 300 });
  assert.equal(h.render().bottomOverlap, 290, 'Existing overlap uses the last frame during measurement');
  assert.equal(h.render().bottomInsetCovered, false);
  h.measure({ ...full, width: 0 });
  h.emit('keyboardDidShow', { screenX: 0, screenY: 180, width: 800, height: 220 });
  assert.equal(h.render().bottomOverlap, 210, 'Invalid measurement preserves the legacy frame for overlap');
  assert.equal(h.render().bottomInsetCovered, false);
  h.measure(full); assert.equal(h.render().bottomInsetCovered, true);
  h.dispose();
});

test('Android to iOS transition rejects canceled native work and recovers with one reservation', () => {
  const h = mount(); h.measure(full);
  const oldShow = [...h.listeners.get('keyboardDidShow')][0];
  const oldHide = [...h.listeners.get('keyboardDidHide')][0];
  const oldMeasure = h.measurements.length - 1;
  h.setPlatform('ios');
  assert.equal(h.render().bottomInsetCovered, false);
  assert.equal(h.render().bottomOverlap, 0);
  h.flush();
  const writes = h.writes;
  oldShow({ endCoordinates: { screenX: 0, screenY: 100, width: 800, height: 300 } });
  oldHide(); h.measure(full, oldMeasure);
  assert.equal(h.writes, writes); assert.equal(h.listeners.size, 0);
  h.setPlatform('android');
  assert.equal(h.render().bottomInsetCovered, false);
  h.flush(); h.measure(full);
  assert.equal(h.render().bottomInsetCovered, true);
  assert.equal(h.render().bottomOverlap, 210);
  assert.equal(h.listeners.size, 2); h.dispose();
});

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

test('subscription setup never publishes state before native geometry arrives', () => {
  const h = mount();
  assert.equal(h.effectWrites, 0, 'Initial subscription must not synchronously invalidate React state');
  h.measure(full);
  assert.equal(h.render().bottomInsetCovered, true);
  h.window.width = 400; h.window.height = 890;
  h.render(); h.flush();
  assert.equal(h.effectWrites, 0, 'Rotation subscriptions wait for native measurement');
  assert.equal(h.render().bottomInsetCovered, false);
  h.emit('keyboardDidShow', { screenX: 0, screenY: 600, width: 400, height: 300 });
  h.measure({ x: 0, y: 80, width: 400, height: 810 });
  assert.equal(h.render().bottomInsetCovered, true);
  h.render(false); h.flush();
  h.render(true); h.flush();
  assert.equal(h.effectWrites, 0, 'Reactivation subscriptions cannot cause a synchronous render cascade');
  assert.equal(h.render().bottomInsetCovered, false);
  h.measure({ x: 0, y: 80, width: 400, height: 810 });
  assert.equal(h.render().bottomInsetCovered, true);
  h.dispose();
});
