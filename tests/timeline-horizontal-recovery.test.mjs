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
function harness(initial = {}, { fullBinding = false, pixelRatio = 1, platform = 'android', manualIntervals = false } = {}) {
  let cursor = 0, dirty = false, tree, effects = [], horizontal, outer, first = true;
  const intervals = new Map(); let intervalSequence = 0;
  let scrubStarts = 0, timingStarts = 0, timingEnds = 0;
  let slots = [];
  const primarySlots = slots, childSlots = [], modules = new Map(), jobs = [], commands = [], seeks = [], changes = [];
  const springSlots = [], rnJobs = [];
  const appStateListeners = new Map();
  const appState = { currentState: 'active', addEventListener(event, listener) {
    assert.ok(['change', 'blur', 'focus'].includes(event)); appStateListeners.set(listener, event);
    return { remove: () => appStateListeners.delete(listener) };
  } };
  let springHost, committedRef;
  let geometry;
  let holdAcknowledgements = false;
  const acknowledgements = [];
  const native = { viewport: 360, content: 638, x: 0, generation: 1 };
  let props = { projectId: 'saved', durationMs: 8000, currentMs: 8000,
    clips: [], sources: [], layers: [], captions: [], translationTracks: [], audioSources: [], audioClips: [],
    onSeek: ms => seeks.push(ms), onScrubStart: () => scrubStarts++,
    onTimingChangeStart: () => timingStarts++, onTimingChangeEnd: () => timingEnds++,
    onSelectAudioClip() {}, onSelectLayer() {}, onItemTimingChange: (...args) => changes.push(args), ...initial };
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
        effects.push(() => { old?.cleanup?.(); store[i].setup = fn; store[i].cleanup = fn(); });
      }
    },
  };
  hooks.useLayoutEffect = hooks.useEffect;
  hooks.forwardRef = render => render;
  const jsx = (type, props) => ({ type, props });
  const shared = value => ({ value, modify(fn) { this.value = fn(this.value); } });
  const gesture = () => new Proxy({ handlers: { isWorklet: [] } }, {
    get(target, name, receiver) { return name in target ? target[name] : (...args) => {
      if (String(name).startsWith('on')) target.handlers[name] = args[0];
      return receiver;
    }; },
  });
  const reanimated = { __esModule: true, useSharedValue: value => hooks.useMemo(() => shared(value), []),
    default: { createAnimatedComponent: component => component },
    useReducedMotion: () => false,
    useAnimatedRef: () => hooks.useMemo(() => {
      const ref = value => { if (value) ref.current = value; return ref.current; };
      return ref;
    }, []),
    // Decorative spring presentation is outside this binding/command contract.
    // No inner host is attached, so no content-owner animation is mounted.
    useScrollOffset() {}, useAnimatedReaction() {},
    cancelAnimation() {}, dispatchCommand(ref, name, args) {
      if (fullBinding) assert.equal(ref(), node, 'real wrapper animated ref resolves the bound host');
      assert.equal(name, 'scrollTo'); assert.equal(args[2], false);
      commands.push(args[0]);
      native.x = Math.min(Math.max(0, args[0]), Math.max(0, native.content - native.viewport));
      const x = native.x, viewport = native.viewport, content = native.content;
      const acknowledge = () => (fullBinding ? springHost : horizontal).props.onScroll({ nativeEvent: {
        contentOffset: { x }, layoutMeasurement: { width: viewport }, contentSize: { width: content },
      } });
      (holdAcknowledgements ? acknowledgements : jobs).push(acknowledge);
    } };
  const worklets = { scheduleOnUI: (fn, ...args) => jobs.push(() => fn(...args)),
    scheduleOnRN: (fn, ...args) => (fullBinding ? rnJobs : jobs).push(() => fn(...args)) };
  const spring = { SpringScrollView: 'SpringScrollView', SpringScrollGestureContext: { value: [] } };
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    const exports = {}; modules.set(file, exports);
    runInNewContext(code(file), { exports, clearTimeout, setTimeout,
      clearInterval: manualIntervals ? id => intervals.delete(id) : clearInterval,
      setInterval: manualIntervals ? fn => { intervals.set(++intervalSequence, fn); return intervalSequence; } : setInterval,
      performance: { now: () => 1 }, require(id) {
        if (id === 'react') return hooks;
        if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx };
        if (id === 'react-native') return { View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'NativeScrollView',
          StyleSheet: { flatten: style => Object.assign({}, ...[style].flat(Infinity).filter(Boolean)) },
          AppState: appState,
          AccessibilityInfo: { addEventListener: () => ({ remove() {} }),
            isReduceMotionEnabled: () => ({ then: resolve => resolve(false) }) },
          Platform: { OS: platform }, PanResponder: { create: panHandlers => ({ panHandlers }) },
          PixelRatio: { roundToNearestPixel: x => x, get: () => pixelRatio } };
        if (id === 'react-native-reanimated') return reanimated;
        if (id === 'react-native-worklets') return worklets;
        if (id === 'react-native-gesture-handler') return { Gesture: { Native: gesture, Pan: gesture }, GestureDetector: 'GestureDetector' };
        if (id === '@/components/spring-scroll-view') return fullBinding
          ? load(resolve(root, 'components/spring-scroll-view.tsx')) : spring;
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
  const controller = fullBinding ? undefined : createScrollSpringController({ state, owner: shared(0), offset: shared(0), id: 1,
    nativeOffset: shared(0), getAnimatedRef: () => () => node, getContentRef: () => () => ({}),
    presentationVersion: shared(0), gesture: gesture() });
  // In fullBinding mode only AndroidSpringScrollView may install/activate the guard.
  node.getInnerViewRef = () => null;
  const restore = fullBinding ? () => {} : interceptSpringScrollCommands(node, () => node, () => native.generation, controller.command);
  if (!fullBinding) controller.activate(1, true);
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
    if (fullBinding) {
      slots = springSlots; cursor = 0;
      const android = horizontal.type(horizontal.props);
      const fragment = android.type(android.props);
      assert.equal(fragment.type, hooks.Fragment, 'real Android spring branch');
      springHost = fragment.props.children.find(child => child?.type === 'GestureDetector').props.children;
      assert.equal(springHost.type, 'NativeScrollView');
      if (committedRef !== springHost.props.ref) {
        committedRef?.(null);
        committedRef = springHost.props.ref;
        committedRef(node);
      }
      slots = primarySlots;
    } else horizontal.props.ref.current = node;
    if (first) { native.content = expectedContent(); first = false; }
    while (effects.length) effects.shift()();
  }
  function flush(runJobs = true, runRN = true) {
    for (let i = 0; i < 40; i++) {
      if (runJobs) while (jobs.length) jobs.shift()();
      if (runJobs && runRN) while (rnJobs.length) rnJobs.shift()();
      if (!dirty) return;
      render();
    }
    assert.fail('render/command feedback loop');
  }
  function layout(width = native.viewport) {
    native.viewport = width;
    (fullBinding ? springHost : horizontal).props.onLayout?.({ nativeEvent: { layout: { width } } });
  }
  function content(width = expectedContent(), commitNative = true) {
    if (commitNative) native.content = width;
    (fullBinding ? springHost : horizontal).props.onContentSizeChange?.(width, 200);
  }
  function expectedContent() { return horizontal.props.contentContainerStyle.width; }
  render(); flush();
  return { native, commands, seeks, changes, flush, layout, content, expectedContent,
    tickIntervals() { for (const fn of [...intervals.values()]) fn(); flush(); },
    get intervalCount() { return intervals.size; },
    captureAppStateListeners: (event = 'change') => [...appStateListeners].filter(([, type]) => type === event).map(([listener]) => listener),
    get appStateListenerCount() { return appStateListeners.size; },
    replayEffects() {
      const mounted = primarySlots.filter(slot => slot?.setup);
      for (const slot of mounted) slot.cleanup?.();
      for (const slot of mounted) slot.cleanup = slot.setup();
      flush();
    },
    blur() { assert.equal(appState.currentState, 'active');
      for (const [listener, event] of [...appStateListeners]) if (event === 'blur') listener(); flush(); },
    appState(state) {
      appState.currentState = state;
      for (const [listener, event] of [...appStateListeners]) if (event === 'change') listener(state);
      flush();
    },
    get horizontal() { return horizontal.props; }, get outer() { return outer.props; },
    get props() { return props; },
    get scrubStarts() { return scrubStarts; },
    get timingStarts() { return timingStarts; },
    get timingEnds() { return timingEnds; },
    findAll(name) {
      const found = [];
      function walk(element) {
        if (!element?.props) return;
        if (element.type?.name === name) found.push(element.props);
        for (const child of [element.props.children].flat(Infinity)) walk(child);
      }
      walk(tree); return found;
    },
    find(name) { const found = this.findAll(name); assert.ok(found.length, name); return found.at(-1); },
    holdAcknowledgements() { holdAcknowledgements = true; },
    acknowledge() { jobs.push(...acknowledgements.splice(0)); flush(); },
    mountItemPan(owner, edge = 'end') {
      TimelineNativeGeometryContext.value = geometry;
      function mount(fn) {
        const store = []; childSlots.push(store); slots = store; cursor = 0;
        const result = fn();
        while (effects.length) effects.shift()();
        slots = primarySlots;
        return result;
      }
      const timing = mount(() => timingHookForTest(owner, edge, owner.onTouchLock));
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
    update(next, runJobs = true) { props = { ...props, ...next }; render(); flush(runJobs); },
    rebind() { controller.deactivate(++native.generation); controller.activate(native.generation, true); native.x = 0; },
    rejectNextCommand() { jobs.push(() => controller.deactivate(++native.generation)); },
    activate() { controller.activate(native.generation, true); },
    bindingReady() { horizontal.props.onScrollBindingReady?.(); flush(); },
    // Ref detach/attach only: no layout, content or transport event is synthesized.
    reattach() {
      assert.ok(fullBinding);
      committedRef(null); committedRef(node); native.x = 0;
      flush(true, false);
    },
    get pendingRN() { return rnJobs.length; },
    deliverRN() { assert.ok(rnJobs.length); rnJobs.shift()(); flush(true, false); },
    close() { committedRef?.(null); restore(); for (const store of [primarySlots, springSlots, ...childSlots]) for (const slot of store) slot?.cleanup?.(); },
  };
}

function aligned(h) {
  // For these viewports the unchanged leading/trailing padding makes the
  // maximum scroll extent exactly the track width.
  const track = h.expectedContent() - h.native.viewport;
  assert.equal(h.native.x, Math.min(1, Math.max(0, h.props.currentMs / h.props.durationMs)) * track);
  assert.deepEqual(h.seeks, [], 'passive geometry must never change transport time');
}

for (const ending of ['completed', 'blur', 'background']) {
  for (const target of [0, 20, 7060]) test(`repeated scrub: ${ending} then external clock advance seeks the same ${target}ms during a fresh drag`, () => {
    const h = harness({ currentMs: 4000 }, { fullBinding: true });
    try {
      h.ready();
      const x = target / h.props.durationMs * (h.expectedContent() - h.native.viewport);
      h.horizontal.onTouchStart({ nativeEvent: { touches: [{}] } });
      h.horizontal.onScrollBeginDrag();
      h.horizontal.onScroll({ nativeEvent: { contentOffset: { x } } }); h.flush();
      // Complete the first gesture even on the broken zero/near-zero baseline,
      // so this assertion specifically diagnoses cache retention across owners.
      if (ending === 'completed') h.horizontal.onMomentumScrollEnd();
      else if (ending === 'blur') h.blur();
      else { h.appState('background'); h.appState('active'); }
      const before = [...h.seeks];
      h.update({ currentMs: 8000 });
      assert.deepEqual(h.seeks, before, 'external clock follow must not seek');
      assert.equal(h.native.x, h.expectedContent() - h.native.viewport);
      h.horizontal.onTouchStart({ nativeEvent: { touches: [{}] } });
      h.horizontal.onScrollBeginDrag();
      h.horizontal.onScroll({ nativeEvent: { contentOffset: { x } } }); h.flush();
      assert.equal(h.scrubStarts, 2);
      assert.equal(h.seeks.length, before.length + 1, 'fresh owner must seek before UP or any terminal callback');
      assert.ok(Math.abs(h.seeks.at(-1) - target) < 1e-8);
    } finally { h.close(); }
  });
}

for (const target of [0, 20, 30]) test(`repeated scrub: first target ${target}ms is not suppressed by an uninitialized cache`, () => {
  const h = harness({ currentMs: 4000 });
  try {
    h.ready(); h.horizontal.onScrollBeginDrag();
    const x = target / h.props.durationMs * (h.expectedContent() - h.native.viewport);
    h.horizontal.onScroll({ nativeEvent: { contentOffset: { x } } }); h.flush();
    assert.equal(h.seeks.length, 1, 'the first scroll must seek during the drag, including zero');
    assert.ok(Math.abs(h.seeks[0] - target) < 1e-8);
  } finally { h.close(); }
});

test('repeated scrub: 32ms dedup survives momentum continuation and final seek remains forced', () => {
  const h = harness({ currentMs: 4000 });
  try {
    h.ready();
    const scroll = ms => {
      const x = ms / h.props.durationMs * (h.expectedContent() - h.native.viewport);
      h.horizontal.onScroll({ nativeEvent: { contentOffset: { x } } }); h.flush();
    };
    h.horizontal.onScrollBeginDrag(); scroll(1000); scroll(1010); scroll(1031);
    assert.deepEqual(h.seeks, [1000]);
    scroll(1032); assert.deepEqual(h.seeks, [1000, 1032]);
    h.horizontal.onScrollEndDrag(); h.horizontal.onMomentumScrollBegin();
    scroll(1040); assert.deepEqual(h.seeks, [1000, 1032], 'momentum retains the same gesture cache');
    scroll(1064); assert.deepEqual(h.seeks, [1000, 1032, 1064]);
    scroll(1070); h.horizontal.onMomentumScrollEnd();
    assert.deepEqual(h.seeks, [1000, 1032, 1064, 1070], 'terminal seek bypasses dedup');
    assert.equal(h.scrubStarts, 1);
  } finally { h.close(); }
});

test('repeated scrub: a locked begin cannot reset the cache of the current owner', () => {
  const h = harness({ currentMs: 4000, layers: [{ id: 'text', kind: 'text', text: 'item', startMs: 2000, endMs: 5000 }] });
  try {
    h.ready(); h.horizontal.onScrollBeginDrag();
    h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 55 } } }); h.flush();
    const before = [...h.seeks];
    h.find('TimedBlock').onTouchLock(true); h.flush();
    h.horizontal.onScrollBeginDrag();
    h.find('TimedBlock').onTouchLock(false); h.flush();
    h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 55 } } }); h.flush();
    assert.deepEqual(h.seeks, before, 'rejected begin must not clear live dedup');
    assert.equal(h.scrubStarts, 1);
  } finally { h.close(); }
});

