import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = stripTypeScriptTypes(readFileSync(new URL('../src/hooks/use-focused-input-reveal.ts', import.meta.url), 'utf8'));
const registryKey = Symbol.for('caption-studio-input-reveal-hook-tests');
const registry = globalThis[registryKey] ??= new Map();
let nextHarness = 0;
const dataModule = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');

async function mount(initialCommand) {
  const slots = [], effects = [], frames = new Map();
  let cursor = 0, nextFrame = 0, command = initialCommand;
  const same = (a, b) => a?.length === b?.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }];
    },
    useMemo(factory, deps) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { deps, value: factory() };
      return slots[index].value;
    },
    useLayoutEffect(callback, deps) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) {
        effects.push(() => { slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: callback() }; });
      }
    },
  };
  const id = ++nextHarness;
  registry.set(id, {
    react,
    requestFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelFrame(frame) { frames.delete(frame); },
  });
  const shared = 'const h = globalThis[Symbol.for("caption-studio-input-reveal-hook-tests")].get(' + id + ');';
  const reactModule = dataModule(shared + '\nexport const { useState, useMemo, useLayoutEffect } = h.react;');
  const runtimeModule = dataModule(shared + '\nexport const requestAnimationFrame = h.requestFrame; export const cancelAnimationFrame = h.cancelFrame;');
  const moduleSource = source
    .replace("'react'", JSON.stringify(reactModule))
    .replace("'@/lib/input-viewport'", JSON.stringify(new URL('../src/lib/input-viewport.ts', import.meta.url).href));
  let module;
  try {
    module = await import(dataModule('import { requestAnimationFrame, cancelAnimationFrame } from ' + JSON.stringify(runtimeModule) + ';\n' + moduleSource));
  } finally {
    registry.delete(id);
  }
  let result;
  const render = () => { cursor = 0; result = module.useFocusedInputReveal(command); return result; };
  const commit = () => { while (effects.length) effects.shift()(); };
  const flush = () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } };
  render();
  return { get result() { return result; }, frames, render, commit, flush,
    update(next) { command = next; render(); commit(); },
    dispose() { slots.forEach(slot => slot.cleanup?.()); frames.clear(); },
  };
}

const viewport = { measureInWindow(callback) { callback(0, 100, 400, 60); } };
const field = { measureInWindow(callback) { callback(0, 180, 100, 44); } };

test('the real hook returns its native callback separately from stable non-ref controls', async () => {
  const h = await mount(() => {});
  assert.ok(Array.isArray(h.result), 'native ref must not share the controls object');
  const [ref, controls] = h.result;
  assert.equal(typeof ref, 'function');
  assert.equal(Object.hasOwn(controls, 'viewportRef'), false);
  h.render();
  assert.equal(h.result[0], ref);
  assert.equal(h.result[1], controls);
  h.dispose();
});

test('mount connects scrolling after commit without dropping a field focused during native attachment', async () => {
  const moves = [], h = await mount(offset => moves.push(offset));
  const [ref, controls] = h.result;
  ref(viewport); controls.focus(field);
  assert.equal(h.frames.size, 0);
  h.commit(); h.flush();
  assert.deepEqual(moves, [64]);
  h.dispose();
});

test('changing the committed scrolling command preserves focus and invalidates pending measurements', async () => {
  const oldMoves = [], newMoves = [], measurements = [];
  const h = await mount(offset => oldMoves.push(offset));
  const [ref, controls] = h.result;
  ref(viewport); h.commit();
  controls.focus({ measureInWindow(callback) { measurements.push(callback); } });
  h.flush();
  h.update(offset => newMoves.push(offset));
  measurements[0](0, 180, 100, 44);
  assert.deepEqual(oldMoves, []); assert.deepEqual(newMoves, []);
  h.flush(); measurements[1](0, 180, 100, 44);
  assert.deepEqual(newMoves, [64]);
  assert.equal(h.result[1], controls);
  h.dispose();
});

test('reflow uses the new committed view without resetting the current scroll offset', async () => {
  const moves = [], h = await mount(offset => moves.push(offset));
  const [ref, controls] = h.result;
  ref(viewport); h.commit();
  controls.onScroll({ nativeEvent: { contentOffset: { y: 100 } } });
  controls.focus(field); h.flush();
  assert.deepEqual(moves, [164]);
  ref({ measureInWindow(callback) { callback(0, 180, 400, 60); } });
  h.flush();
  assert.deepEqual(moves, [164]);
  assert.equal(h.result[1], controls);
  h.dispose();
});

test('actual layout-effect cleanup rejects native measurements after unmount', async () => {
  const moves = [], measurements = [], h = await mount(offset => moves.push(offset));
  const [ref, controls] = h.result;
  ref(viewport); h.commit();
  controls.focus({ measureInWindow(callback) { measurements.push(callback); } });
  h.flush();
  h.dispose();
  measurements[0](0, 180, 100, 44);
  h.flush();
  assert.deepEqual(moves, []);
});
