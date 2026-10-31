import type { HostInstance, ScrollView } from 'react-native';
import type { NativeGesture } from 'react-native-gesture-handler';
import { cancelAnimation, setNativeProps, withSpring, type AnimatedRef, type SharedValue } from 'react-native-reanimated';
import { beginScrollSpringDrag, releaseScrollSpringDrag, resetScrollSpringAxis,
  updateScrollSpringDrag, type ScrollSpringAxisState } from '../lib/scroll-spring-policy';
import { dispatchSpringScrollCommand } from './spring-scroll-gesture';
import { SCROLL_SPRING_PROBE_ENABLED, traceScrollSpringProbe } from './scroll-spring-probe';

export type ScrollSpringRuntimeState = {
  alive: boolean;
  epoch: number;
  safe: boolean;
  contentReady: boolean;
  enabled: boolean;
  canOwn: boolean;
  horizontal: boolean;
  reduced: boolean;
  motionReady: boolean;
  foreground: boolean;
  nativeActive: boolean;
  active: boolean;
  owned: boolean;
  pending: boolean;
  blocked: boolean;
  released: boolean;
  touches: number;
  startX: number;
  startY: number;
  pointer: number;
  viewport: number;
  content: number;
  lastOffset: number;
  lastOffsetAt: number;
  fling: boolean;
  axis: ScrollSpringAxisState;
};

export type ScrollSpringControllerOptions = {
  state: SharedValue<ScrollSpringRuntimeState>;
  owner: SharedValue<number>;
  offset: SharedValue<number>;
  id: number;
  nativeOffset: SharedValue<number>;
  animatedRef: AnimatedRef<ScrollView>;
  contentRef: AnimatedRef<HostInstance>;
  presentationVersion: SharedValue<number>;
  gesture: NativeGesture;
};

type NativeHandlers = NativeGesture['handlers'];
type NativeBinding = { original: NativeHandlers; observed: NativeHandlers };
const nativeBindings = new WeakMap<NativeGesture, NativeBinding>();

function applyNativeCallbacks(target: NativeHandlers, source: NativeHandlers) {
  // GestureDetector owns handlerTag and other runtime metadata. Restore only
  // callback definitions and their worklet flags, never the snapshot's identity.
  for (const key of ['onTouchesDown', 'onTouchesMove', 'onTouchesUp', 'onTouchesCancelled', 'onStart', 'onFinalize'] as const) {
    if (source[key]) Object.assign(target, { [key]: source[key] });
    else delete target[key];
  }
  target.isWorklet = [...source.isWorklet];
}

