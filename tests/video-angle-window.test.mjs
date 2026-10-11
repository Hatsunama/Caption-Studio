import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = readFileSync(new URL('../src/components/editor/video-tools.tsx', import.meta.url), 'utf8');
const angle = source.slice(source.indexOf('function AngleScrubber('), source.indexOf('\nfunction ToolChip('));
const layoutBinding = angle.match(/\bonLayout=\{([\s\S]*?)\}\s+style=/);
assert.ok(layoutBinding, 'Execute the production onLayout binding');
// Node cannot strip JSX. Replace only the visual return with a harness return;
// all hooks, measurement callbacks, responders and angle math run unchanged.
const executable = angle.slice(0, angle.indexOf('  const percent ='))
  + `  return { trackRef, responder, onLayout: ${layoutBinding[1]} };\n}\n`
  + source.slice(source.indexOf('function normalizeDegrees('));
const createComponent = new Function('useRef', 'useMemo', 'useLayoutEffect', 'useWindowDimensions', 'PanResponder',
  stripTypeScriptTypes(executable) + '\nreturn AngleScrubber;');

function mount() {
  const hooks = [];
  let cursor = 0;
  let pending = [];
  let dimensions = { width: 800, height: 600, scale: 1, fontScale: 1 };
  let view;
  const measurements = [];
  const changes = [];
  let ends = 0;
  let responderCount = 0;
  let props = { value: 0, onChange: value => changes.push(value), onEnd: () => ends++ };
  const native = { measureInWindow: callback => measurements.push(callback) };
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const Component = createComponent(
    initial => {
      const index = cursor++;
      return hooks[index] ??= { current: initial };
    },
    (factory, deps) => {
      const index = cursor++;
      if (!sameDeps(hooks[index]?.deps, deps)) hooks[index] = { deps, value: factory() };
      return hooks[index].value;
    },
    (effect, deps) => {
      const index = cursor++;
      if (!sameDeps(hooks[index]?.deps, deps)) {
        const previous = hooks[index];
        hooks[index] = { deps, cleanup: previous?.cleanup };
        pending.push(() => {
          hooks[index].cleanup?.();
          hooks[index].cleanup = effect();
        });
      }
    },
    () => dimensions,
    { create: handlers => { responderCount++; return { panHandlers: handlers }; } },
  );
  const flush = () => { const effects = pending; pending = []; effects.forEach(effect => effect()); };
  const render = (nextDimensions = dimensions, nextProps = props) => {
    dimensions = nextDimensions;
    props = nextProps;
    cursor = 0;
    view = Component(props);
    view.trackRef.current = native;
  };
  render();
  flush();
  const event = pageX => ({ nativeEvent: { touches: [{ pageX }], changedTouches: [], pageX } });
  return {
    changes, measurements, render, flush,
    get ends() { return ends; },
    get responderCount() { return responderCount; },
    layout: width => view.onLayout({ nativeEvent: { layout: { width } } }),
    measure: (index, pageX, width) => measurements[index](pageX, 0, width, 64),
    latest: (pageX, width) => measurements.at(-1)(pageX, 0, width, 64),
    grant: pageX => view.responder.panHandlers.onPanResponderGrant(event(pageX)),
    move: pageX => view.responder.panHandlers.onPanResponderMove(event(pageX)),
    release: () => view.responder.panHandlers.onPanResponderRelease(),
    terminate: () => view.responder.panHandlers.onPanResponderTerminate(),
    resize: () => render({ ...dimensions, width: 600, height: 800 }),
    unmount: () => hooks.forEach(hook => hook.cleanup?.()),
  };
}

test('touches before any measurement cannot change the angle', () => {
  const h = mount();
  h.grant(100);
  h.move(120);
  assert.deepEqual(h.changes, []);
  h.release();
  assert.equal(h.ends, 1);
});