for (const guard of ['background', 'invalid geometry', 'invalidated touch']) test(`repeated scrub: ${guard} rejects stale begin until a fresh eligible touch`, () => {
  const h = harness({ currentMs: 4000 });
  try {
    h.ready(); h.horizontal.onScrollBeginDrag();
    h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 55 } } }); h.flush();
    if (guard === 'background') h.appState('background');
    else { h.resize(0); if (guard === 'invalidated touch') { h.resize(360); h.ready(); } }
    const before = [...h.seeks];
    h.horizontal.onScrollBeginDrag();
    h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 55 } } }); h.flush();
    h.horizontal.onMomentumScrollEnd();
    assert.deepEqual(h.seeks, before, 'rejected stream must not seek even at its terminal callback');
    assert.equal(h.scrubStarts, 1);
    if (guard === 'background') h.appState('active');
    else { h.resize(360); h.ready(); }
    h.update({ currentMs: 8000 });
    h.horizontal.onTouchStart({ nativeEvent: { touches: [{}] } });
    h.horizontal.onScrollBeginDrag();
    h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 55 } } }); h.flush();
    assert.equal(h.seeks.length, before.length + 1, 'fresh eligible owner resets dedup');
    assert.equal(h.scrubStarts, 2);
  } finally { h.close(); }
});

