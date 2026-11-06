import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const root = fileURLToPath(new URL('../src/', import.meta.url));
const compiled = new Map();
function code(file) {
  const input = file === resolve(root, 'components/editor/layer-timeline.tsx') && process.env.TIMELINE_RECOVERY_BASELINE
    ? process.env.TIMELINE_RECOVERY_BASELINE : file;
  if (!compiled.has(file)) compiled.set(file, ts.transpileModule(readFileSync(input, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    fileName: file,
  }).outputText + (file === resolve(root, 'components/editor/layer-timeline.tsx')
    ? '\nexports.timingHookForTest = useTimelineTimingPanHandlers;' : ''));
  return compiled.get(file);
}

// Execute the whole LayerTimeline render, its real hooks/callbacks and the
// production command interceptor/controller. Only host layout/clamping and the
// hook scheduler are doubles: these schedules are contracts, not device traces.
function harness(initial = {}) {
  let cursor = 0, dirty = false, tree, effects = [], horizontal, outer, first = true;
  let scrubStarts = 0, timingStarts = 0, timingEnds = 0;
  let slots = [];
  const primarySlots = slots, childSlots = [], modules = new Map(), jobs = [], commands = [], seeks = [], changes = [];
  let geometry;
  const native = { viewport: 360, content: 638, x: 0, generation: 1 };
  let props = { projectId: 'saved', durationMs: 8000, currentMs: 8000,
    clips: [], sources: [], layers: [], captions: [], translationTracks: [], audioSources: [], audioClips: [],
    onSeek: ms => seeks.push(ms), onScrubStart: () => scrubStarts++,
    onTimingChangeStart: () => timingStarts++, onTimingChangeEnd: () => timingEnds++,
    onSelectAudioClip() {}, onItemTimingChange: (...args) => changes.push(args), ...initial };
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks = {
    Fragment: 'Fragment', createContext: value => ({ value, Provider: 'Provider' }), useContext: ctx => ctx.value,
    useState(initial) {
      const i = cursor++;
      const slot = slots[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slot.value, update => {
        const value = typeof update === 'function' ? update(slot.value) : update;
        if (!Object.is(slot.value, value)) { slot.value = value; dirty = true; }
      }];
    },
    useRef: value => hooks.useMemo(() => ({ current: value }), []),
    useMemo(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { value: fn(), deps };
      return slots[i].value;
    },
    useCallback: (fn, deps) => hooks.useMemo(() => fn, deps),
    useEffect(fn, deps) {
      const i = cursor++, store = slots;
      if (!store[i] || !same(store[i].deps, deps)) {
        const old = store[i]; store[i] = { deps };
        effects.push(() => { old?.cleanup?.(); store[i].cleanup = fn(); });
      }
    },
  };
  hooks.useLayoutEffect = hooks.useEffect;
  const jsx = (type, props) => ({ type, props });
  const shared = value => ({ value, modify(fn) { this.value = fn(this.value); } });
  const gesture = () => new Proxy({ handlers: { isWorklet: [] } }, {
    get(target, name, receiver) { return name in target ? target[name] : (...args) => {
      if (String(name).startsWith('on')) target.handlers[name] = args[0];
      return receiver;
    }; },
  });
  const reanimated = { useSharedValue: value => hooks.useMemo(() => shared(value), []),
    cancelAnimation() {}, dispatchCommand(_ref, name, args) {
      assert.equal(name, 'scrollTo'); assert.equal(args[2], false);
      commands.push(args[0]);
      native.x = Math.min(Math.max(0, args[0]), Math.max(0, native.content - native.viewport));
      jobs.push(() => horizontal.props.onScroll({ nativeEvent: { contentOffset: { x: native.x } } }));
    } };
  const worklets = { scheduleOnUI: (fn, ...args) => jobs.push(() => fn(...args)),
    scheduleOnRN: (fn, ...args) => jobs.push(() => fn(...args)) };
  const spring = { SpringScrollView: 'SpringScrollView', SpringScrollGestureContext: { value: [] } };
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    const exports = {}; modules.set(file, exports);
    runInNewContext(code(file), { exports, clearTimeout, setTimeout, clearInterval, setInterval,
      performance: { now: () => 1 }, require(id) {
        if (id === 'react') return hooks;
        if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx };
        if (id === 'react-native') return { View: 'View', Text: 'Text', Pressable: 'Pressable',
          Platform: { OS: 'android' }, PanResponder: { create: panHandlers => ({ panHandlers }) },
          PixelRatio: { roundToNearestPixel: x => x, get: () => 1 } };
        if (id === 'react-native-reanimated') return reanimated;
        if (id === 'react-native-worklets') return worklets;
        if (id === 'react-native-gesture-handler') return { Gesture: { Native: gesture, Pan: gesture }, GestureDetector: 'GestureDetector' };
        if (id === '@/components/spring-scroll-view') return spring;
        if (id === 'expo-image') return { Image: 'Image' };
        if (id.startsWith('@/services/')) return { timelineHaptic() {} };
        if (id === '@/lib/ui-theme') return { chrome: {} };
        const base = id.startsWith('@/') ? resolve(root, id.slice(2)) : resolve(dirname(file), id);
        if (base.endsWith('.json')) return JSON.parse(readFileSync(base, 'utf8'));
        const extension = ['.ts', '.tsx'].find(ext => {
          try { readFileSync(base + ext); return true; } catch (e) { if (e.code !== 'ENOENT') throw e; return false; }
        });
        assert.ok(extension, `unexpected import ${id}`);
        return load(base + extension);
      } }, { filename: file });
    return exports;
  }
  const { LayerTimeline, timingHookForTest } = load(resolve(root, 'components/editor/layer-timeline.tsx'));
  const { TimelineNativeScrollView, TimelineNativeGestureView, TimelineNativeGeometryContext } =
    load(resolve(root, 'components/editor/timeline-native-gesture.tsx'));
  const policy = load(resolve(root, 'lib/scroll-spring-policy.ts'));
  const { createScrollSpringController } = load(resolve(root, 'components/scroll-spring-controller.ts'));
  const { interceptSpringScrollCommands } = load(resolve(root, 'components/spring-scroll-gesture.ts'));
  const state = shared({ alive: false, epoch: 0, axis: policy.createScrollSpringAxisState() });
  const node = { scrollTo() { assert.fail('must use production generation guard'); }, scrollToEnd() {},
    getNativeScrollRef: () => node };
  const controller = createScrollSpringController({ state, owner: shared(0), offset: shared(0), id: 1,
    nativeOffset: shared(0), getAnimatedRef: () => () => node, getContentRef: () => () => ({}),
    presentationVersion: shared(0), gesture: gesture() });
  const restore = interceptSpringScrollCommands(node, () => node, () => native.generation, controller.command);
  controller.activate(1, true);
  function render() {
    slots = primarySlots; cursor = 0; dirty = false;
    tree = LayerTimeline(props);
    function walk(element) {
      if (!element?.props) return;
      if (element.type === TimelineNativeScrollView && element.props.horizontal) horizontal = TimelineNativeScrollView(element.props);
      if (element.type === 'View' && element.props.onStartShouldSetResponderCapture) outer = element;
      if (element.props.value?.subscribe) geometry = element.props.value;
      for (const child of [element.props.children].flat(Infinity)) walk(child);
    }
    walk(tree);
    assert.ok(horizontal); assert.ok(outer);
    horizontal.props.ref.current = node;
    if (first) { native.content = expectedContent(); first = false; }
    while (effects.length) effects.shift()();
  }
  function flush() {
    for (let i = 0; i < 40; i++) {
      while (jobs.length) jobs.shift()();
      if (!dirty) return;
      render();
    }
    assert.fail('render/command feedback loop');
  }
  function layout(width = native.viewport) {
    native.viewport = width;
    horizontal.props.onLayout?.({ nativeEvent: { layout: { width } } });
  }
  function content(width = expectedContent()) {
    native.content = width;
    horizontal.props.onContentSizeChange?.(width, 200);
  }
  function expectedContent() { return horizontal.props.contentContainerStyle.width; }
  render(); flush();
  return { native, commands, seeks, changes, flush, layout, content, expectedContent,
    get horizontal() { return horizontal.props; }, get outer() { return outer.props; },
    get props() { return props; },
    get scrubStarts() { return scrubStarts; },
    get timingStarts() { return timingStarts; },
    get timingEnds() { return timingEnds; },
    find(name) {
      let found;
      function walk(element) {
        if (!element?.props) return;
        if (element.type?.name === name) found = element.props;
        for (const child of [element.props.children].flat(Infinity)) walk(child);
      }
      walk(tree); assert.ok(found, name); return found;
    },
    mountItemPan(owner) {
      TimelineNativeGeometryContext.value = geometry;
      function mount(fn) {
        const store = []; childSlots.push(store); slots = store; cursor = 0;
        const result = fn();
        while (effects.length) effects.shift()();
        slots = primarySlots;
        return result;
      }
      const timing = mount(() => timingHookForTest(owner, 'end', owner.onTouchLock));
      const wrapper = mount(() => TimelineNativeGestureView({ nativeCallbacks: timing.nativeCallbacks, panHandlers: timing }));
      const pan = wrapper.props.gesture.handlers, calls = [];
      const manager = { activate: () => calls.push('activate'), fail: () => calls.push('fail') };
      const event = x => ({ numberOfTouches: 1, allTouches: [{ absoluteX: x, absoluteY: 10 }] });
      flush();
      return { calls,
        start() {
          pan.onTouchesDown(event(100), manager); pan.onTouchesMove(event(109), manager);
          pan.onStart({ absoluteX: 109, absoluteY: 10 }); flush();
        },
        cancel() { pan.onTouchesCancelled(event(109), manager); flush(); },
        up() { pan.onTouchesUp(event(109), manager); flush(); },
      };
    },
    resize(width) {
      native.viewport = width;
      native.x = Math.min(native.x, Math.max(0, native.content - width));
      outer.props.onLayout({ nativeEvent: { layout: { width } } }); render(); flush();
    },
    ready() { layout(); content(); flush(); },
    update(next) { props = { ...props, ...next }; render(); flush(); },
    rebind() { controller.deactivate(++native.generation); controller.activate(native.generation, true); native.x = 0; },
    rejectNextCommand() { jobs.push(() => controller.deactivate(++native.generation)); },
    activate() { controller.activate(native.generation, true); },
    close() { restore(); for (const store of [primarySlots, ...childSlots]) for (const slot of store) slot?.cleanup?.(); },
  };
}

