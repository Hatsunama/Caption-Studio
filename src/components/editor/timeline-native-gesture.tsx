import { SpringScrollView } from '@/components/spring-scroll-view';
import { createContext, useContext, useEffect, useLayoutEffect, useState, type ComponentPropsWithRef } from 'react';
import { AppState, Platform, ScrollView, View, type PanResponderInstance, type ViewProps } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets';
import { createTimelineNativePan, createTimelineNativePanDelivery, initialTimelineNativePanState,
  type TimelineNativePanCallbacks, type TimelineNativePanState } from './timeline-native-pan';

type NativeScrolls = ReturnType<typeof Gesture.Native>[];
export const TimelineNativeGestureContext = createContext<NativeScrolls>([]);
export const TimelineNativeGeometryContext = createContext<{ subscribe: (cancel: () => void) => () => void } | undefined>(undefined);

function synchronizeNativePan(state: SharedValue<TimelineNativePanState>, epoch: number, mounted: boolean) {
  'worklet';
  const current = state.value;
  // Cleanup may arrive after a newer mount/geometry task. Never rewind UI
  // ownership or invalidate the newer touch. Teardown belongs to GestureDetector;
  // a surviving invalidated stream yields only via its live callback manager.
  if (epoch <= current.epoch) return;
  state.value = { ...current, epoch, mounted, phase: 'invalidated' };
}

export function createTimelineNativeScrollGestures(): NativeScrolls {
  // These three handlers belong to the timeline, rather than an adapter caller.
  // Use the standard RNGH ScrollView preset so a new outer scroll cannot take
  // an active inner stream. Item pans still block these handlers until intent
  // resolves; no simultaneous edit/scroll relationship is introduced.
  return Platform.OS === 'android' ? Array.from({ length: 3 }, () => Gesture.Native()
    .disallowInterruption(true).shouldCancelWhenOutside(false)) : [];
}

export function TimelineNativeScrollView(props: ComponentPropsWithRef<typeof ScrollView> & {
  nativeGesture?: ReturnType<typeof Gesture.Native>;
  springOffset?: SharedValue<number>;
  onScrollBindingReady?: () => void;
}) {
  return <SpringScrollView {...props} />;
}

function createFallbackPanOwnership() {
  type Handlers = PanResponderInstance['panHandlers'];
  let handlers: Handlers = {};
  let callbacks: TimelineNativePanCallbacks | undefined;
  let enabled = true, available = false;
  let epoch = 0, contact: number | undefined;
  let owner: object | undefined;
  const live = () => available && enabled && contact === epoch;
  const retire = () => {
    epoch++;
    contact = undefined;
    // Fallback callbacks never enter native delivery.activeTouch. Cancel the
    // real timing/reorder owner directly, including its hold/auto-scroll timer.
    callbacks?.cancel();
  };
  const panHandlers: Handlers = {
    onStartShouldSetResponderCapture: event => {
      if (!available || !enabled) return false;
      // RN calls capture again for additional fingers. Only a new single-touch
      // start may establish ownership after an interruption or geometry change.
      if (event.nativeEvent.touches.length === 1) contact = epoch;
      return live() ? handlers.onStartShouldSetResponderCapture?.(event) ?? false : false;
    },
    onStartShouldSetResponder: event => live() ? handlers.onStartShouldSetResponder?.(event) ?? false : false,
    onMoveShouldSetResponderCapture: event => live() ? handlers.onMoveShouldSetResponderCapture?.(event) ?? false : false,
    onMoveShouldSetResponder: event => live() ? handlers.onMoveShouldSetResponder?.(event) ?? false : false,
    onResponderGrant: event => live() ? handlers.onResponderGrant?.(event) : undefined,
    onResponderMove: event => { if (live()) handlers.onResponderMove?.(event); },
    onResponderStart: event => { if (live()) handlers.onResponderStart?.(event); },
    onResponderEnd: event => { if (live()) handlers.onResponderEnd?.(event); },
    onResponderReject: event => {
      const accepted = live(); contact = undefined;
      if (accepted) handlers.onResponderReject?.(event);
    },
    onResponderRelease: event => {
      const accepted = live(); contact = undefined;
      if (accepted) handlers.onResponderRelease?.(event);
    },
    onResponderTerminate: event => {
      const accepted = live(); contact = undefined;
      if (accepted) handlers.onResponderTerminate?.(event);
    },
    onResponderTerminationRequest: event => live() ? handlers.onResponderTerminationRequest?.(event) ?? true : true,
  };
  return {
    panHandlers,
    configure(nextHandlers: Handlers, nextCallbacks: TimelineNativePanCallbacks, disabled: boolean) {
      if (enabled && disabled && available) retire();
      handlers = nextHandlers;
      callbacks = nextCallbacks;
      enabled = !disabled;
    },
    mount() {
      const session = {};
      owner = session;
      epoch++;
      contact = undefined;
      return {
        availability(next: boolean) {
          if (owner !== session || next === available) return;
          available = next;
          if (!next) retire();
        },
        invalidate() { if (owner === session) retire(); },
        unmount() {
          if (owner !== session) return;
          owner = undefined;
          const wasAvailable = available;
          available = false;
          if (wasAvailable) retire();
        },
      };
    },
  };
}