test('Samsung clamped ACK keeps the paused target pending across shadow content and late native layout', () => {
  const h = harness({}, { fullBinding: true, pixelRatio: 3 });
  try {
    h.ready(); h.resize(336); h.layout();
    h.native.content = 338 + 2 / 3;
    const count = h.commands.length;
    h.content(592, false); h.flush();
    assert.equal(h.expectedContent(), 592);
    assert.equal(h.commands[count], 256);
    assert.ok(Math.abs(h.native.x - 2 / 3 * 4) < 1e-10);
    assert.ok(h.commands.length > count + 1, 'clamped ACK must reconcile the still-current paused target');
    const clamped = h.commands.length;
    h.flush(); h.update({});
    assert.equal(h.commands.length, clamped, 'an unchanged clamp must settle without polling or a command loop');
    // No later native event is promised by the trace. This explicit layout is
    // a conditional recovery opportunity, not proof Android will deliver it.
    h.native.content = 592; h.flush(); h.update({});
    assert.equal(h.commands.length, clamped, 'silent native readiness supplies no reconciliation signal');
    h.layout(); h.flush(); aligned(h);
    assert.equal(h.props.currentMs, 8000);
    const settled = h.commands.length; h.flush();
    assert.equal(h.commands.length, settled);
    assert.equal(h.scrubStarts, 0); assert.deepEqual(h.changes, []);
  } finally { h.close(); }
});

test('late native commit before clamped ACK reconciliation recovers without another JS layout or clock event', () => {
  const h = harness({}, { fullBinding: true, pixelRatio: 3 });
  try {
    h.ready(); h.resize(336); h.layout(); h.holdAcknowledgements();
    h.native.content = 338 + 2 / 3;
    const count = h.commands.length;
    h.content(592, false); h.flush();
    assert.equal(h.commands.length, count + 1);
    assert.ok(Math.abs(h.native.x - 2 / 3 * 4) < 1e-10);
    h.native.content = 592;
    h.acknowledge();
    assert.equal(h.commands.length, count + 2, 'clamped raw ACK alone recomputes current clock follow');
    aligned(h);
    h.acknowledge();
    assert.equal(h.commands.length, count + 2);
    assert.equal(h.props.currentMs, 8000); assert.deepEqual(h.changes, []);
    assert.equal(h.scrubStarts, 0);
  } finally { h.close(); }
});

