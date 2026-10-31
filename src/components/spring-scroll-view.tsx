import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react';
import { AccessibilityInfo, AppState, Platform, ScrollView as NativeScrollView,
  StyleSheet, type HostInstance, type ScrollViewProps } from 'react-native';
import { Gesture, GestureDetector, type NativeGesture } from 'react-native-gesture-handler';
import Animated, { cancelAnimation, setNativeProps, useAnimatedReaction, useAnimatedRef,
  useReducedMotion, useScrollOffset, useSharedValue, withSpring, type SharedValue } from 'react-native-reanimated';
import { scheduleOnUI } from 'react-native-worklets';
import { beginScrollSpringDrag, createScrollSpringAxisState, releaseScrollSpringDrag,
  resetScrollSpringAxis, updateScrollSpringDrag } from '../lib/scroll-spring-policy';
import { dispatchSpringScrollCommand, interceptSpringScrollCommands } from './spring-scroll-gesture';

export type SpringScrollView = NativeScrollView;
export const SpringScrollGestureContext = createContext<NativeGesture[]>([]);
export type SpringScrollViewProps = ScrollViewProps & {
  ref?: Ref<NativeScrollView>;
  nativeGesture?: NativeGesture;
  springOffset?: SharedValue<number>;
  springOwner?: boolean;
};

// Weak keys keep a shared presentation's ownership local to its lifetime. A
// mirrored peer may read the offset, but only the current touch owner can clear it.
const owners = new WeakMap<SharedValue<number>, SharedValue<number>>();
type NativeHandlers = NativeGesture['handlers'];
const nativeBindings = new WeakMap<NativeGesture, { original: NativeHandlers; observed: NativeHandlers }>();
let nextOwner = 0;

function applyNativeCallbacks(target: NativeHandlers, source: NativeHandlers) {
  // GestureDetector assigns handlerTag during its own mount. Copy only the
  // observed callbacks, never a snapshot of its runtime identity/metadata.
  for (const key of ['onTouchesDown', 'onTouchesMove', 'onTouchesUp', 'onTouchesCancelled', 'onStart', 'onFinalize'] as const) {
    if (source[key]) Object.assign(target, { [key]: source[key] });
    else delete target[key];
  }
  target.isWorklet = [...source.isWorklet];
}

function unsupported(props: SpringScrollViewProps) {
  const style = StyleSheet.flatten(props.contentContainerStyle) ?? {};
  // These features attach semantics to particular children/positions, or own
  // the content transform. Keep their original native behavior.
  return props.nativeGesture?.config.runOnJS === true || props.nativeGesture?.handlers.isWorklet.includes(false) ||
    !!props.refreshControl || !!props.stickyHeaderIndices?.length ||
    !!props.StickyHeaderComponent || !!props.invertStickyHeaders || !!props.maintainVisibleContentPosition ||
    !!style.transform;
}

/** The public value and type deliberately share a name, like RN ScrollView. */
export function SpringScrollView(props: SpringScrollViewProps) {
  const { nativeGesture, springOffset: _offset, springOwner: _owner, ...nativeProps } = props;
  if (Platform.OS !== 'android' || unsupported(props)) {
    const view = <NativeScrollView {...nativeProps} />;
    return Platform.OS === 'android' && nativeGesture
      ? <GestureDetector gesture={nativeGesture}>{view}</GestureDetector> : view;
  }
  return <AndroidSpringScrollView {...props} />;
}

/** Stable identity for VirtualizedList's renderScrollComponent. */
export function renderSpringScrollView(props: ScrollViewProps) {
  return <SpringScrollView {...props} />;
}