export function TimelineNativeGestureView({ panHandlers, nativeCallbacks, nativeDisabled, ...props }: ViewProps & {
  panHandlers: PanResponderInstance['panHandlers'];
  nativeCallbacks: TimelineNativePanCallbacks;
  nativeDisabled?: boolean;
}) {
  const scrolls = useContext(TimelineNativeGestureContext);
  const geometry = useContext(TimelineNativeGeometryContext);
  const state = useSharedValue(initialTimelineNativePanState());
  const [delivery] = useState(() => createTimelineNativePanDelivery(nativeCallbacks));
  const [nativePan] = useState(() => Platform.OS === 'android'
    ? createTimelineNativePan(Gesture.Pan(), nativeCallbacks, scrolls, {
      state, deliver: delivery.dispatch, schedule: scheduleOnRN,
    }) : undefined);
  const [fallback] = useState(() => nativePan ? undefined : createFallbackPanOwnership());
  useLayoutEffect(() => {
    fallback?.configure(panHandlers, nativeCallbacks, Boolean(nativeDisabled));
  }, [fallback, nativePan, panHandlers, nativeCallbacks, nativeDisabled]);
  if (nativePan && nativeDisabled !== undefined) nativePan.enabled(!nativeDisabled);
  useEffect(() => {
    let subscribed = true;
    let foreground = AppState.currentState === 'active';
    let focused = true;
    let available = true;
    const fallbackSession = fallback?.mount();
    fallbackSession?.availability(foreground);
    const synchronize = (epoch: number) => {
      if (nativePan) scheduleOnUI(synchronizeNativePan, state, epoch, available);
    };
    const updateAvailability = () => {
      if (!subscribed) return;
      const next = foreground && focused;
      if (next === available) return;
      available = next;
      fallbackSession?.availability(available);
      // Close RN ownership immediately, before any queued UI/RN samples drain.
      // Reopening advances the same epoch and requires a fresh touch prepare.
      synchronize(available ? delivery.mount() : delivery.unmount());
    };
    synchronize(delivery.mount());
    const change = AppState.addEventListener('change', (status) => {
      foreground = status === 'active';
      updateAvailability();
    });
    const blur = Platform.OS === 'android' ? AppState.addEventListener('blur', () => {
      focused = false;
      updateAvailability();
    }) : undefined;
    const focus = Platform.OS === 'android' ? AppState.addEventListener('focus', () => {
      focused = true;
      updateAvailability();
    }) : undefined;
    updateAvailability();
    const unsubscribe = geometry?.subscribe(() => {
      // Dispatch snapshots can outlive cleanup. Geometry must also preserve
      // suspension rather than reopening UI recognition while blurred.
      if (!subscribed) return;
      fallbackSession?.invalidate();
      synchronize(delivery.invalidate());
    });
    return () => {
      if (!subscribed) return;
      subscribed = false;
      fallbackSession?.unmount();
      change.remove();
      blur?.remove();
      focus?.remove();
      unsubscribe?.();
      available = false;
      synchronize(delivery.unmount());
    };
  }, [delivery, fallback, geometry, nativePan, state]);
  if (!nativePan) return <View {...panHandlers} {...fallback!.panHandlers} {...props} />;
  return <GestureDetector gesture={nativePan}><View {...props} /></GestureDetector>;
}