function aligned(h) {
  // For these viewports the unchanged leading/trailing padding makes the
  // maximum scroll extent exactly the track width.
  const track = h.expectedContent() - h.native.viewport;
  assert.equal(h.native.x, Math.min(1, Math.max(0, h.props.currentMs / h.props.durationMs)) * track);
  assert.deepEqual(h.seeks, [], 'passive geometry must never change transport time');
}

for (const [durationMs, currentMs] of [[8000, 8000], [19000, 12345], [120000, 89000]]) {
  test(`late native content recovers ${currentMs}/${durationMs} after resize`, () => {
    const h = harness({ durationMs, currentMs }); h.ready(); aligned(h);
    h.resize(durationMs > 100000 ? 2500 : 800); h.layout(); h.flush();
    // Old content is nonzero: installed Android RN will not retain a pending
    // scroll target for this clamp. The schedule itself is not native evidence.
    h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: h.native.x } } }); h.flush();
    h.content(); h.flush(); aligned(h); h.close();
  });
}

test('unchanged layout after binding retries a command rejected by the real generation guard', () => {
  const h = harness(); h.ready();
  const count = h.commands.length;
  h.rejectNextCommand(); h.update({ currentMs: 6000 });
  assert.equal(h.commands.length, count, 'the production controller must drop the retired generation');
  h.activate();
  h.layout(); h.flush(); aligned(h); h.close();
});

