import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react';
import { AccessibilityInfo, AppState, Platform, ScrollView as NativeScrollView,
  StyleSheet, type HostInstance, type ScrollViewProps } from 'react-native';
import { Gesture, GestureDetector, type NativeGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedReaction, useAnimatedRef, useReducedMotion,
  useScrollOffset, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { scheduleOnUI } from 'react-native-worklets';
import { createScrollSpringAxisState } from '../lib/scroll-spring-policy';
import { interceptSpringScrollCommands } from './spring-scroll-gesture';
import { createScrollSpringController, type ScrollSpringRuntimeState } from './scroll-spring-controller';

export const SpringScrollGestureContext = createContext<NativeGesture[]>([]);
export type SpringScrollViewProps = ScrollViewProps & {
  ref?: Ref<NativeScrollView>;
  nativeGesture?: NativeGesture;
  springOffset?: SharedValue<number>;
  springOwner?: boolean;
};
const owners = new WeakMap<SharedValue<number>, SharedValue<number>>();
let nextOwner = 0;

function unsupported(props: SpringScrollViewProps) {
  const style = StyleSheet.flatten(props.contentContainerStyle) ?? {};
  return props.nativeGesture?.config.runOnJS === true || props.nativeGesture?.handlers.isWorklet.includes(false) ||
    !!props.refreshControl || !!props.stickyHeaderIndices?.length || !!props.StickyHeaderComponent ||
    !!props.invertStickyHeaders || !!props.maintainVisibleContentPosition || !!style.transform;
}

export function SpringScrollView(props: SpringScrollViewProps) {
  const { nativeGesture, springOffset: _offset, springOwner: _owner, ...nativeProps } = props;
  if (Platform.OS !== 'android' || unsupported(props)) {
    const view = <NativeScrollView {...nativeProps} />;
    return Platform.OS === 'android' && nativeGesture
      ? <GestureDetector gesture={nativeGesture}>{view}</GestureDetector> : view;
  }
  return <AndroidSpringScrollView {...props} />;
}

/** Stable VirtualizedList renderer; virtualization and direct cell children stay native. */
export function renderSpringScrollView(props: ScrollViewProps) {
  return <SpringScrollView {...props} />;
}

function AndroidSpringScrollView({ ref: publicRef, nativeGesture, springOffset, springOwner = true,
  children, contentContainerStyle, onLayout, onContentSizeChange, ...props }: SpringScrollViewProps) {
  const ancestors = useContext(SpringScrollGestureContext);
  // Match RNGH 2.32's ScrollView preset: the child that starts scrolling keeps
  // the stream, and dragging beyond its bounds does not cancel that scroll.
  // Explicit caller-owned handlers retain their existing configuration.
  const [ownedNative] = useState(() => nativeGesture ?? Gesture.Native()
    .disallowInterruption(true).shouldCancelWhenOutside(false));
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
  const state = useSharedValue<ScrollSpringRuntimeState>({
    alive: false, epoch: 0, safe: false, contentReady: false, enabled: props.scrollEnabled !== false,
    canOwn: springOwner, reduced: initialReduced, motionReady: false, foreground: AppState.currentState === 'active',
    nativeActive: false, active: false, owned: false, pending: false, blocked: false, released: false, touches: 0,
    startX: 0, startY: 0, pointer: 0, viewport: 0, content: 0,
    lastOffset: 0, lastOffsetAt: 0, fling: false, horizontal,
    axis: createScrollSpringAxisState(),
  });
  // The imperative platform controller owns native callbacks and mutable UI state.
  // React only connects refs, native layout and external lifecycle notifications.
  const controller = useMemo(() => createScrollSpringController({
    state, owner, offset, id, nativeOffset, animatedRef, contentRef, presentationVersion, gesture: ownedNative,
  }), [state, owner, offset, id, nativeOffset, animatedRef, contentRef, presentationVersion, ownedNative]);
  useLayoutEffect(() => {
    controller.mountBinding();
    return controller.unmountBinding;
  }, [controller]);
  useAnimatedReaction(() => nativeOffset.value, controller.onNativeOffset, [nativeOffset, controller]);

  const lifecycle = useRef<{ generation: number; node: NativeScrollView | null; content: HostInstance | null;
    restore?: () => void; refCleanup?: () => void }>({ generation: 0, node: null, content: null });
  const bindContent = useCallback(() => {
    const life = lifecycle.current;
    // RN 0.86.3 exposes this method in its public imperative interface and host
    // even though its TS declaration omits it. Never access private view fields.
    const node = life.node as (NativeScrollView & { getInnerViewRef?: () => HostInstance | null }) | null;
    const content = node?.getInnerViewRef?.();
    if (!content) return;
    life.content = content;
    contentRef(content);
    scheduleOnUI(controller.contentReady, life.generation);
  }, [lifecycle, contentRef, controller]);
  const commitRef = useCallback((node: NativeScrollView | null) => {
    const life = lifecycle.current;
    life.restore?.(); life.restore = undefined;
    if (life.refCleanup) { life.refCleanup(); life.refCleanup = undefined; }
    else if (life.node && typeof publicRef === 'function') publicRef(null);
    life.node = node;
    const generation = ++life.generation;
    if (node) {
      animatedRef(node);
      life.restore = interceptSpringScrollCommands(node, animatedRef, () => lifecycle.current.generation, controller.command);
      scheduleOnUI(controller.activate, generation, !!life.restore);
      bindContent();
      if (typeof publicRef === 'function') {
        const cleanup = publicRef(node);
        if (typeof cleanup === 'function') life.refCleanup = cleanup;
      } else if (publicRef) publicRef.current = node;
    } else {
      scheduleOnUI(controller.deactivate, generation);
      life.content = null;
      if (publicRef && typeof publicRef !== 'function') publicRef.current = null;
    }
  }, [lifecycle, publicRef, animatedRef, controller, bindContent]);
  useLayoutEffect(() => {
    const life = lifecycle.current;
    if (life.node && !life.restore) life.restore = interceptSpringScrollCommands(life.node, animatedRef, () => lifecycle.current.generation, controller.command);
    scheduleOnUI(controller.activate, ++life.generation, !!life.restore);
    bindContent();
    return () => {
      life.restore?.(); life.restore = undefined;
      scheduleOnUI(controller.deactivate, ++life.generation);
    };
  }, [lifecycle, animatedRef, controller, bindContent]);
  useLayoutEffect(() => {
    scheduleOnUI(controller.updateOptions, props.scrollEnabled !== false, springOwner, horizontal);
  }, [props.scrollEnabled, springOwner, horizontal, controller]);
  useLayoutEffect(() => { scheduleOnUI(controller.reset); }, [props.contentOffset?.x, props.contentOffset?.y, controller]);
  useEffect(() => {
    let live = true, revision = 0;
    const update = (reduced: boolean) => {
      if (!live) return;
      revision++;
      scheduleOnUI(controller.setReduced, lifecycle.current.generation, reduced);
    };
    const listener = AccessibilityInfo.addEventListener('reduceMotionChanged', update);
    const queryRevision = revision;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => {
      if (live && revision === queryRevision) update(value);
    }, () => { if (live && revision === queryRevision) update(true); });
    const app = AppState.addEventListener('change', value => {
      if (live) scheduleOnUI(controller.setForeground, lifecycle.current.generation, value === 'active');
    });
    return () => { live = false; revision++; listener.remove(); app.remove(); };
  }, [controller, lifecycle]);
  useAnimatedReaction(() => `${offset.value}:${presentationVersion.value}`, controller.present,
    [controller, offset, presentationVersion]);

  return <GestureDetector gesture={controller.gesture}>
    <Animated.ScrollView {...props} ref={commitRef} overScrollMode="never" contentContainerStyle={contentContainerStyle}
      onLayout={event => {
        bindContent();
        const layout = event.nativeEvent.layout;
        scheduleOnUI(controller.updateGeometry, horizontal ? layout.width : layout.height, null);
        onLayout?.(event);
      }}
      onContentSizeChange={(width, height) => {
        bindContent();
        scheduleOnUI(controller.updateGeometry, null, horizontal ? width : height);
        onContentSizeChange?.(width, height);
      }}>
      <SpringScrollGestureContext.Provider value={descendantGestures}>{children}</SpringScrollGestureContext.Provider>
    </Animated.ScrollView>
  </GestureDetector>;
}