test('pending follow uses latest clock across repeated growing and shrinking native constraints', () => {
  const h = harness({}, { fullBinding: true });
  try {
    h.ready();
    for (const [width, clock] of [[800, 7000], [336, 8000], [900, 5000], [360, 8000]]) {
      h.resize(width); h.layout();
      h.native.content = width + 2;
      const before = h.commands.length;
      h.content(h.expectedContent(), false); h.flush();
      assert.ok(h.commands.length > before + 1, 'clamped ACK must leave follow pending');
      h.update({ currentMs: clock });
      const target = (h.expectedContent() - width) * clock / 8000;
      assert.equal(h.commands.at(-1), target, 'pending work recomputes the current target');
      h.native.content = h.expectedContent(); h.layout(); h.flush(); aligned(h);
    }
    assert.deepEqual(h.changes, []); assert.equal(h.scrubStarts, 0);
  } finally { h.close(); }
});

test('raw ACK beyond a shrinking model cannot masquerade as the current end target', () => {
  const h = harness({}, { fullBinding: true });
  try {
    h.ready(); h.resize(336); h.layout(); h.holdAcknowledgements();
    h.native.content = 1500; h.content(592, false); h.flush();
    h.native.x = 500;
    const count = h.commands.length;
    h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 500 } } }); h.flush();
    assert.equal(h.commands.length, count + 1, 'raw 500 is not target 256 even though model clamps both to 256');
    assert.equal(h.commands.at(-1), 256); assert.deepEqual(h.seeks, []);
  } finally { h.close(); }
});

for (const owner of ['drag', 'selection']) test(`pending clamped follow yields to real ${owner} without extra seeks`, () => {
  const h = harness({ selectedLayerId: 'captions', selectedCaptionId: 'cue',
    layers: [{ id: 'captions', kind: 'captions' }],
    captions: [{ id: 'cue', startMs: 3000, endMs: 4500, text: 'cue' }],
  }, { fullBinding: true });
  try {
    h.ready(); h.resize(336); h.layout();
    h.native.content = 338 + 2 / 3; h.content(592, false); h.flush();
    if (owner === 'drag') {
      h.horizontal.onTouchStart({ nativeEvent: { touches: [{}] } });
      h.horizontal.onScrollBeginDrag();
    } else {
      h.find('TimedBlock').onChangeStart(); h.flush();
      h.find('TimedBlock').onTouchLock(false); h.flush();
    }
    const count = h.commands.length;
    h.native.content = 592; h.native.x = 55;
    h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 55 } } }); h.flush();
    h.layout(); h.content(); h.bindingReady();
    assert.equal(h.commands.length, count); assert.equal(h.native.x, 55);
    assert.equal(h.seeks.length, owner === 'drag' ? 1 : 0);
    assert.equal(h.scrubStarts, owner === 'drag' ? 1 : 0);
    assert.deepEqual(h.changes, []);
  } finally { h.close(); }
});

test('invalid outer measurement preserves model geometry while invalidating readiness and old touches', () => {
  const h = harness();
  try {
    h.ready(); const content = h.expectedContent(), count = h.commands.length;
    for (const width of [0, -1, NaN, Infinity]) {
      h.outer.onLayout({ nativeEvent: { layout: { width } } }); h.flush();
      assert.equal(h.expectedContent(), content, 'invalid width must not collapse or poison the model');
      h.bindingReady(); h.content(); h.layout(); h.update({ currentMs: 7000 });
      assert.equal(h.commands.length, count, 'cached valid child geometry cannot undo an invalid outer measurement');
      h.horizontal.onScrollBeginDrag();
      assert.equal(h.scrubStarts, 0, 'the invalidated old stream cannot acquire scrub');
    }
    h.outer.onLayout({ nativeEvent: { layout: { width: 360 } } }); h.flush();
    h.ready(); aligned(h);
  } finally { h.close(); }
});

test('pending follow accepts a raw native ACK within one physical pixel', () => {
  const h = harness({}, { fullBinding: true, pixelRatio: 3 });
  try {
    h.ready(); h.resize(336); h.layout(); h.holdAcknowledgements(); h.content(); h.flush();
    const count = h.commands.length;
    h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 256 - 0.3 } } }); h.flush();
    assert.equal(h.commands.length, count);
    h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 255 } } }); h.flush();
    assert.equal(h.commands.length, count, 'once displayed, unrelated ACKs must not acquire follow ownership');
  } finally { h.close(); }
});

test('an unchanged zero ACK completes follow without acquiring later passive offsets', () => {
  const h = harness({ currentMs: 0 }, { fullBinding: true });
  try {
    h.ready(); const count = h.commands.length;
    h.native.x = 12;
    h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 12 } } }); h.flush();
    assert.equal(h.commands.length, count, 'zero was actually acknowledged even without a state change');
    assert.equal(h.native.x, 12); assert.deepEqual(h.seeks, []);
  } finally { h.close(); }
});

