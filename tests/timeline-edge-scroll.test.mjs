import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test, { afterEach } from 'node:test';
import ts from 'typescript';

// Register before initial rendering so assertion failures also retire each host.
const openHarnesses = new Set();
afterEach(() => {
  const failures = [];
  for (const close of [...openHarnesses]) {
    try { close(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'harness cleanup failed');
});

const root = fileURLToPath(new URL('../src/', import.meta.url));
const compiled = new Map();
function code(file) {
  const input = file === resolve(root, 'components/editor/layer-timeline.tsx') && process.env.TIMELINE_RECOVERY_BASELINE
    ? process.env.TIMELINE_RECOVERY_BASELINE : file;
  if (!compiled.has(file)) compiled.set(file, ts.transpileModule(readFileSync(input, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    fileName: file,
  }).outputText + (file === resolve(root, 'components/editor/layer-timeline.tsx')
    ? '\nexports.timingHookForTest = useTimelineTimingPanHandlers; exports.videoGripForTest = VideoMoveGrip;' : ''));
  return compiled.get(file);
}

// Execute the whole LayerTimeline render, its real hooks/callbacks and the
// production command interceptor/controller. Only host layout/clamping and the
// hook scheduler are doubles: these schedules are contracts, not device traces.
function harness(initial = {}, { fullBinding = false, pixelRatio = 1, platform = 'android', manualIntervals = true, ignoreUnchangedScroll = false, autoContentSize = true } = {}) {
  let clock = 1000;
  let closed = false;
  let cursor = 0, dirty = false, tree, effects = [], horizontal, outer, first = true;
  const timeouts = new Set(), liveIntervals = new Set();
  const scheduleTimeout = (fn, delay, ...args) => {
    const timer = setTimeout(() => { timeouts.delete(timer); if (!closed) fn(...args); }, delay);
    timeouts.add(timer); return timer;
  };
  const cancelTimeout = timer => { clearTimeout(timer); timeouts.delete(timer); };
  const scheduleInterval = (fn, delay, ...args) => {
    const timer = setInterval(() => { if (!closed) fn(...args); }, delay);
    liveIntervals.add(timer); return timer;
  };
  const cancelInterval = timer => { clearInterval(timer); liveIntervals.delete(timer); };
  const intervals = new Map(); let intervalSequence = 0;
  let scrubStarts = 0, timingStarts = 0, timingEnds = 0;
  let slots = [];
  const primarySlots = slots, childSlots = [], modules = new Map(), jobs = [], commands = [], seeks = [], changes = [];
  const springSlots = [], rnJobs = [];
  const deviceListeners = new Map();
  const deviceEvents = { addListener(event, listener) {
    deviceListeners.set(listener, event);
    return { remove: () => deviceListeners.delete(listener) };
  } };
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
        if (closed) return;
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
      const previousOffset = native.x;
      native.x = Math.min(Math.max(0, args[0]), Math.max(0, native.content - native.viewport));
      if (ignoreUnchangedScroll && native.x === previousOffset) return;
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
    runInNewContext(code(file), { exports, clearTimeout: cancelTimeout, setTimeout: scheduleTimeout, Date: class extends Date { static now() { return clock; } },
      clearInterval: manualIntervals ? id => intervals.delete(id) : cancelInterval,
      setInterval: manualIntervals ? fn => { intervals.set(++intervalSequence, fn); return intervalSequence; } : scheduleInterval,
      performance: { now: () => clock }, require(id) {
        if (id === 'react') return hooks;
        if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx };
        if (id === 'react-native') return { View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'NativeScrollView',
          StyleSheet: { flatten: style => Object.assign({}, ...[style].flat(Infinity).filter(Boolean)) },
          AppState: appState, DeviceEventEmitter: deviceEvents,
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
  const { LayerTimeline, timingHookForTest, videoGripForTest } = load(resolve(root, 'components/editor/layer-timeline.tsx'));
  const { TimelineNativeScrollView, TimelineNativeGestureView, TimelineNativeGeometryContext } =
    load(resolve(root, 'components/editor/timeline-native-gesture.tsx'));
  const policy = load(resolve(root, 'lib/scroll-spring-policy.ts'));
  const { createScrollSpringController } = load(resolve(root, 'components/scroll-spring-controller.ts'));
  const { interceptSpringScrollCommands } = load(resolve(root, 'components/spring-scroll-gesture.ts'));
  const state = shared({ alive: false, epoch: 0, axis: policy.createScrollSpringAxisState() });
  const node = { scrollTo() { assert.fail('must use production generation guard'); }, scrollToEnd() {},
    getNativeScrollRef: () => node, measureInWindow: callback => callback(0, 0, native.viewport, 200) };
  const controller = fullBinding ? undefined : createScrollSpringController({ state, owner: shared(0), offset: shared(0), id: 1,
    nativeOffset: shared(0), getAnimatedRef: () => () => node, getContentRef: () => () => ({}),
    presentationVersion: shared(0), gesture: gesture() });
  // In fullBinding mode only AndroidSpringScrollView may install/activate the guard.
  node.getInnerViewRef = () => null;
  const restore = fullBinding ? () => {} : interceptSpringScrollCommands(node, () => node, () => native.generation, controller.command);
  if (!fullBinding) controller.activate(1, true);
  function render() {
    if (closed) return;
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
    // A committed host layout emits its new content extent. Entry-race tests
    // opt out and deliver that receipt explicitly through content().
    if (autoContentSize && native.content !== expectedContent()) content();
  }
  function flush(runJobs = true, runRN = true) {
    if (closed) return;
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
  function close() {
    if (closed) return;
    closed = true;
    openHarnesses.delete(close);
    try {
      committedRef?.(null);
      for (const store of [primarySlots, springSlots, ...childSlots]) for (const slot of store) slot?.cleanup?.();
      assert.equal(intervals.size, 0, 'production unmount cleanup must retire every manual interval');
    } finally {
      restore();
      for (const timer of timeouts) clearTimeout(timer);
      for (const timer of liveIntervals) clearInterval(timer);
      timeouts.clear(); liveIntervals.clear(); intervals.clear();
      jobs.length = 0; rnJobs.length = 0; acknowledgements.length = 0; effects.length = 0;
      dirty = false;
    }
  }
  openHarnesses.add(close);
  render(); flush();
  return { native, commands, seeks, changes, flush, layout, content, expectedContent,
    rotate() {
      for (const [listener, event] of [...deviceListeners]) if (event === 'namedOrientationDidChange') {
        listener({ name: 'landscape-primary', rotationDegrees: -90, isLandscape: true });
      }
      flush();
    },
    get deviceListenerCount() { return deviceListeners.size; },
    tickIntervals() { clock += 16; for (const fn of [...intervals.values()]) fn(); flush(); },
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
    get marker() {
      const found = [];
      function walk(element) {
        if (!element?.props) return;
        const style = Object.assign({}, ...[element.props.style].flat(Infinity).filter(Boolean));
        if (style.backgroundColor === '#FF5267' && style.width === 2) found.push(style);
        for (const child of [element.props.children].flat(Infinity)) walk(child);
      }
      walk(tree);
      assert.equal(found.length, 1, 'rendered pink playhead line');
      const style = found[0];
      return { ...style, x: (style.left === '50%' ? native.viewport / 2 : style.left) + style.marginLeft + style.width / 2 };
    },
    get trackOrigin() {
      const container = horizontal.props.children;
      const ruler = this.find('TimelineRuler');
      return container.props.style.marginLeft + container.props.style.width - ruler.trackWidth - native.viewport / 2;
    },
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
    discardAcknowledgements() { acknowledgements.length = 0; },
    releaseAcknowledgements() { holdAcknowledgements = false; },
    mountItemPan(owner, edge = 'move', video = false) {
      TimelineNativeGeometryContext.value = geometry;
      function mount(fn) {
        const store = []; childSlots.push(store); slots = store; cursor = 0;
        const result = fn();
        while (effects.length) effects.shift()();
        slots = primarySlots;
        return result;
      }
      const timing = mount(() => video ? videoGripForTest({ ...owner, bodyLeft: 0, bodyWidth: 72 }).props : timingHookForTest(owner, edge, owner.onTouchLock));
      const handlers = timing.panHandlers ?? timing;
      const wrapper = mount(() => TimelineNativeGestureView({ nativeCallbacks: timing.nativeCallbacks, panHandlers: handlers }));
      const pan = wrapper.props.gesture.handlers, calls = [];
      const manager = { activate: () => calls.push('activate'), fail: () => calls.push('fail') };
      const event = x => ({ numberOfTouches: 1, allTouches: [{ absoluteX: x, absoluteY: 10 }] });
      flush();
      return { calls,
        start(reorder = false) {
          if (platform !== 'android') { handlers.onStartShouldSetResponderCapture?.({ nativeEvent: { touches: [{}] } }); handlers.onResponderGrant?.({ nativeEvent: { touches: [{}] } }); flush(); return; }
          pan.onTouchesDown(event(100), manager); flush(); if (reorder) clock += 400;
          pan.onTouchesMove(event(109), manager);
          pan.onStart({ absoluteX: 109, absoluteY: 10, numberOfPointers: 1 }); flush();
        },
        move(x) {
          if (platform !== 'android') handlers.onResponderMove({ nativeEvent: { touches: [{ pageX: x, pageY: 10 }], pageX: x, pageY: 10 } });
          else pan.onUpdate({ absoluteX: x, absoluteY: 10, numberOfPointers: 1 }); flush();
        },
        finish(x) { pan.onEnd({ absoluteX: x, absoluteY: 10, numberOfPointers: 1 }, true); pan.onFinalize(); flush(); },
        cancel() { pan.onTouchesCancelled(event(109), manager); flush(); },
        secondTouch() { pan.onTouchesDown({ ...event(360), numberOfTouches: 2 }, manager); flush(); },
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
    close,
  };
}

function cueHarness() {
  const h = harness({ durationMs: 120000, currentMs: 0, selectedLayerId: 'captions', selectedCaptionId: 'held',
    layers: [{ id: 'captions', kind: 'captions' }],
    captions: [{ id: 'held', text: 'held cue', startMs: 1000, endMs: 2000 }],
    onSelectCaption() {},
  });
  h.ready();
  const owner = h.find('TimedBlock');
  return { h, owner, pan: h.mountItemPan(owner) };
}

function tick(h, count = 60) { for (let i = 0; i < count; i++) h.tickIntervals(); }

for (const direction of [-1, 1]) {
  test(`held marker follows acknowledged edge scroll exactly in direction ${direction}`, () => {
    const h = harness({ durationMs: 120000, currentMs: 60000, selectedLayerId: 'captions', selectedCaptionId: 'held',
      layers: [{ id: 'captions', kind: 'captions' }],
      captions: [{ id: 'held', text: 'held cue', startMs: 60000, endMs: 61000 }], onSelectCaption() {},
    }, { fullBinding: true });
    try {
      h.ready();
      const owner = h.find('TimedBlock'), pan = h.mountItemPan(owner), edge = direction === 1 ? 360 : 0;
      const clockOffset = h.native.x;
      assert.equal(h.marker.x, 180);
      pan.start(); pan.move(edge);
      const before = h.marker.x, offset = h.native.x, commands = h.commands.length;
      h.holdAcknowledgements(); tick(h, 3);
      assert.ok(h.commands.length > commands, 'real spring binding dispatches edge command');
      assert.equal(h.marker.x, before, 'unacknowledged command cannot move marker');
      h.acknowledge();
      const delta = h.native.x - offset;
      assert.ok(delta * direction > 0, 'receipt changes the offset in the requested direction');
      assert.ok(Math.abs(h.marker.x - (before - delta)) < 1e-6, 'marker moves by exactly the acknowledged pixel delta');
      const liveOwner = h.find('TimedBlock');
      assert.equal(liveOwner.playheadMs, 60000, 'snap clock remains fixed during hold');
      assert.ok(liveOwner.getFeedbackBoundaries().includes(60000), 'haptic boundary shares that clock');
      assert.ok(Math.abs(h.marker.x - (h.trackOrigin + liveOwner.playheadMs / liveOwner.durationMs * liveOwner.trackWidth - h.native.x)) < 1e-6,
        'rendered marker identifies the same track time as snapping and feedback');
      assert.equal(h.props.currentMs, 60000); assert.deepEqual(h.seeks, []); assert.equal(h.scrubStarts, 0);
      h.releaseAcknowledgements(); pan.finish(edge);
      assert.equal(h.marker.left, '50%', 'release restores original centered presentation');
      assert.equal(h.marker.x, 180); assert.equal(h.native.x, clockOffset, 'release follows the unchanged clock');
      h.update({ currentMs: 62000 });
      assert.equal(h.marker.x, 180); assert.ok(h.native.x > clockOffset, 'ordinary clock follow still scrolls');
      h.horizontal.onScrollBeginDrag();
      h.horizontal.onScroll({ nativeEvent: { contentOffset: { x: h.native.x + 16 }, layoutMeasurement: { width: 360 }, contentSize: { width: h.native.content } } });
      h.flush();
      assert.equal(h.marker.left, '50%', 'ordinary scrubbing retains centered marker');
      assert.equal(h.scrubStarts, 1); assert.equal(h.seeks.length, 1, 'only the explicit scrub seeks');
    } finally { h.close(); }
  });
}

test('generation-rejected edge commands leave the held marker at its acknowledged location', () => {
  const { h, pan } = cueHarness();
  try {
    pan.start(); pan.move(360);
    const before = h.marker.x, commands = h.commands.length;
    h.rejectNextCommand(); tick(h, 3);
    assert.equal(h.commands.length, commands, 'production generation guard rejects dispatch');
    assert.equal(h.marker.x, before);
    h.activate(); tick(h, 3);
    assert.ok(h.native.x > 0);
    assert.ok(Math.abs(h.marker.x - (before - h.native.x)) < 1e-6, 'accepted receipts resume marker movement');
    assert.deepEqual(h.seeks, []);
  } finally { h.close(); }
});

test('native held cue at the right edge keeps moving through actual scroll acknowledgements without another pointer event', () => {
  const { h, owner, pan } = cueHarness();
  try {
    pan.start(); pan.move(360);
    const start = h.changes.at(-1)[2], offset = h.native.x;
    tick(h);
    assert.ok(h.native.x > offset, 'stationary edge hold must dispatch real horizontal scroll commands');
    assert.ok(h.changes.at(-1)[2] > start, 'acknowledged scrolling must move the held item');
    assert.ok(Math.abs((h.changes.at(-1)[2] - start) - (h.native.x - offset) * owner.durationMs / owner.trackWidth) < 1e-6,
      'timing uses the frozen drag scale and actual native scroll delta exactly once');
    assert.equal(h.timingStarts, 1); assert.equal(h.scrubStarts, 0); assert.deepEqual(h.seeks, []);
    assert.ok(h.findAll('TimedBlock').some(item => item.label === 'held cue'), 'active owner survives virtualization');
    pan.finish(360); assert.equal(h.timingEnds, 1);
  } finally { h.close(); }
});

test('edge speed increases toward the physical edge and stops in the center', () => {
  const distance = x => {
    const { h, pan } = cueHarness();
    try { pan.start(); pan.move(x); const offset = h.native.x; tick(h); return h.native.x - offset; }
    finally { h.close(); }
  };
  const inner = distance(310), outer = distance(340), edge = distance(360), beyond = distance(400);
  assert.ok(inner > 0 && outer > inner && edge > outer, 'inner band offers precision; edge gives maximum speed');
  assert.equal(beyond, edge, 'pointer beyond the edge stays capped at maximum speed');
  assert.equal(distance(200), 0, 'center drag never starts automatic scrolling');
});

test('unacknowledged scroll commands cannot move timing or visible bounds', () => {
  const { h, pan } = cueHarness();
  try {
    pan.start(); pan.move(360); h.holdAcknowledgements();
    const requested = h.changes.at(-1)[2], range = h.find('TimelineRuler').visibleStartMs, count = h.commands.length;
    tick(h, 10);
    assert.ok(h.commands.length > count, 'edge hold requests native scroll');
    assert.equal(h.changes.at(-1)[2], requested, 'dispatch alone cannot move the draft');
    assert.equal(h.find('TimelineRuler').visibleStartMs, range, 'dispatch alone cannot move virtualization');
    h.acknowledge();
    assert.ok(h.changes.at(-1)[2] > requested, 'native receipt advances the draft');
  } finally { h.close(); }
});

for (const interrupt of ['cancel', 'blur', 'rotation', 'resize', 'unmount']) {
  test(`held edge scroll stops after ${interrupt}`, () => {
    const { h, pan } = cueHarness();
    try {
      pan.start(); pan.move(360); tick(h, 10);
      assert.ok(h.native.x > 0, 'exercise a running edge scroll before interruption');
      if (interrupt === 'cancel') pan.cancel();
      else if (interrupt === 'blur') h.blur();
      else if (interrupt === 'rotation') h.rotate();
      else if (interrupt === 'resize') h.resize(800);
      else h.close();
      const commands = h.commands.length, changes = h.changes.length;
      tick(h, 30);
      assert.equal(h.commands.length, commands); assert.equal(h.changes.length, changes);
    } finally { h.close(); }
  });
}

test('main-video long-press reorder reaches both ends without releasing the same held drag', () => {
  const clips = Array.from({ length: 40 }, (_, i) => ({ id: `clip-${i}`, sourceId: 'source',
    sourceStartMs: 0, sourceEndMs: 1000, availableSourceStartMs: 0, availableSourceEndMs: 1000, playbackRate: 1 }));
  const commits = [];
  const h = harness({ durationMs: 40000, currentMs: 0, clips, selectedClipId: 'clip-0', onSelectClip() {},
    onReorderClip: (...args) => commits.push(args),
  });
  try {
    h.ready(); const pan = h.mountItemPan(h.findAll('VideoClipBlock').find(item => item.clip.id === 'clip-0'), 'move', true);
    pan.start(true); pan.move(360); tick(h, 900);
    const active = h.findAll('VideoClipBlock').find(item => item.clip.id === 'clip-0');
    assert.equal(active.clipIndex, 39, 'reorder progression includes acknowledged scroll, rather than dx alone');
    assert.equal(active.reordering, true); assert.deepEqual(h.seeks, []);
    assert.equal(h.marker.left, '50%', 'equal-width reorder tiles are not a linear time track');
    assert.equal(h.marker.x, 180, 'filmstrip preserves the ordinary centered presentation');
    pan.move(0); tick(h, 900);
    assert.equal(h.findAll('VideoClipBlock').find(item => item.clip.id === 'clip-0').clipIndex, 0,
      'the same held drag can travel all the way back to the beginning');
    pan.finish(0);
    assert.equal(commits.length, 1, 'release commits exactly one reorder');
    assert.equal(commits[0][1], 0);
  } finally { h.close(); }
});

for (const kind of ['video', 'image', 'text', 'watermark', 'audio', 'translation']) {
  test(`${kind} body uses the shared held-edge movement path`, () => {
    const id = 'held';
    const shared = { durationMs: 120000, currentMs: 0, onSelectLayer() {}, onSelectAudioClip() {}, onSelectCaption() {}, onSelectTranslationCaption() {} };
    const initial = kind === 'audio' ? { selectedAudioClipId: id,
      audioClips: [{ id, sourceId: 'audio', startMs: 1000, sourceStartMs: 0, sourceEndMs: 1000, playbackRate: 1 }],
    } : kind === 'translation' ? { selectedLayerId: 'translated', selectedCaptionId: id, layers: [{ id: 'captions', kind: 'captions' }],
      translationTracks: [{ id: 'translated', name: 'translated', visible: true,
        pairs: [{ source: { id, text: 'source', startMs: 1000, endMs: 2000 },
          translation: { id: 'translated-held', status: 'complete' }, displayText: 'held',
          startMs: 1000, endMs: 2000, timelineVisible: true }] }],
    } : { selectedLayerId: id, layers: [{ id, kind: kind === 'watermark' ? 'text' : kind, watermark: kind === 'watermark', text: 'held', name: 'held', startMs: 1000, endMs: 2000,
      uri: 'file:///fixture', sourceStartMs: 0, sourceDurationMs: 1000, playbackRate: 1 }] };
    const h = harness({ ...shared, ...initial });
    try {
      h.ready(); const pan = h.mountItemPan(h.find('TimedBlock'));
      pan.start(); pan.move(360); const time = h.changes.at(-1)[2];
      tick(h);
      assert.ok(h.changes.at(-1)[2] > time, `${kind} movement continues without another pointer event`);
      assert.equal(h.timingStarts, 1); assert.deepEqual(h.seeks, []);
    } finally { h.close(); }
  });
}

for (const interruption of ['second touch', 'project switch']) {
  test(`held edge owner retires on ${interruption} and rejects late samples`, () => {
    const { h, pan } = cueHarness();
    try {
      pan.start(); pan.move(360); tick(h, 10);
      assert.ok(h.native.x > 0, 'interrupt an active edge-scroll session');
      if (interruption === 'second touch') pan.secondTouch();
      else h.update({ projectId: 'replacement-project' });
      const count = h.changes.length, commands = h.commands.length;
      pan.move(360); tick(h, 30);
      assert.equal(h.changes.length, count, 'retired contact cannot edit the current project');
      assert.equal(h.commands.length, commands, 'retired contact cannot resume edge scrolling');
    } finally { h.close(); }
  });
}

function entryHarness(options = {}) {
  const clips = Array.from({ length: 40 }, (_, i) => ({ id: `clip-${i}`, sourceId: 'source',
    sourceStartMs: 0, sourceEndMs: 1000, availableSourceStartMs: 0, availableSourceEndMs: 1000, playbackRate: 1 }));
  const h = harness({ durationMs: 40000, currentMs: 20000, clips, selectedClipId: 'clip-20', onSelectClip() {} }, { autoContentSize: false, ...options });
  h.ready();
  const pan = h.mountItemPan(h.findAll('VideoClipBlock').find(item => item.clip.id === 'clip-20'), 'move', true);
  const index = () => h.findAll('VideoClipBlock').find(item => item.clip.id === 'clip-20').clipIndex;
  return { h, pan, index };
}

test('filmstrip entry clamped against old native content retries after delayed geometry without moving the draft invisibly', () => {
  const { h, pan, index } = entryHarness();
  try {
    pan.start(true); pan.move(360);
    const before = index(), commands = h.commands.length;
    assert.ok(h.expectedContent() > h.native.content, 'filmstrip layout receipt is deliberately delayed');
    tick(h, 30);
    assert.equal(h.commands.length, commands, 'unready native geometry cannot be used for edge commands');
    assert.equal(index(), before);
    h.content(); h.flush();
    tick(h, 180);
    assert.ok(index() > before, 'real entry ACK establishes the origin and stationary scrolling resumes');
  } finally { h.close(); }
});

test('filmstrip entry rejected by a retired spring binding retries after accepted readiness', () => {
  const { h, pan, index } = entryHarness();
  try {
    h.rejectNextCommand(); pan.start(true); pan.move(360);
    h.content(); h.flush();
    const before = index(), commands = h.commands.length;
    tick(h, 30);
    assert.equal(h.commands.length, commands, 'the real generation guard rejects the initial entry and retries');
    assert.equal(index(), before, 'rejected commands do not advance the reorder draft');
    h.activate(); h.bindingReady(); tick(h, 180);
    assert.ok(index() > before, 'an accepted binding recovers the same held drag without another pointer event');
  } finally { h.close(); }
});

test('filmstrip entry recovers a lost initial target ACK when native suppresses unchanged-offset scroll events', () => {
  const { h, pan, index } = entryHarness({ ignoreUnchangedScroll: true });
  try {
    h.holdAcknowledgements(); pan.start(true); pan.move(360);
    h.content(); h.flush(); tick(h, 1);
    const before = index();
    // Native reached the requested entry target, but that receipt was lost.
    // Reissuing the identical scrollTo cannot synthesize an onScroll event.
    h.discardAcknowledgements(); h.releaseAcknowledgements();
    tick(h, 180);
    assert.ok(index() > before, 'stationary held edge must recover via a real changed-offset receipt');
  } finally { h.close(); }
});