test('layout invalidates both coordinates until its measurement completes', () => {
  const h = mount();
  h.layout(200);
  h.latest(100, 200);
  h.grant(200);
  assert.deepEqual(h.changes, [0]);
  h.layout(400);
  h.move(200);
  assert.deepEqual(h.changes, [0]);
  h.latest(300, 400);
  assert.deepEqual(h.changes, [0], 'measurement must not replay a touch from the old frame');
  h.move(500);
  assert.deepEqual(h.changes, [0, 0]);
});

test('out-of-order measurement callbacks cannot restore an old frame', () => {
  const h = mount();
  h.layout(200);
  const old = h.measurements.length - 1;
  h.layout(400);
  h.latest(300, 400);
  h.measure(old, 100, 200);
  h.grant(500);
  assert.deepEqual(h.changes, [0]);
});

test('an obsolete callback cannot make a pending frame ready', () => {
  const h = mount();
  h.layout(200);
  const old = h.measurements.length - 1;
  h.layout(400);
  h.measure(old, 100, 200);
  h.grant(500);
  assert.deepEqual(h.changes, []);
  h.latest(300, 400);
  h.move(500);
  assert.deepEqual(h.changes, [0]);
});

test('resize during a drag invalidates before effects and resumes on a fresh touch', () => {
  const h = mount();
  h.layout(200);
  h.latest(100, 200);
  h.grant(200);
  h.resize();
  h.move(300);
  assert.deepEqual(h.changes, [0]);
  h.flush();
  h.move(300);
  assert.deepEqual(h.changes, [0]);
  h.latest(200, 400);
  assert.deepEqual(h.changes, [0]);
  h.move(400);
  assert.deepEqual(h.changes, [0, 0]);
  h.release();
  h.terminate();
  assert.equal(h.ends, 1);
  assert.equal(h.responderCount, 1, 'the cached production responder must stay current');
});

test('resize rejects pre-resize callbacks even before the effect runs', () => {
  const h = mount();
  h.layout(200);
  const old = h.measurements.length - 1;
  h.resize();
  h.measure(old, 100, 200);
  h.grant(200);
  assert.deepEqual(h.changes, []);
  h.flush();
  h.latest(300, 400);
  h.measure(old, 100, 200);
  h.move(500);
  assert.deepEqual(h.changes, [0]);
});

test('termination and release finish each gesture exactly once with current props', () => {
  const h = mount();
  h.layout(200);
  h.latest(100, 200);
  h.grant(200);
  const changes = [];
  let ends = 0;
  h.render(undefined, { value: 0, onChange: value => changes.push(value), onEnd: () => ends++ });
  h.flush();
  h.move(250);
  assert.deepEqual(changes, [90]);
  h.terminate();
  h.release();
  h.move(300);
  assert.deepEqual(changes, [90]);
  assert.equal(ends, 1);
  h.grant(200);
  h.release();
  assert.equal(ends, 2);
  assert.equal(h.ends, 0);
});

test('release during a pending resize does not receive a late angle change', () => {
  const h = mount();
  h.layout(200);
  h.latest(100, 200);
  h.grant(200);
  h.resize();
  h.flush();
  h.move(500);
  h.release();
  h.latest(300, 400);
  assert.deepEqual(h.changes, [0]);
  assert.equal(h.ends, 1);
});

test('zero or nonfinite native measurements remain unready', () => {
  for (const [pageX, width] of [[100, 0], [NaN, 200], [100, Infinity]]) {
    const h = mount();
    h.layout(200);
    h.latest(pageX, width);
    h.grant(200);
    assert.deepEqual(h.changes, []);
  }
});

test('unmount invalidates pending callbacks', () => {
  const h = mount();
  h.layout(200);
  h.unmount();
  h.latest(100, 200);
  h.grant(200);
  assert.deepEqual(h.changes, []);
});

test('measured angle mapping and clamps are unchanged', () => {
  const h = mount();
  h.layout(200);
  h.latest(100, 200);
  h.grant(100);
  for (const pageX of [150, 200, 250, 300, 0, 400]) h.move(pageX);
  assert.deepEqual(h.changes, [-180, -90, 0, 90, 180, -180, 180]);
  h.release();
  assert.equal(h.ends, 1);
});