test('full binding: paused reattachment follows only after UI acceptance reaches RN and native ACK reaches the ruler', () => {
  const h = harness({ durationMs: 120000, currentMs: 90000 }, { fullBinding: true });
  try {
    h.ready(); aligned(h);
    const count = h.commands.length, clock = h.props.currentMs;
    const range = () => {
      const ruler = h.find('TimelineRuler');
      return [ruler.visibleStartMs, ruler.visibleEndMs];
    };
    // The replacement native viewport reports its initial offset, then has no
    // further layout/content/time changes. Only binding readiness can follow.
    h.reattach();
    h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 0 } } });
    h.flush(true, false);
    const before = range();
    assert.equal(h.pendingRN, 1, 'real controller.activate scheduled the readiness delivery');
    assert.equal(h.commands.length, count, 'UI activation alone cannot call the RN follow effect');
    h.holdAcknowledgements(); h.deliverRN();
    assert.equal(h.commands.length, count + 1, 'real wrapper callback reaches LayerTimeline follow and intercepted native dispatch');
    aligned(h);
    assert.deepEqual(range(), before, 'dispatch cannot claim an acknowledged viewport');
    h.acknowledge();
    assert.notDeepEqual(range(), before, 'native onScroll advances the rendered ruler');
    h.flush(); h.update({});
    assert.equal(h.commands.length, count + 1, 'ACK and unchanged render cannot feed back into follow');
    assert.equal(h.props.currentMs, clock);
    assert.deepEqual(h.changes, []); assert.equal(h.scrubStarts, 0);
    assert.equal(h.timingStarts, 0); assert.equal(h.timingEnds, 0);
  } finally { h.close(); }
});

test('full binding: delayed RN readiness from a retired attachment cannot retry the latest target', () => {
  const h = harness({ currentMs: 5000 }, { fullBinding: true });
  try {
    h.ready(); const count = h.commands.length;
    h.reattach(); h.reattach();
    assert.equal(h.pendingRN, 2);
    h.deliverRN();
    assert.equal(h.commands.length, count, 'production wrapper must reject the retired RN generation');
    assert.equal(h.native.x, 0);
    h.deliverRN();
    assert.equal(h.commands.length, count + 1, 'only current attachment readiness may recover');
    aligned(h); h.flush(); assert.equal(h.commands.length, count + 1);
  } finally { h.close(); }
});

for (const owner of ['scrub', 'cue edit']) test(`full binding: reattachment readiness preserves ${owner} ownership`, () => {
  const h = harness({ currentMs: 4000, selectedLayerId: 'captions', selectedCaptionId: 'cue',
    layers: [{ id: 'captions', kind: 'captions' }],
    captions: [{ id: 'cue', startMs: 3000, endMs: 4500, text: 'cue' }],
  }, { fullBinding: true });
  try {
    h.ready();
    if (owner === 'scrub') h.horizontal.onScrollBeginDrag();
    else { h.find('TimedBlock').onChangeStart(); h.flush(); h.find('TimedBlock').onTouchLock(false); h.flush(); }
    const count = h.commands.length;
    h.reattach(); h.native.x = 55;
    assert.equal(h.pendingRN, 1); h.deliverRN();
    assert.equal(h.commands.length, count, 'binding callback cannot reclaim an owned viewport');
    assert.equal(h.native.x, 55); assert.deepEqual(h.seeks, []); assert.deepEqual(h.changes, []);
    h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 55 } } }); h.flush();
    assert.equal(h.commands.length, count, 'scroll feedback cannot cause passive follow');
    assert.equal(h.seeks.length, owner === 'scrub' ? 1 : 0, 'only the genuine scrub may seek');
    assert.equal(h.scrubStarts, owner === 'scrub' ? 1 : 0);
    assert.equal(h.timingStarts, owner === 'cue edit' ? 1 : 0);
  } finally { h.close(); }
});

for (const reject of [false, true]) test(`displayed viewport waits for native acknowledgement${reject ? ' after generation rejection and retry' : ''}`, () => {
  const h = harness({ durationMs: 120000, currentMs: 0,
    selectedLayerId: 'captions', selectedCaptionId: 'late',
    layers: [{ id: 'captions', kind: 'captions' }],
    captions: [
      { id: 'early', startMs: 1000, endMs: 2000, text: 'early cue' },
      { id: 'late', startMs: 90000, endMs: 91000, text: 'selected late cue' },
    ],
    audioSources: [{ id: 'early', displayName: 'early audio' }, { id: 'late', displayName: 'late audio' }],
    audioClips: [1000, 90000].map((startMs, i) => ({ id: `audio-${i}`, sourceId: i ? 'late' : 'early',
      startMs, sourceStartMs: 0, sourceEndMs: 1000, playbackRate: 1 })),
  });
  try {
    h.ready();
    const snapshot = () => {
      const ruler = h.find('TimelineRuler');
      return {
        range: [ruler.visibleStartMs, ruler.visibleEndMs],
        bodies: h.findAll('TimedBlock').map(item => [item.label, Boolean(item.selected),
          item.waveformVisibleStartMs, item.waveformVisibleEndMs]),
      };
    };
    const before = snapshot(), count = h.commands.length;
    assert.deepEqual(before.bodies.map(item => item[0]), ['early cue', 'early audio']);
    h.holdAcknowledgements();
    if (reject) h.rejectNextCommand();
    h.update({ currentMs: 90000 }, false);
    assert.equal(h.native.x, 0, 'the UI command has not run');
    assert.equal(h.commands.length, count);
    assert.deepEqual(snapshot(), before, 'rendered bounds and bodies cannot anticipate a queued command');
    h.flush();
    if (reject) {
      assert.equal(h.commands.length, count, 'the real spring guard rejected the command');
      assert.equal(h.native.x, 0);
      assert.deepEqual(snapshot(), before, 'rejection cannot claim a displayed offset');
      h.activate(); h.bindingReady();
    }
    assert.equal(h.commands.length, count + 1, 'readiness retries exactly once when needed');
    aligned(h);
    assert.deepEqual(snapshot(), before, 'native dispatch without onScroll cannot advance rendered bounds');
    h.acknowledge();
    const after = snapshot();
    const track = h.expectedContent() - h.native.viewport;
    assert.deepEqual(after.range, [(h.native.x - 360) / track * 120000,
      (h.native.x + 360) / track * 120000]);
    assert.deepEqual(after.bodies.map(item => item[0]), ['selected late cue', 'late audio']);
    assert.equal(after.bodies[0][1], true, 'selected cue remains selected when its actual viewport arrives');
    assert.deepEqual(after.bodies[1].slice(2), after.range, 'waveform virtualization follows acknowledged bounds');
    assert.equal(h.commands.length, count + 1, 'acknowledgement must not recenter');
    assert.deepEqual(h.seeks, []);
    assert.deepEqual(h.changes, []);
    assert.equal(h.scrubStarts, 0);
    assert.equal(h.timingStarts, 0);
    assert.equal(h.timingEnds, 0);
  } finally { h.close(); }
});

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
  h.layout(); h.content(); h.bindingReady(); h.update({ currentMs: 4100 });
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
  h.layout(); h.content(); h.bindingReady(); h.flush();
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

