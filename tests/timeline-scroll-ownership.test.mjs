import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Exercise the actual exported factory. These call-contract doubles do not
// establish native arbitration, touch delivery, or scrolling physics.
function host(os) {
  const created = [], calls = [];
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(
    '../src/components/editor/timeline-native-gesture.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const Native = () => {
    const gesture = new Proxy({}, {
      get: (_, method) => (...args) => {
        calls.push({ gesture, method, args });
        return gesture;
      },
      set: (_, property) => { assert.fail(`unexpected Native property write: ${String(property)}`); },
    });
    created.push(gesture);
    return gesture;
  };
  runInNewContext(code, { exports, require(id) {
    if (id === 'react') return { createContext: value => ({ value }) };
    if (id === 'react/jsx-runtime') return {};
    if (id === 'react-native') return { Platform: { OS: os } };
    if (id === 'react-native-gesture-handler') return {
      Gesture: new Proxy({ Native }, { get(target, name) {
        assert.equal(name, 'Native', 'factory must create only Native handlers');
        return target[name];
      } }),
    };
    if (['react-native-reanimated', 'react-native-worklets', './timeline-native-pan',
      '@/components/spring-scroll-view'].includes(id)) return {};
    throw new Error(`unexpected import: ${id}`);
  } }, { filename: 'timeline-native-gesture.tsx' });
  return { ...exports, created, calls };
}

test('Android gives each of three owned Native scroll handlers the standard RNGH ScrollView preset only', () => {
  const h = host('android');
  const owners = h.createTimelineNativeScrollGestures();
  assert.equal(owners.length, 3, 'horizontal, vertical, and labels each need an owner');
  assert.equal(new Set(owners).size, 3, 'owners must be distinct');
  assert.deepEqual(Array.from(owners), h.created, 'return the actual Native owners in creation order');
  assert.equal(h.calls.length, 6, 'exactly two preset calls per owner; no activation, wait-for, or simultaneity calls');
  for (const owner of owners) {
    const calls = h.calls.filter(call => call.gesture === owner);
    assert.deepEqual(calls.map(({ method, args }) => [method, args]), [
      ['disallowInterruption', [true]],
      ['shouldCancelWhenOutside', [false]],
    ], 'match the standard Native preset without adding relations or activation settings');
  }
});

for (const os of ['ios', 'web']) test(`${os} returns no owners and creates/configures no handlers`, () => {
  const h = host(os);
  assert.deepEqual(Array.from(h.createTimelineNativeScrollGestures()), []);
  assert.deepEqual(h.created, []);
  assert.deepEqual(h.calls, []);
});
