import { SpringScrollView } from '@/components/spring-scroll-view';
import { createContext, useContext, useEffect, useState, type ComponentPropsWithRef } from 'react';
import { Platform, ScrollView, View, type PanResponderInstance, type ViewProps } from 'react-native';
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
}) {
  return <SpringScrollView {...props} />;
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
  if (nativePan && nativeDisabled !== undefined) nativePan.enabled(!nativeDisabled);
  useEffect(() => {
    const epoch = delivery.mount();
    if (nativePan) scheduleOnUI(synchronizeNativePan, state, epoch, true);
    return () => {
      const epoch = delivery.unmount();
      if (nativePan) scheduleOnUI(synchronizeNativePan, state, epoch, false);
    };
  }, [delivery, nativePan, state]);
  useEffect(() => {
    let subscribed = true;
    const unsubscribe = geometry?.subscribe(() => {
      // A dispatch may have copied this listener before cleanup unsubscribed it.
      if (!subscribed) return;
      const epoch = delivery.invalidate();
      if (nativePan) scheduleOnUI(synchronizeNativePan, state, epoch, true);
    });
    return () => {
      subscribed = false;
      unsubscribe?.();
    };
  }, [delivery, geometry, nativePan, state]);
  if (!nativePan) return <View {...panHandlers} {...props} />;
  return <GestureDetector gesture={nativePan}><View {...props} /></GestureDetector>;
}