// These consumer event schedules omit the terminal callback deliberately; they
// do not model or diagnose why the native stream was interrupted on a device.
for (const interrupted of ['drag', 'momentum', 'missingEnd']) test(`focus-only blur abandons horizontal ${interrupted} without its terminal event so fresh clock follow reaches native`, () => {
  const h = harness({ currentMs: 4000 }, { fullBinding: true });
  try {
    h.ready();
    h.horizontal.onScrollBeginDrag();
    h.native.x = 55;
    h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 55 } } }); h.flush();
    assert.equal(h.seeks.length, 1, 'the live drag must seek before interruption');
    h.update({ currentMs: h.seeks[0] });
    if (interrupted === 'momentum') {
      h.horizontal.onScrollEndDrag(); h.horizontal.onMomentumScrollBegin();
    }
    const seeks = [...h.seeks];
    if (interrupted === 'missingEnd') h.horizontal.onScrollEndDrag();
    h.blur();
    const count = h.commands.length;
    // LayerTimeline receives the parent's clock, not an isPlaying prop. A fresh
    // playback tick must recover without resize, rebinding or fabricated UP.
    h.update({ currentMs: 6000 });
    const target = (h.expectedContent() - h.native.viewport) * 6000 / h.props.durationMs;
    assert.ok(h.commands.length > count, 'fresh clock must dispatch horizontal follow after background abandoned the stream');
    assert.equal(h.commands.at(-1), target);
    assert.equal(h.native.x, target, 'follow must pass the real spring binding and generation guard');
    assert.deepEqual(h.seeks, seeks, 'native follow acknowledgements must not reverse-seek');
    h.horizontal.onTouchStart({ nativeEvent: { touches: [{}] } });
    h.horizontal.onScrollBeginDrag();
    h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 100 } } }); h.flush();
    assert.equal(h.seeks.length, seeks.length + 1, 'a fresh drag can still seek');
  } finally { h.close(); }
});

for (const interrupted of ['drag', 'momentum']) test(`background abandons horizontal ${interrupted} without its terminal event so fresh clock follow reaches native`, () => {
  const h = harness({ currentMs: 4000 }, { fullBinding: true });
  try {
    h.ready();
    h.horizontal.onScrollBeginDrag();
    h.native.x = 55;
    h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 55 } } }); h.flush();
    assert.equal(h.seeks.length, 1, 'the live drag must seek before interruption');
    h.update({ currentMs: h.seeks[0] });
    if (interrupted === 'momentum') {
      h.horizontal.onScrollEndDrag(); h.horizontal.onMomentumScrollBegin();
    }
    const seeks = [...h.seeks];
    h.appState('background'); h.appState('active');
    const count = h.commands.length;
    // LayerTimeline receives the parent's clock, not an isPlaying prop. A fresh
    // playback tick must recover without resize, rebinding or fabricated UP.
    h.update({ currentMs: 6000 });
    const target = (h.expectedContent() - h.native.viewport) * 6000 / h.props.durationMs;
    assert.ok(h.commands.length > count, 'fresh clock must dispatch horizontal follow after background abandoned the stream');
    assert.equal(h.commands.at(-1), target);
    assert.equal(h.native.x, target, 'follow must pass the real spring binding and generation guard');
    assert.deepEqual(h.seeks, seeks, 'native follow acknowledgements must not reverse-seek');
    h.horizontal.onTouchStart({ nativeEvent: { touches: [{}] } });
    h.horizontal.onScrollBeginDrag();
    h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 100 } } }); h.flush();
    assert.equal(h.seeks.length, seeks.length + 1, 'a fresh drag can still seek');
  } finally { h.close(); }
});

test('horizontal resume follows the latest unchanged clock after suppressing background commands and late ends', () => {
  const h = harness({ currentMs: 4000 }, { fullBinding: true });
  try {
    h.ready(); h.horizontal.onScrollBeginDrag();
    h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 55 } } }); h.flush();
    h.horizontal.onScrollEndDrag();
    h.appState('inactive');
    const commands = h.commands.length, seeks = [...h.seeks];
    h.update({ currentMs: 6000 }); h.ready();
    h.horizontal.onScrollBeginDrag(); h.horizontal.onMomentumScrollBegin();
    h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 90 } } });
    h.horizontal.onMomentumScrollEnd(); h.flush();
    assert.equal(h.commands.length, commands, 'no follow command may be issued in the background');
    assert.deepEqual(h.seeks, seeks, 'late native events cannot finish or reacquire the abandoned scrub');
    h.appState('active');
    const target = (h.expectedContent() - h.native.viewport) * 6000 / h.props.durationMs;
    assert.equal(h.commands.at(-1), target, 'resume recomputes the current target without another clock tick');
    assert.equal(h.native.x, target, 'foreground precedes the command through the real spring controller');
    assert.deepEqual(h.seeks, seeks);
  } finally { h.close(); }
});

test('horizontal effect replay replaces its AppState subscription and ignores retired deliveries', () => {
  const h = harness({ currentMs: 4000 });
  h.ready();
  const retired = h.captureAppStateListeners();
  const retiredBlur = h.captureAppStateListeners('blur');
  assert.equal(retiredBlur.length, 1);
  assert.equal(retired.length, 1);
  h.replayEffects();
  assert.equal(h.appStateListenerCount, 2);
  h.horizontal.onScrollBeginDrag();
  for (const listener of retired) listener('background');
  for (const listener of retiredBlur) listener();
  h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 100 } } }); h.flush();
  assert.equal(h.seeks.length, 1, 'a retired listener cannot abandon the current live drag');
  h.appState('background'); h.appState('active');
  h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 120 } } }); h.flush();
  assert.equal(h.seeks.length, 1, 'the replacement subscription still abandons the drag');
  const unmountedBlur = h.captureAppStateListeners('blur');
  h.close();
  assert.equal(h.appStateListenerCount, 0);
  const commands = h.commands.length;
  for (const listener of retired) listener('active');
  for (const listener of retiredBlur) listener();
  for (const listener of unmountedBlur) listener();
  assert.equal(h.commands.length, commands);
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