test('unchanged content callback after rebinding recovers a reopened draft position', () => {
  const h = harness({ currentMs: 4234 }); h.ready(); h.rebind();
  h.content(); h.flush(); aligned(h); h.close();
});

test('current time and source extent changes use the latest target when geometry arrives', () => {
  const h = harness(); h.ready(); h.resize(820);
  h.update({ durationMs: 30000, currentMs: 17321, sources: [{ id: 'replacement' }] });
  h.content(); h.flush(); h.layout(); h.flush(); aligned(h); h.close();
});

test('ordinary scroll acknowledgements do not take ownership or recenter', () => {
  const h = harness(); h.ready(); const count = h.commands.length;
  h.native.x = 12; h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 12 } } }); h.flush();
  assert.equal(h.native.x, 12); assert.equal(h.commands.length, count); assert.deepEqual(h.seeks, []); h.close();
});

test('native content readiness during user scrub does not reclaim the viewport', () => {
  const h = harness(); h.ready(); h.horizontal.onScrollBeginDrag(); const count = h.commands.length;
  h.native.x = 55; h.content(); h.layout(); h.flush();
  assert.equal(h.native.x, 55); assert.equal(h.commands.length, count); h.close();
});

test('both native callbacks can precede the render for their outer layout', () => {
  const h = harness(); h.ready();
  h.outer.onLayout({ nativeEvent: { layout: { width: 800 } } });
  h.layout(800); h.content(1518); h.flush(); aligned(h); h.close();
});

