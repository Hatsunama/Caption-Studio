import type { HostInstance, ScrollView } from 'react-native';
import type { NativeGesture } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';
import { cancelAnimation, ReduceMotion, setNativeProps, withSpring, type AnimatedRef, type SharedValue } from 'react-native-reanimated';
import { beginScrollSpringDrag, releaseScrollSpringDrag, resetScrollSpringAxis,
  updateScrollSpringDrag, type ScrollSpringAxisState } from '../lib/scroll-spring-policy';
import { dispatchSpringScrollCommand } from './spring-scroll-gesture';

// The UI worklet runtime supplies this monotonic clock. Native-only consumers
// must not need Expo or DOM ambient types to describe that existing contract.
declare const performance: { now(): number };

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
  getAnimatedRef: () => AnimatedRef<ScrollView>;
  getContentRef: () => AnimatedRef<HostInstance>;
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
  const { state, owner, offset, id, nativeOffset, getAnimatedRef, getContentRef, presentationVersion, gesture } = options;

  // TEMPORARY synthetic-only numeric diagnostics; remove once the trace is classified.
  // CS_SCROLL_DIAG tuples contain fixed event/verdict labels and numeric/boolean fields only.
  // Private helpers receive the state owned by the current modify boundary.
  // They never reenter state.modify, including synchronous animation completion.
  function resetOwned(s: ScrollSpringRuntimeState) {
    'worklet';
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
    if (!allowed(s) || owner.value !== id) return;
    if (offset.value === 0 && !fromMomentum) return;
    const cap = Math.min(96, s.viewport / 4);
    // Bound release energy as well as speed to cap the outward excursion.
    const maxVelocity = Math.min(3200, Math.sqrt(200 * Math.max(0, cap * cap - offset.value * offset.value)));
    const boundedVelocity = Number.isFinite(velocity) ? Math.max(-maxVelocity, Math.min(maxVelocity, velocity)) : 0;
    const generation = s.epoch;
    s.fling = false;
    // Force initialization even at zero: valueSetter otherwise completes a
    // same-target spring before onStart can consume its momentum velocity.
    offset.modify(() => {
      'worklet';
      // allowed() uses live accessibility state; the engine's System default
      // can still reflect reduced motion cached at startup after a live change.
      return withSpring(0, { mass: 1, stiffness: 200, damping: 24, velocity: boundedVelocity, reduceMotion: ReduceMotion.Never }, finished => {
        'worklet';
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

  function reset(generation: number) {
    'worklet';
    state.modify(s => {
      'worklet';
      if (!s.alive || s.epoch !== generation) return s;
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
      console.info?.('CS_SCROLL_DIAG', 'nativeDown', Date.now(), id, s.epoch, s.alive, s.horizontal, nativeOffset.value, owner.value, s.nativeActive, s.active, s.owned, s.pending, s.blocked, s.released, s.touches, event.numberOfTouches);
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
      console.info?.('CS_SCROLL_DIAG', 'nativeStart', Date.now(), id, s.epoch, s.alive, s.horizontal, nativeOffset.value, owner.value, s.nativeActive, s.active, s.owned, s.pending, s.blocked, s.released, s.touches);
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
      return s;
    });
  }).onTouchesUp((event, manager) => {
    'worklet';
    original.onTouchesUp?.(event, manager);
    state.modify(s => {
      'worklet';
      console.info?.('CS_SCROLL_DIAG', 'nativeUp', Date.now(), id, s.epoch, s.alive, s.horizontal, nativeOffset.value, owner.value, s.nativeActive, s.active, s.owned, s.pending, s.blocked, s.released, s.touches, event.numberOfTouches);
      // A successful zero-touch Up must preserve release position and velocity.
      s.touches = event.numberOfTouches;
      return s;
    });
  }).onTouchesCancelled((event, manager) => {
    'worklet';
    original.onTouchesCancelled?.(event, manager);
    state.modify(s => {
      'worklet';
      console.info?.('CS_SCROLL_DIAG', 'nativeCancel', Date.now(), id, s.epoch, s.alive, s.horizontal, nativeOffset.value, owner.value, s.nativeActive, s.active, s.owned, s.pending, s.blocked, s.released, s.touches, event.numberOfTouches);
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
      console.info?.('CS_SCROLL_DIAG', 'nativeFinalize', Date.now(), id, s.epoch, s.alive, s.horizontal, nativeOffset.value, owner.value, s.nativeActive, s.active, s.owned, s.pending, s.blocked, s.released, s.touches, success);
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

  function activate(generation: number, safe: boolean, onReady?: (generation: number) => void) {
    'worklet';
    state.modify(s => {
      'worklet';
      console.info?.('CS_SCROLL_DIAG', 'activate', Date.now(), id, generation, s.epoch, s.alive, s.horizontal, nativeOffset.value, s.viewport, s.content, safe, generation >= s.epoch);
      if (generation < s.epoch) return s;
      s.epoch = generation; s.alive = true; s.safe = safe;
      presentationVersion.value++;
      return s;
    });
    // Acknowledgment follows UI acceptance, independently of geometry/content
    // decoration. RN delivery must still validate the current attachment lease.
    if (onReady && state.value.alive && state.value.epoch === generation) scheduleOnRN(onReady, generation);
  }

  function deactivate(generation: number) {
    'worklet';
    state.modify(s => {
      'worklet';
      console.info?.('CS_SCROLL_DIAG', 'deactivate', Date.now(), id, generation, s.epoch, s.alive, s.horizontal, nativeOffset.value, s.viewport, s.content, generation >= s.epoch);
      if (generation < s.epoch) return s;
      // A queued React detach can run after Fabric removed this host. Animated
      // refs retain their wrapper on null; cleanup must never write through it.
      // Reattachment/replay publishes zero on its current, live content binding.
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
      return s;
    });
  }

  function updateOptions(generation: number, enabled: boolean, canOwn: boolean, horizontal: boolean) {
    'worklet';
    state.modify(s => {
      'worklet';
      if (!s.alive || s.epoch !== generation) return s;
      const axisChanged = s.horizontal !== horizontal;
      s.enabled = enabled; s.canOwn = canOwn; s.horizontal = horizontal;
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
      if (value) resetOwned(s);
      presentationVersion.value++;
      return s;
    });
  }

  function setForeground(generation: number, value: boolean) {
    'worklet';
    state.modify(s => {
      'worklet';
      console.info?.('CS_SCROLL_DIAG', 'foreground', Date.now(), id, generation, s.epoch, s.alive, s.horizontal, s.foreground, value, s.nativeActive, s.active, s.owned, s.pending);
      if (!s.alive || s.epoch !== generation) return s;
      s.foreground = value;
      if (!value) resetOwned(s);
      presentationVersion.value++;
      return s;
    });
  }

  function updateGeometry(generation: number, viewport: number | null, content: number | null) {
    'worklet';
    state.modify(s => {
      'worklet';
      console.info?.('CS_SCROLL_DIAG', 'geometry', Date.now(), id, generation, s.epoch, s.alive, s.horizontal, nativeOffset.value, s.viewport, s.content, viewport ?? -1, content ?? -1, s.alive && s.epoch === generation);
      if (!s.alive || s.epoch !== generation) return s;
      if ((viewport != null && viewport !== s.viewport) || (content != null && content !== s.content)) {
        resetOwned(s);
        if (viewport != null) s.viewport = viewport;
        if (content != null) s.content = content;
      }
      return s;
    });
  }

  function command(generation: number, name: string, args: (number | boolean)[]) {
    'worklet';
    console.info?.('CS_SCROLL_DIAG', 'command', Date.now(), id, generation, state.value.epoch, state.value.alive, state.value.horizontal, nativeOffset.value, state.value.viewport, state.value.content, state.value.alive && state.value.epoch === generation, name === 'scrollTo' ? 1 : name === 'scrollToEnd' ? 2 : 0, args.length, Number(args[0] ?? -1), Number(args[1] ?? -1), Number(args[2] ?? -1));
    if (!state.value.alive || state.value.epoch !== generation) return;
    reset(generation);
    dispatchSpringScrollCommand(getAnimatedRef(), name, args);
  }

  function onNativeOffset(value: number, previous: number | null) {
    'worklet';
    state.modify(s => {
      'worklet';
      console.info?.('CS_SCROLL_DIAG', 'nativeOffset', Date.now(), id, s.epoch, s.alive, s.horizontal, value, previous ?? -1, nativeOffset.value, owner.value, s.nativeActive, s.active, s.owned, s.pending, s.blocked, s.released, s.touches);
      if (!s.owned || !allowed(s) || owner.value !== id) return s;
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
    if (!s.alive || !s.contentReady) return;
    const value = s.motionReady && !s.reduced && s.foreground && s.enabled ? presented : 0;
    // Reanimated forwards flattened props, unlike RN instance.setNativeProps.
    setNativeProps(getContentRef(), { transform: [s.horizontal ? { translateX: value } : { translateY: value }] });
  }

  return { gesture, mountBinding, unmountBinding, reset, activate, deactivate, contentReady,
    updateOptions, setReduced, setForeground, updateGeometry, command, onNativeOffset, present };
}