function AndroidSpringScrollView({ ref: publicRef, nativeGesture, springOffset, springOwner = true,
  children, contentContainerStyle, onLayout, onContentSizeChange, ...props }: SpringScrollViewProps) {
  const ancestors = useContext(SpringScrollGestureContext);
  // Child gesture relations retain this exact object; callback reconfiguration
  // must never replace it. Supplied Native gestures obey the same lifetime rule.
  const [ownedNative] = useState(() => nativeGesture ?? Gesture.Native());
  const descendantGestures = useMemo(() => [...ancestors, ownedNative], [ancestors, ownedNative]);
  const horizontal = props.horizontal === true;
  const initialReduced = useReducedMotion();
  const localOffset = useSharedValue(0);
  const offset = springOffset ?? localOffset;
  const localOwner = useSharedValue(0);
  const owner = useMemo(() => {
    if (!springOffset) return localOwner;
    const existing = owners.get(springOffset);
    if (existing) return existing;
    owners.set(springOffset, localOwner);
    return localOwner;
  }, [springOffset, localOwner]);
  const [id] = useState(() => ++nextOwner);
  const nativeOffset = useSharedValue(0);
  const animatedRef = useAnimatedRef<NativeScrollView>();
  const contentRef = useAnimatedRef<HostInstance>();
  const presentationVersion = useSharedValue(0);
  useScrollOffset(animatedRef, nativeOffset);
  const state = useSharedValue({
    alive: false, epoch: 0, safe: false, contentReady: false, enabled: props.scrollEnabled !== false,
    canOwn: springOwner, reduced: initialReduced, motionReady: false, foreground: AppState.currentState === 'active',
    nativeActive: false, active: false, owned: false, pending: false, blocked: false, released: false, touches: 0,
    startX: 0, startY: 0, pointer: 0, viewport: 0, content: 0,
    lastOffset: 0, lastOffsetAt: 0, fling: false,
    axis: createScrollSpringAxisState(),
  });

  const reset = useCallback(() => {
    'worklet';
    const s = state.value;
    s.nativeActive = false; s.active = false; s.owned = false; s.pending = false; s.fling = false;
    resetScrollSpringAxis(s.axis);
    if (owner.value === id) {
      cancelAnimation(offset); offset.value = 0; owner.value = 0;
    }
  }, [state, owner, offset, id]);

  const allowed = useCallback(() => {
    'worklet';
    const s = state.value;
    return s.alive && s.safe && s.contentReady && s.enabled && s.canOwn && s.motionReady && !s.reduced && s.foreground &&
      Number.isFinite(s.viewport) && s.viewport > 0 && Number.isFinite(s.content) && s.content >= 0;
  }, [state]);

  const normalizedOffset = useCallback(() => {
    'worklet';
    const range = Math.max(0, state.value.content - state.value.viewport);
    const value = nativeOffset.value;
    // Only normalize floating point noise, never turn interior travel into pull.
    return Math.abs(value) < 0.001 ? 0 : Math.abs(value - range) < 0.001 ? range : value;
  }, [state, nativeOffset]);

  const acquire = useCallback(() => {
    'worklet';
    const s = state.value;
    if (!allowed() || !s.nativeActive || s.blocked || s.touches !== 1 || !s.pending) return;
    s.active = true; s.owned = true; owner.value = id; cancelAnimation(offset);
    const accepted = beginScrollSpringDrag(s.axis, {
      pointerDp: s.pointer, timeMs: performance.now(), viewportDp: s.viewport,
      offsetDp: normalizedOffset(), rangeDp: Math.max(0, s.content - s.viewport),
      nativeActive: s.nativeActive, scrollEnabled: s.enabled, touchCount: 1, dominantAxis: true, reducedMotion: s.reduced,
    }, offset.value);
    if (!accepted) offset.value = 0;
  }, [state, allowed, owner, id, offset, normalizedOffset]);

  const spring = useCallback((velocity: number, fromMomentum = false) => {
    'worklet';
    if (!allowed() || owner.value !== id) return;
    const s = state.value;
    if (offset.value === 0 && !fromMomentum) return;
    const cap = Math.min(96, s.viewport / 4);
    // Energy <= k*cap^2/2 also bounds the outward excursion of a nonzero
    // release. This is a velocity bound, not an oscillator or a native fling.
    const maxVelocity = Math.min(3200, Math.sqrt(200 * Math.max(0, cap * cap - offset.value * offset.value)));
    const boundedVelocity = Number.isFinite(velocity) ? Math.max(-maxVelocity, Math.min(maxVelocity, velocity)) : 0;
    const generation = s.epoch;
    s.fling = false;
    offset.value = withSpring(0, { mass: 1, stiffness: 200, damping: 24, velocity: boundedVelocity }, finished => {
      'worklet';
      if (finished && state.value.epoch === generation && owner.value === id && !state.value.active) {
        offset.value = 0; owner.value = 0; state.value.owned = false;
      }
    });
  }, [allowed, state, owner, id, offset]);

  const binding = useMemo(() => {
    const g = ownedNative;
    const original = nativeBindings.get(g)?.original ?? { ...g.handlers, isWorklet: [...g.handlers.isWorklet] };
    // Native gesture callbacks execute on UI. No Pan, manual activation, RN touch
    // responder, or change to native scrollEnabled/deceleration is introduced.
    g.onTouchesDown((event, manager) => {
      'worklet';
      original.onTouchesDown?.(event, manager);
      const s = state.value;
      if (event.numberOfTouches !== 1) { s.blocked = true; reset(); return; }
      const touch = event.allTouches[0];
      if (!touch) return;
      s.touches = 1; s.pending = true; s.blocked = false; s.released = false;
      s.active = false; s.owned = false; s.fling = false;
      s.startX = touch.absoluteX; s.startY = touch.absoluteY;
      s.pointer = horizontal ? touch.absoluteX : touch.absoluteY;
      resetScrollSpringAxis(s.axis);
      if (owner.value === id) cancelAnimation(offset); // retain presented position
      // Native.shouldActivateOnStart can deliver ACTIVE before its first DOWN
      // pointer payload. Both orderings must observe the same owned native drag.
      acquire();
    }).onStart(event => {
      'worklet';
      original.onStart?.(event);
      const s = state.value;
      s.nativeActive = true; acquire();
    }).onTouchesMove((event, manager) => {
      'worklet';
      original.onTouchesMove?.(event, manager);
      const s = state.value;
      if (!s.active || !s.owned) return;
      if (!allowed() || owner.value !== id || event.numberOfTouches !== 1 || s.blocked) { reset(); return; }
      const touch = event.allTouches[0];
      if (!touch) { reset(); return; }
      const dx = Math.abs(touch.absoluteX - s.startX), dy = Math.abs(touch.absoluteY - s.startY);
      s.pointer = horizontal ? touch.absoluteX : touch.absoluteY;
      offset.value = updateScrollSpringDrag(s.axis, {
        pointerDp: s.pointer, timeMs: performance.now(), viewportDp: s.viewport,
        offsetDp: normalizedOffset(), rangeDp: Math.max(0, s.content - s.viewport),
        nativeActive: s.nativeActive, scrollEnabled: s.enabled, touchCount: event.numberOfTouches,
        dominantAxis: horizontal ? dx >= dy : dy >= dx, reducedMotion: s.reduced,
      });
    }).onTouchesUp((event, manager) => {
      'worklet';
      original.onTouchesUp?.(event, manager);
      // Zero touches on a successful Up must not go through policy eligibility:
      // it would erase the release position and measured velocity before Finalize.
      state.value.touches = event.numberOfTouches;
    }).onTouchesCancelled((event, manager) => {
      'worklet';
      original.onTouchesCancelled?.(event, manager);
      const s = state.value;
      s.nativeActive = false;
      if (s.active || s.pending) {
        if (owner.value === id && offset.value !== 0 && allowed()) {
          s.active = false; s.pending = false; s.released = true; s.fling = false;
          resetScrollSpringAxis(s.axis); spring(0);
        } else reset();
      }
    }).onFinalize((_event, success) => {
      'worklet';
      original.onFinalize?.(_event, success);
      const s = state.value;
      s.nativeActive = false;
      if (s.released) return;
      const pending = s.pending;
      s.pending = false;
      // A tap or another recognizer winning after touching a recoil only pauses
      // presentation. Resume from the held position rather than snapping to rest.
      if ((!s.active || !success) && pending && owner.value === id && offset.value !== 0 && allowed()) {
        s.active = false; s.released = true; s.fling = false;
        resetScrollSpringAxis(s.axis); spring(0); return;
      }
      if (!success || !s.active || !s.owned || !allowed()) { reset(); return; }
      s.released = true;
      const now = performance.now();
      const velocity = releaseScrollSpringDrag(s.axis, now);
      s.active = false; s.fling = true; s.lastOffset = nativeOffset.value; s.lastOffsetAt = now;
      spring(velocity);
    });
    const binding = { gesture: g, original, observed: { ...g.handlers, isWorklet: [...g.handlers.isWorklet] } };
    nativeBindings.set(g, binding);
    return binding;
  }, [ownedNative, state, horizontal, reset, owner, id, offset, allowed, acquire, normalizedOffset, nativeOffset, spring]);
  const gesture = binding.gesture;
  useLayoutEffect(() => {
    applyNativeCallbacks(gesture.handlers, binding.observed);
    nativeBindings.set(gesture, binding);
    return () => {
      if (nativeBindings.get(gesture) !== binding) return;
      applyNativeCallbacks(gesture.handlers, binding.original);
      nativeBindings.delete(gesture);
    };
  }, [binding, gesture]);

  useAnimatedReaction(() => nativeOffset.value, (value, previous) => {
    'worklet';
    const s = state.value;
    if (!s.owned || !allowed() || owner.value !== id) return;
    const now = performance.now();
    const dt = now - s.lastOffsetAt;
    if (s.fling && !s.active) {
      // A reactive observer does no work at rest. A delayed new scroll cannot
      // inherit old touch ownership; public commands revoke it before dispatch.
      if (dt <= 0 || dt > 100) { reset(); return; }
      const delta = value - (previous ?? s.lastOffset);
      const range = Math.max(0, s.content - s.viewport);
      const edge = normalizedOffset();
      if ((edge === 0 && delta < 0) || (range > 0 && edge === range && delta > 0)) {
        spring(-delta * 1000 / dt, true);
      }
    }
    s.lastOffset = value; s.lastOffsetAt = now;
  }, [state, allowed, owner, id, reset, normalizedOffset, spring]);

  const lifecycle = useRef<{ generation: number; node: NativeScrollView | null; content: HostInstance | null;
    restore?: () => void; refCleanup?: () => void }>({ generation: 0, node: null, content: null });
  const command = useCallback((generation: number, name: string, args: (number | boolean)[]) => {
    'worklet';
    if (!state.value.alive || state.value.epoch !== generation) return;
    reset();
    dispatchSpringScrollCommand(animatedRef, name, args);
  }, [state, reset, animatedRef]);
  const activate = useCallback((generation: number, safe: boolean) => {
    'worklet';
    if (generation < state.value.epoch) return;
    state.value.epoch = generation; state.value.alive = true; state.value.safe = safe;
    presentationVersion.value++;
  }, [state, presentationVersion]);
  const deactivate = useCallback((generation: number) => {
    'worklet';
    if (generation < state.value.epoch) return;
    if (state.value.contentReady) setNativeProps(contentRef, { transform: [] });
    state.value.contentReady = false;
    state.value.epoch = generation; state.value.alive = false; state.value.safe = false; reset();
    presentationVersion.value++;
  }, [state, reset, contentRef, presentationVersion]);
  const bindContent = useCallback(() => {
    const life = lifecycle.current;
    // This public method is present in RN 0.86.3's imperative interface and
    // Object.assign public host (ScrollView.js:142,869,1189), though omitted from
    // its TS declaration. Never reach through private fields or numeric handles.
    const node = life.node as (NativeScrollView & { getInnerViewRef?: () => HostInstance | null }) | null;
    const content = node?.getInnerViewRef?.();
    if (!content) return; // commit may precede readiness; layout retries below
    life.content = content;
    contentRef(content);
    const generation = life.generation;
    scheduleOnUI(() => {
      'worklet';
      if (state.value.epoch !== generation || !state.value.alive) return;
      state.value.contentReady = true; presentationVersion.value++;
    });
  }, [lifecycle, contentRef, state, presentationVersion]);
  const commitRef = useCallback((node: NativeScrollView | null) => {
    const life = lifecycle.current;
    life.restore?.(); life.restore = undefined;
    if (life.refCleanup) { life.refCleanup(); life.refCleanup = undefined; }
    else if (life.node && typeof publicRef === 'function') publicRef(null);
    life.node = node;
    const generation = ++life.generation;
    if (node) {
      animatedRef(node);
      life.restore = interceptSpringScrollCommands(node, animatedRef, () => lifecycle.current.generation, command);
      scheduleOnUI(activate, generation, !!life.restore);
      bindContent();
      if (typeof publicRef === 'function') {
        const cleanup = publicRef(node);
        if (typeof cleanup === 'function') life.refCleanup = cleanup;
      } else if (publicRef) publicRef.current = node;
    } else {
      scheduleOnUI(deactivate, generation);
      life.content = null;
      if (publicRef && typeof publicRef !== 'function') publicRef.current = null;
    }
  }, [lifecycle, publicRef, animatedRef, command, activate, deactivate, bindContent]);

  useLayoutEffect(() => {
    const life = lifecycle.current;
    if (life.node && !life.restore) life.restore = interceptSpringScrollCommands(life.node, animatedRef, () => lifecycle.current.generation, command);
    scheduleOnUI(activate, ++life.generation, !!life.restore);
    bindContent();
    return () => {
      life.restore?.(); life.restore = undefined;
      scheduleOnUI(deactivate, ++life.generation);
    };
  }, [lifecycle, animatedRef, command, activate, deactivate, bindContent]);

  useLayoutEffect(() => {
    scheduleOnUI((enabled: boolean, canOwn: boolean) => {
      'worklet';
      state.value.enabled = enabled; state.value.canOwn = canOwn;
      if (!enabled || !canOwn) reset();
      presentationVersion.value++;
    }, props.scrollEnabled !== false, springOwner);
  }, [props.scrollEnabled, springOwner, state, reset, presentationVersion]);
  useLayoutEffect(() => { scheduleOnUI(reset); }, [props.contentOffset?.x, props.contentOffset?.y, reset]);

  useEffect(() => {
    let live = true, revision = 0;
    const update = (reduced: boolean) => {
      if (!live) return;
      revision++;
      const generation = lifecycle.current.generation;
      scheduleOnUI((value: boolean) => {
        'worklet';
        if (!state.value.alive || state.value.epoch !== generation) return;
        state.value.motionReady = true; state.value.reduced = value; if (value) reset();
        presentationVersion.value++;
      }, reduced);
    };
    const listener = AccessibilityInfo.addEventListener('reduceMotionChanged', update);
    const queryRevision = revision;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => {
      if (live && revision === queryRevision) update(value);
    }, () => { if (live && revision === queryRevision) update(true); });
    const app = AppState.addEventListener('change', value => {
      if (!live) return;
      const generation = lifecycle.current.generation;
      scheduleOnUI((foreground: boolean) => {
        'worklet';
        if (!state.value.alive || state.value.epoch !== generation) return;
        state.value.foreground = foreground; if (!foreground) reset();
        presentationVersion.value++;
      }, value === 'active');
    });
    return () => { live = false; revision++; listener.remove(); app.remove(); };
  }, [state, reset, lifecycle, presentationVersion]);

  const updateGeometry = useCallback((viewport: number | null, content: number | null) => {
    'worklet';
    const s = state.value;
    if ((viewport != null && viewport !== s.viewport) || (content != null && content !== s.content)) {
      reset();
      if (viewport != null) s.viewport = viewport;
      if (content != null) s.content = content;
    }
  }, [state, reset]);
  useAnimatedReaction(() => `${offset.value}:${presentationVersion.value}`, () => {
    'worklet';
    const s = state.value;
    if (!s.alive || !s.contentReady) return;
    const value = s.motionReady && !s.reduced && s.foreground && s.enabled ? offset.value : 0;
    // Reanimated 4.5.1 forwards flattened native props to _updateProps. Unlike
    // RN's instance.setNativeProps, this API does not take {style:{...}}.
    setNativeProps(contentRef, { transform: [horizontal ? { translateX: value } : { translateY: value }] });
  }, [state, contentRef, horizontal, offset, presentationVersion]);
  return <GestureDetector gesture={gesture}>
    <Animated.ScrollView {...props} ref={commitRef} overScrollMode="never"
      contentContainerStyle={contentContainerStyle}
      onLayout={event => {
        bindContent();
        const layout = event.nativeEvent.layout;
        scheduleOnUI(updateGeometry, horizontal ? layout.width : layout.height, null);
        onLayout?.(event);
      }}
      onContentSizeChange={(width, height) => {
        bindContent();
        scheduleOnUI(updateGeometry, null, horizontal ? width : height);
        onContentSizeChange?.(width, height);
      }}>
      <SpringScrollGestureContext.Provider value={descendantGestures}>
        {children}
      </SpringScrollGestureContext.Provider>
    </Animated.ScrollView>
  </GestureDetector>;
}