test('rapid repeated resize ignores partial/stale geometry and recovers in either callback order', () => {
  const h = harness({ currentMs: 5100 }); h.ready();
  for (const [index, width] of [800, 360, 900, 360, 800].entries()) {
    const oldContent = h.expectedContent();
    h.resize(width);
    const before = h.commands.length;
    h.layout(width - 30); h.content(oldContent); h.flush();
    assert.equal(h.commands.length, before, 'mismatched geometry must not issue a follow command');
    if (index % 2) { h.content(); h.flush(); h.layout(width); }
    else { h.layout(width); h.flush(); h.content(); }
    h.flush(); aligned(h);
  }
  h.close();
});

test('zero/nonfinite geometry is not readiness and later valid measurements recover', () => {
  const h = harness(); h.resize(800); const before = h.commands.length;
  for (const value of [0, -1, NaN, Infinity]) { h.layout(value); h.content(value); h.flush(); }
  assert.equal(h.commands.length, before);
  h.layout(800); h.content(); h.flush(); aligned(h); h.close();
});

test('a stale content measurement after an extent change cannot move the latest target', () => {
  const h = harness(); h.ready(); const old = h.expectedContent();
  h.update({ durationMs: 45000, currentMs: 31900 });
  const before = h.commands.length;
  h.content(old); h.flush(); assert.equal(h.commands.length, before);
  h.content(); h.flush(); aligned(h); h.close();
});

test('project replacement at identical time and geometry follows the reopened project', () => {
  const h = harness({ currentMs: 4200 }); h.ready(); h.native.x = 0;
  h.update({ projectId: 'reopened' }); aligned(h); h.close();
});

test('selected cue ownership defers readiness until the transaction ends', () => {
  const h = harness({ currentMs: 4000, selectedLayerId: 'captions', selectedCaptionId: 'cue',
    layers: [{ id: 'captions', kind: 'captions' }], captions: [{ id: 'cue', startMs: 3000, endMs: 4500, text: 'selected' }] });
  h.ready(); aligned(h);
  h.find('TimedBlock').onChangeStart(); h.flush();
  h.find('TimedBlock').onTouchLock(false); h.flush();
  const count = h.commands.length; h.native.x = 60;
  h.layout(); h.content(); h.update({ currentMs: 4100 });
  assert.equal(h.native.x, 60); assert.equal(h.commands.length, count);
  h.find('TimedBlock').onEnd(); h.update({ currentMs: 4200 }); aligned(h); h.close();
});

test('outer resize cancels a scrub and late content restores the unchanged clock', () => {
  const h = harness({ currentMs: 4000 }); h.ready(); h.horizontal.onScrollBeginDrag();
  h.resize(800); h.layout(); h.flush(); h.content(); h.flush(); aligned(h); h.close();
});