// No new layout/content/currentMs event follows the last rejected paused command.
test('binding readiness alone recovers the latest paused target after a real generation rejection', () => {
  const h = harness({ currentMs: 1000 });
  try {
    h.ready(); const count = h.commands.length;
    h.rejectNextCommand(); h.update({ currentMs: 5000 });
    assert.equal(h.commands.length, count, 'production generation guard dropped the final command');
    h.activate(); h.bindingReady();
    assert.equal(h.commands.length, count + 1, 'accepted binding must invalidate follow without another native measurement');
    aligned(h);
  } finally { h.close(); }
});

test('binding readiness uses the replacement project target and waits for matching geometry', () => {
  const h = harness({ currentMs: 1000 });
  try {
    h.ready(); h.resize(800); h.rebind();
    h.update({ projectId: 'replacement', currentMs: 5000 });
    const count = h.commands.length;
    h.bindingReady(); assert.equal(h.commands.length, count, 'partial old geometry is insufficient');
    h.layout(); h.content(); h.flush();
    h.rejectNextCommand(); h.update({ currentMs: 6000 });
    const rejected = h.commands.length;
    h.activate(); h.bindingReady();
    assert.equal(h.commands.length, rejected + 1); aligned(h);
  } finally { h.close(); }
});

test('binding readiness preserves a genuine scrub owner', () => {
  const h = harness({ currentMs: 4000 });
  try {
    h.ready(); h.horizontal.onScrollBeginDrag();
    h.native.x = 55; const count = h.commands.length;
    h.bindingReady();
    assert.equal(h.commands.length, count); assert.equal(h.native.x, 55);
    h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 55 } } }); h.flush();
    assert.equal(h.seeks.length, 1);
  } finally { h.close(); }
});

for (const translated of [false, true]) test(`${translated ? 'dual translated' : 'primary'} cue lifecycle retains edit ownership then follows on binding readiness`, () => {
  const cue = { id: 'cue', startMs: 3000, endMs: 4500, text: 'primary cue' };
  const h = harness({ currentMs: 4000, selectedLayerId: translated ? 'translated' : 'captions', selectedCaptionId: 'cue',
    layers: [{ id: 'captions', kind: 'captions' }], captions: [cue],
    translationTracks: translated ? [{ id: 'translated', name: 'Translated', visible: true, pairs: [{
      source: cue, translation: { id: 'translated-cue', status: 'ready' }, startMs: 3000, endMs: 4500,
      timelineVisible: true, displayText: 'translated cue',
    }] }] : [],
  });
  try {
    h.ready(); aligned(h);
    const item = h.findAll('TimedBlock').find(item => item.label === (translated ? 'translated cue' : 'primary cue'));
    assert.ok(item); assert.equal(item.selected, true);
    item.onChangeStart(); h.flush(); item.onTouchLock(false); h.flush();
    h.native.x = 60; const count = h.commands.length;
    h.bindingReady();
    assert.equal(h.commands.length, count); assert.equal(h.native.x, 60);
    item.onEnd(); h.flush();
    h.rejectNextCommand(); h.update({ currentMs: 4200 });
    const rejected = h.commands.length;
    h.activate(); h.bindingReady();
    assert.equal(h.commands.length, rejected + 1); aligned(h);
    assert.equal(h.timingStarts, 1); assert.equal(h.timingEnds, 1);
    assert.deepEqual(h.changes, []);
  } finally { h.close(); }
});

for (const platform of ['ios', 'web']) test(`${platform} horizontal subscribes only to AppState change`, () => {
  const h = harness({}, { platform });
  try { assert.equal(h.appStateListenerCount, 1); assert.equal(h.captureAppStateListeners('blur').length, 0); }
  finally { h.close(); }
});

test('horizontal focus-only blur follows the unchanged current clock only for an active scrub', () => {
  const h = harness({ currentMs: 4000 }, { fullBinding: true });
  try {
    h.ready();
    const settled = h.commands.length;
    h.blur(); assert.equal(h.commands.length, settled, 'idle blur does not acquire viewport');
    h.horizontal.onScrollBeginDrag();
    h.native.x = 55;
    h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 55 } } }); h.flush();
    const seeks = [...h.seeks];
    h.blur();
    assert.equal(h.native.x, (h.expectedContent() - h.native.viewport) / 2);
    h.horizontal.onScrollEndDrag(); h.horizontal.onMomentumScrollEnd(); h.flush();
    assert.deepEqual(h.seeks, seeks, 'late ends cannot final-seek the old offset');
  } finally { h.close(); }
});

test('horizontal focus-only blur preserves a completed user viewport', () => {
  const h = harness({ currentMs: 4000 }, { fullBinding: true });
  try {
    h.ready(); h.horizontal.onScrollBeginDrag();
    h.native.x = 55; h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: 55 } } }); h.flush();
    h.update({ currentMs: h.seeks.at(-1) });
    h.horizontal.onScrollEndDrag(); h.horizontal.onMomentumScrollEnd(); h.flush();
    const commands = h.commands.length, seeks = [...h.seeks];
    h.blur();
    assert.equal(h.commands.length, commands); assert.equal(h.native.x, 55);
    assert.deepEqual(h.seeks, seeks);
  } finally { h.close(); }
});