/** Configures Native callback definitions on JS; all mutable runtime work is UI-only. */
export function createScrollSpringController(options: ScrollSpringControllerOptions) {
  const { state, owner, offset, id, nativeOffset, animatedRef, contentRef, presentationVersion, gesture } = options;

  function trace(event: string, s: ScrollSpringRuntimeState, extra = 0) {
    'worklet';
    if (!SCROLL_SPRING_PROBE_ENABLED) return;
    traceScrollSpringProbe(event, id, { epoch: s.epoch, alive: s.alive, ready: s.contentReady,
      enabled: s.enabled, canOwn: s.canOwn, nativeActive: s.nativeActive, active: s.active,
      pending: s.pending, released: s.released, owner: owner.value, offset: offset.value,
      viewport: s.viewport, content: s.content, touches: s.touches, motionReady: s.motionReady,
      reduced: s.reduced, foreground: s.foreground, extra });
  }

  // Private helpers receive the state owned by the current modify boundary.
  // They never reenter state.modify, including synchronous animation completion.
  function resetOwned(s: ScrollSpringRuntimeState) {
    'worklet';
    trace('reset', s);
    s.nativeActive = false; s.active = false; s.owned = false; s.pending = false; s.fling = false;
    resetScrollSpringAxis(s.axis);
    if (owner.value === id) {
      cancelAnimation(offset); offset.value = 0; owner.value = 0;
    }
  }

  function allowed(s: ScrollSpringRuntimeState) {
    'worklet';
    return s.alive && s.safe && s.contentReady && s.enabled && s.canOwn && s.motionReady && !s.reduced && s.foreground &&
      Number.isFinite(s.viewport) && s.viewport > 0 && Number.isFinite(s.content) && s.content >= 0;
  }

  function normalizedOffset(s: ScrollSpringRuntimeState) {
    'worklet';
    const range = Math.max(0, s.content - s.viewport);
    const value = nativeOffset.value;
    // Normalize floating point noise without treating interior travel as pull.
    return Math.abs(value) < 0.001 ? 0 : Math.abs(value - range) < 0.001 ? range : value;
  }

  function acquire(s: ScrollSpringRuntimeState) {
    'worklet';
    if (!allowed(s) || !s.nativeActive || s.blocked || s.touches !== 1 || !s.pending) return;
    s.active = true; s.owned = true; owner.value = id; cancelAnimation(offset);
    const accepted = beginScrollSpringDrag(s.axis, {
      pointerDp: s.pointer, timeMs: performance.now(), viewportDp: s.viewport,
      offsetDp: normalizedOffset(s), rangeDp: Math.max(0, s.content - s.viewport),
      nativeActive: s.nativeActive, scrollEnabled: s.enabled, touchCount: 1, dominantAxis: true, reducedMotion: s.reduced,
    }, offset.value);
    if (!accepted) offset.value = 0;
  }

  function spring(s: ScrollSpringRuntimeState, velocity: number, fromMomentum = false) {
    'worklet';
    trace('spring-before', s, velocity);
    if (!allowed(s) || owner.value !== id) return;
    if (offset.value === 0 && !fromMomentum) return;
    const cap = Math.min(96, s.viewport / 4);
    // Bound release energy as well as speed to cap the outward excursion.
    const maxVelocity = Math.min(3200, Math.sqrt(200 * Math.max(0, cap * cap - offset.value * offset.value)));
    const boundedVelocity = Number.isFinite(velocity) ? Math.max(-maxVelocity, Math.min(maxVelocity, velocity)) : 0;
    const generation = s.epoch;
    s.fling = false;
    trace('spring-start', s, boundedVelocity);
    // Force initialization even at zero: valueSetter otherwise completes a
    // same-target spring before onStart can consume its momentum velocity.
    offset.modify(() => {
      'worklet';
      return withSpring(0, { mass: 1, stiffness: 200, damping: 24, velocity: boundedVelocity }, finished => {
        'worklet';
        trace('spring-complete', state.value, finished ? 1 : 0);
        // Completion may run inside this state transaction. Read current state
        // without modifying it; owner is authoritative even if owned stays true
        // until the next touch/reset clears that local bookkeeping flag.
        if (!finished) return;
        const current = state.value;
        if (current.epoch === generation && owner.value === id && !current.active) {
          offset.value = 0; owner.value = 0;
        }
      });
    }, true);
  }

  function reset() {
    'worklet';
    state.modify(s => {
      'worklet';
      resetOwned(s);
      return s;
    });
  }

  const original = nativeBindings.get(gesture)?.original ?? { ...gesture.handlers, isWorklet: [...gesture.handlers.isWorklet] };
  // No shared-value access, clock reads, or UI effects occur during creation.
  // Child gesture relations retain the exact Native instance supplied by React.
  gesture.onTouchesDown((event, manager) => {
    'worklet';
    original.onTouchesDown?.(event, manager);
    state.modify(s => {
      'worklet';
      trace('down', s, event.numberOfTouches);
      if (event.numberOfTouches !== 1) { s.blocked = true; resetOwned(s); return s; }
      const touch = event.allTouches[0];
      if (!touch) return s;
      s.touches = 1; s.pending = true; s.blocked = false; s.released = false;
      s.active = false; s.owned = false; s.fling = false;
      s.startX = touch.absoluteX; s.startY = touch.absoluteY;
      s.pointer = s.horizontal ? touch.absoluteX : touch.absoluteY;
      resetScrollSpringAxis(s.axis);
      if (owner.value === id) cancelAnimation(offset);
      // shouldActivateOnStart may send ACTIVE before the first DOWN payload.
      acquire(s);
      return s;
    });
  }).onStart(event => {
    'worklet';
    original.onStart?.(event);
    state.modify(s => {
      'worklet';
      trace('start', s);
      s.nativeActive = true; acquire(s);
      return s;
    });
  }).onTouchesMove((event, manager) => {
    'worklet';
    original.onTouchesMove?.(event, manager);
    state.modify(s => {
      'worklet';
      if (!s.active || !s.owned) return s;
      if (!allowed(s) || owner.value !== id || event.numberOfTouches !== 1 || s.blocked) { resetOwned(s); return s; }
      const touch = event.allTouches[0];
      if (!touch) { resetOwned(s); return s; }
      const dx = Math.abs(touch.absoluteX - s.startX), dy = Math.abs(touch.absoluteY - s.startY);
      s.pointer = s.horizontal ? touch.absoluteX : touch.absoluteY;
      offset.value = updateScrollSpringDrag(s.axis, {
        pointerDp: s.pointer, timeMs: performance.now(), viewportDp: s.viewport,
        offsetDp: normalizedOffset(s), rangeDp: Math.max(0, s.content - s.viewport),
        nativeActive: s.nativeActive, scrollEnabled: s.enabled, touchCount: event.numberOfTouches,
        dominantAxis: s.horizontal ? dx >= dy : dy >= dx, reducedMotion: s.reduced,
      });
      trace('move', s);
      return s;
    });
  }).onTouchesUp((event, manager) => {
    'worklet';
    original.onTouchesUp?.(event, manager);
    state.modify(s => {
      'worklet';
      trace('up', s, event.numberOfTouches);
      // A successful zero-touch Up must preserve release position and velocity.
      s.touches = event.numberOfTouches;
      return s;
    });
  }).onTouchesCancelled((event, manager) => {
    'worklet';
    original.onTouchesCancelled?.(event, manager);
    state.modify(s => {
      'worklet';
      trace('cancel', s);
      s.nativeActive = false;
      if (s.active || s.pending) {
        if (owner.value === id && offset.value !== 0 && allowed(s)) {
          s.active = false; s.pending = false; s.released = true; s.fling = false;
          resetScrollSpringAxis(s.axis); spring(s, 0);
        } else resetOwned(s);
      }
      return s;
    });
  }).onFinalize((event, success) => {
    'worklet';
    original.onFinalize?.(event, success);
    state.modify(s => {
      'worklet';
      trace('finalize', s, success ? 1 : 0);
      s.nativeActive = false;
      if (s.released) return s;
      const pending = s.pending;
      s.pending = false;
      // A tap or another winning recognizer resumes recoil from its held point.
      if ((!s.active || !success) && pending && owner.value === id && offset.value !== 0 && allowed(s)) {
        s.active = false; s.released = true; s.fling = false;
        resetScrollSpringAxis(s.axis); spring(s, 0); return s;
      }
      if (!success || !s.active || !s.owned || !allowed(s)) { resetOwned(s); return s; }
      s.released = true;
      const now = performance.now();
      const velocity = releaseScrollSpringDrag(s.axis, now);
      s.active = false; s.fling = true; s.lastOffset = nativeOffset.value; s.lastOffsetAt = now;
      spring(s, velocity);
      return s;
    });
  });
  const binding: NativeBinding = {
    original, observed: { ...gesture.handlers, isWorklet: [...gesture.handlers.isWorklet] },
  };
  // Retain the true originals even if React retries factory creation before
  // mounting. This is JS callback metadata, with no shared-state/UI effects.
  nativeBindings.set(gesture, binding);

  function mountBinding() {
    applyNativeCallbacks(gesture.handlers, binding.observed);
    nativeBindings.set(gesture, binding);
  }

  function unmountBinding() {
    if (nativeBindings.get(gesture) !== binding) return;
    applyNativeCallbacks(gesture.handlers, binding.original);
    nativeBindings.delete(gesture);
  }

  function activate(generation: number, safe: boolean) {
    'worklet';
    state.modify(s => {
      'worklet';
      if (generation < s.epoch) return s;
      s.epoch = generation; s.alive = true; s.safe = safe;
      trace('activate', s);
      presentationVersion.value++;
      return s;
    });
  }

  function deactivate(generation: number) {
    'worklet';
    state.modify(s => {
      'worklet';
      if (generation < s.epoch) return s;
      trace('deactivate', s);
      if (s.contentReady) setNativeProps(contentRef, { transform: [] });
      s.contentReady = false;
      s.epoch = generation; s.alive = false; s.safe = false; resetOwned(s);
      presentationVersion.value++;
      return s;
    });
  }

  function contentReady(generation: number) {
    'worklet';
    state.modify(s => {
      'worklet';
      if (s.epoch !== generation || !s.alive) return s;
      s.contentReady = true; presentationVersion.value++;
      trace('content-ready', s);
      return s;
    });
  }

  function updateOptions(enabled: boolean, canOwn: boolean, horizontal: boolean) {
    'worklet';
    state.modify(s => {
      'worklet';
      const axisChanged = s.horizontal !== horizontal;
      s.enabled = enabled; s.canOwn = canOwn; s.horizontal = horizontal;
      trace('options', s);
      if (!enabled || !canOwn || axisChanged) resetOwned(s);
      presentationVersion.value++;
      return s;
    });
  }

  function setReduced(generation: number, value: boolean) {
    'worklet';
    state.modify(s => {
      'worklet';
      if (!s.alive || s.epoch !== generation) return s;
      s.motionReady = true; s.reduced = value;
      trace('reduced', s);
      if (value) resetOwned(s);
      presentationVersion.value++;
      return s;
    });
  }

  function setForeground(generation: number, value: boolean) {
    'worklet';
    state.modify(s => {
      'worklet';
      if (!s.alive || s.epoch !== generation) return s;
      s.foreground = value;
      trace('foreground', s);
      if (!value) resetOwned(s);
      presentationVersion.value++;
      return s;
    });
  }

  function updateGeometry(viewport: number | null, content: number | null) {
    'worklet';
    state.modify(s => {
      'worklet';
      if ((viewport != null && viewport !== s.viewport) || (content != null && content !== s.content)) {
        trace('geometry', s);
        resetOwned(s);
        if (viewport != null) s.viewport = viewport;
        if (content != null) s.content = content;
      }
      return s;
    });
  }

  function command(generation: number, name: string, args: (number | boolean)[]) {
    'worklet';
    if (!state.value.alive || state.value.epoch !== generation) return;
    reset();
    dispatchSpringScrollCommand(animatedRef, name, args);
  }

  function onNativeOffset(value: number, previous: number | null) {
    'worklet';
    state.modify(s => {
      'worklet';
      if (!s.owned || !allowed(s) || owner.value !== id) return s;
      trace('native-offset', s, value);
      const now = performance.now();
      const dt = now - s.lastOffsetAt;
      if (s.fling && !s.active) {
        // A delayed scroll cannot inherit old touch ownership. Commands revoke it
        // before dispatch; ordinary native flings continue without intervention.
        if (dt <= 0 || dt > 100) { resetOwned(s); return s; }
        const delta = value - (previous ?? s.lastOffset);
        const range = Math.max(0, s.content - s.viewport);
        const edge = normalizedOffset(s);
        if ((edge === 0 && delta < 0) || (range > 0 && edge === range && delta > 0)) {
          spring(s, -delta * 1000 / dt, true);
        }
      }
      s.lastOffset = value; s.lastOffsetAt = now;
      return s;
    });
  }

  function present() {
    'worklet';
    const s = state.value;
    const presented = offset.value;
    trace('present', s);
    if (!s.alive || !s.contentReady) return;
    const value = s.motionReady && !s.reduced && s.foreground && s.enabled ? presented : 0;
    // Reanimated forwards flattened props, unlike RN instance.setNativeProps.
    setNativeProps(contentRef, { transform: [s.horizontal ? { translateX: value } : { translateY: value }] });
  }

  return { gesture, mountBinding, unmountBinding, reset, activate, deactivate, contentReady,
    updateOptions, setReduced, setForeground, updateGeometry, command, onNativeOffset, present };
}