test('item gesture cancellation on resize waits for matching content and then follows', () => {
  const h = harness({ currentMs: 4000, layers: [{ id: 'text', kind: 'text', text: 'item', startMs: 2000, endMs: 5000 }] });
  h.ready();
  const item = h.find('TimedBlock'); item.onChangeStart(); h.flush();
  // The real viewport geometry observer cancels gestures through subscribers.
  // Here the item boundary closes the transaction as its native cancel does.
  item.onEnd(); h.resize(800); h.content(); h.flush(); h.layout(); h.flush(); aligned(h); h.close();
});

test('zoom waits for new native content while preserving padding and scale', () => {
  const h = harness({ currentMs: 4000 }); h.ready();
  const width = h.expectedContent();
  h.find('ZoomButton').onPress(); h.flush();
  assert.ok(h.expectedContent() > width);
  h.content(); h.flush(); aligned(h); h.close();
});

test('geometry callbacks leave video reorder ownership intact until cancellation', () => {
  const h = harness({ currentMs: 4000, clips: [{ id: 'clip', sourceId: 'video', sourceStartMs: 0,
    sourceEndMs: 8000, playbackRate: 1, gapBeforeMs: 0, gapAfterMs: 0 }] });
  h.ready(); h.find('VideoClipBlock').onReorderPreview(0); h.flush();
  // Reorder's existing effect chooses its own tile offset. Geometry may not
  // overwrite that offset with clock-follow even if native input is unlocked.
  h.find('VideoClipBlock').onGestureLock(false); h.flush();
  const x = h.native.x, count = h.commands.length;
  h.layout(); h.content(); h.flush();
  assert.equal(h.native.x, x); assert.equal(h.commands.length, count);
  h.find('VideoClipBlock').onReorderCancel(); h.flush(); h.ready(); aligned(h); h.close();
});

for (const release of ['cancel', 'up']) test(`active audio geometry invalidation plus live ${release} cannot transfer the old stream to scrub`, () => {
  const h = harness({ currentMs: 4000, selectedAudioClipId: 'audio', audioClips: [{ id: 'audio', sourceId: 'source',
    startMs: 2000, sourceStartMs: 0, sourceEndMs: 5000, playbackRate: 1 }] });
  h.ready();
  const pan = h.mountItemPan(h.find('TimedBlock')); pan.start();
  assert.equal(h.changes.length, 1, 'a real active timing preview must precede invalidation');
  assert.equal(h.timingStarts, 1);
  h.resize(800); pan[release]();
  assert.deepEqual(pan.calls, ['activate', 'fail'], 'release only through the live manager; no stale MOVE');
  assert.equal(h.timingEnds, 1, 'cancellation must close the live edit exactly once');
  // Conditional native ordering: external Native may report Begin after the
  // item yields. This is not an assertion that Samsung delivered this order.
  h.horizontal.onScrollBeginDrag(); h.native.x = 90;
  h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 90 } } }); h.flush();
  assert.deepEqual(h.seeks, [], 'an invalidated item stream cannot become a scrub');
  assert.equal(h.scrubStarts, 0, 'a retired stream must not pause transport through onScrubStart');
  h.layout(); h.content(); h.flush(); aligned(h);
  assert.equal(h.changes.length, 1, 'no cancelled timing preview can be delivered again');
  // A genuinely new single-finger touch may still scrub normally.
  h.horizontal.onTouchStart?.({ nativeEvent: { touches: [{}] } });
  h.horizontal.onScrollBeginDrag();
  h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 100 } } }); h.flush();
  assert.equal(h.seeks.length, 1); assert.equal(h.scrubStarts, 1); h.close();
});

test('JS touch cancellation from native takeover must not revoke a genuine scrub', () => {
  const h = harness({ currentMs: 4000 }); h.ready();
  h.horizontal.onTouchStart?.({ nativeEvent: { touches: [{}] } });
  h.horizontal.onScrollBeginDrag(); h.native.x = 55;
  h.horizontal.onTouchCancel?.(); h.ready();
  assert.equal(h.native.x, 55);
  h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 55 } } }); h.flush();
  assert.equal(h.seeks.length, 1); h.close();
});