// Follow the actual rendered block callbacks across timing updates. A live
// drag must not move its own target to a different vertical hit region.
for (const kind of ['video', 'image', 'text', 'watermark', 'caption', 'translation', 'audio']) {
  test(`${kind}: sliding past a peer keeps the active lane until release`, () => {
    const ranges = ['a', 'b', 'c'].map((id, i) => ({ id, startMs: i * 500, endMs: 3000 + i * 500, text: id }));
    function content(items) {
      if (kind === 'caption') return { layers: [{ id: 'captions', kind: 'captions' }], captions: items };
      if (kind === 'translation') return { layers: [{ id: 'captions', kind: 'captions' }], captions: ranges,
        translationTracks: [{ id: 'translated', name: 'Spanish', visible: true, pairs: items.map(cue => ({
          source: ranges.find(source => source.id === cue.id), translation: { id: `tr-${cue.id}`, status: 'ready' },
          startMs: cue.startMs, endMs: cue.endMs, timelineVisible: true, displayText: `tr-${cue.id}`,
        })) }] };
      if (kind === 'audio') return { audioSources: items.map(item => ({ id: item.id, displayName: item.id })),
        audioClips: items.map(item => ({ ...item, sourceId: item.id,
          sourceStartMs: 0, sourceEndMs: item.endMs - item.startMs, playbackRate: 1 })) };
      return { layers: items.map(item => ({ ...item, kind: kind === 'watermark' ? 'text' : kind,
        watermark: kind === 'watermark', name: item.id, visible: true })) };
    }
    const label = kind === 'translation' ? 'tr-b' : 'b';
    const h = harness({ ...content(ranges), currentMs: 2000 });
    try {
      h.ready();
      const selected = h.findAll('TimedBlock').find(item => item.label === label);
      assert.ok(selected); assert.equal(selected.lane, 1);
      selected.onChangeStart(); h.flush();
      const moved = ranges.map(item => item.id === 'b' ? { ...item, startMs: 5000, endMs: 8000 } : item);
      h.update(content(moved));
      assert.equal(h.findAll('TimedBlock').find(item => item.label === label).lane, 1,
        'the active item must stay under the original finger while crossing a peer start');
      selected.onEnd(); h.flush();
      assert.equal(h.findAll('TimedBlock').find(item => item.label === label).lane, 0,
        'after release, separated items share the frontmost available lane');
      assert.equal(h.timingStarts, 1); assert.equal(h.timingEnds, 1);
      assert.deepEqual(h.seeks, [], 'packing must not seek the shared clock');
    } finally { h.close(); }
  });
}

for (const interruption of ['native cancel', 'resize']) test(`active lane hold ends on ${interruption} through real timing callbacks`, () => {
  const layers = ['a', 'b', 'c'].map((id, i) => ({ id, name: id, kind: 'video', visible: true,
    startMs: i * 500, endMs: 3000 + i * 500 }));
  const h = harness({ layers, currentMs: 2000 });
  try {
    h.ready();
    const item = h.findAll('TimedBlock').find(item => item.label === 'b');
    const pan = h.mountItemPan(item, 'move');
    pan.start();
    const moved = layers.map(item => item.id === 'b' ? { ...item, startMs: 5000, endMs: 8000 } : item);
    h.update({ layers: moved });
    assert.equal(h.findAll('TimedBlock').find(item => item.label === 'b').lane, 1);
    if (interruption === 'native cancel') pan.cancel(); else h.resize(700);
    assert.equal(h.findAll('TimedBlock').find(item => item.label === 'b').lane, 0);
    assert.equal(h.timingStarts, 1); assert.equal(h.timingEnds, 1);
  } finally { h.close(); }
});

test('lane hold is transient, project-scoped, and refreshed for a second edit', () => {
  const layers = ['a', 'b', 'c'].map((id, i) => ({ id, name: id, kind: 'image', visible: true,
    startMs: i * 500, endMs: 3000 + i * 500 }));
  const h = harness({ layers, currentMs: 2000 });
  try {
    h.ready();
    h.findAll('TimedBlock').find(item => item.label === 'b').onChangeStart(); h.flush();
    const moved = layers.map(item => item.id === 'b' ? { ...item, startMs: 5000, endMs: 8000 } : item);
    h.update({ layers: moved });
    h.findAll('TimedBlock').find(item => item.label === 'b').onEnd(); h.flush();
    const second = h.findAll('TimedBlock').find(item => item.label === 'b');
    assert.equal(second.lane, 0);
    second.onChangeStart(); h.flush(); h.update({ layers });
    assert.equal(h.findAll('TimedBlock').find(item => item.label === 'b').lane, 0,
      'second gesture must capture the new resting layout');
    h.update({ projectId: 'replacement' });
    assert.equal(h.findAll('TimedBlock').find(item => item.label === 'b').lane, 1,
      "an old project must not pin another project's layout");
    assert.deepEqual(h.props.layers, layers, 'ephemeral lane state must not enter project data');
  } finally { h.close(); }
});


test('held layer reorder scrolls past the viewport and stops on cancellation', () => {
  const layers = Array.from({ length: 20 }, (_, i) => ({ id: `pip-${i}`, name: `pip-${i}`, kind: 'video',
    visible: true, startMs: 0, endMs: 1000 }));
  const h = harness({ layers, currentMs: 0, onReorderVisualLayer() {} }, { manualIntervals: true });
  const scrolls = [];
  try {
    h.ready();
    const wrappers = h.findAll('TimelineNativeScrollView');
    for (const props of wrappers.filter(p => !p.horizontal)) {
      const target = props.testID ? 2 : 1;
      props.ref.current = { scrollTo: ({ y }) => scrolls.push(y),
        getNativeScrollRef: () => ({ measureInWindow: callback => callback(0, 100, 82, 100) }) };
      props.onLayout({ nativeEvent: { target, layout: { height: 100 } } });
      props.onContentSizeChange(1000, 800); props.onScrollBindingReady();
    }
    const item = h.findAll('TimedBlock').find(item => item.label === 'pip-19');
    item.onTouchLock(true); item.onReorderStart(); h.flush();
    item.onReorderMove(80); h.flush();
    assert.equal(h.intervalCount, 1, 'the actual reorder effect must own edge scrolling');
    const before = scrolls.length;
    h.tickIntervals();
    assert.ok(scrolls.slice(before).some(y => y > 0), 'holding near the bottom must reveal off-screen destinations');
    item.onReorderEnd(true); item.onTouchLock(false); h.flush();
    assert.equal(h.intervalCount, 0, 'cancel must release the timer');
    const ended = scrolls.length; h.tickIntervals(); assert.equal(scrolls.length, ended);
  } finally { h.close(); }
});
