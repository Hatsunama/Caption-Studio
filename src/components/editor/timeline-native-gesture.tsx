import { createContext, useContext, useEffect, useState, type ComponentPropsWithRef } from 'react';
import { Platform, ScrollView, View, type PanResponderInstance, type ViewProps } from 'react-native';
import { Gesture, GestureDetector, State } from 'react-native-gesture-handler';
import { setGestureState, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets';
import { createTimelineNativePan, createTimelineNativePanDelivery, initialTimelineNativePanState,
  type TimelineNativePanCallbacks, type TimelineNativePanState } from './timeline-native-pan';

type NativeScrolls = ReturnType<typeof Gesture.Native>[];
export const TimelineNativeGestureContext = createContext<NativeScrolls>([]);
export const TimelineNativeGeometryContext = createContext<{ subscribe: (cancel: () => void) => () => void } | undefined>(undefined);

function invalidateNativePan(state: SharedValue<TimelineNativePanState>, epoch: number) {
  'worklet';
  const current = state.value;
  state.value = { ...current, epoch, phase: 'failed' };
  if (current.handlerTag > 0 && current.phase !== 'idle' && current.phase !== 'failed') {
    setGestureState(current.handlerTag, current.phase === 'active' ? State.CANCELLED : State.FAILED);
  }
}

export function createTimelineNativeScrollGestures(): NativeScrolls {
  return Platform.OS === 'android' ? [Gesture.Native(), Gesture.Native()] : [];
}

export function TimelineNativeScrollView({ nativeGesture, ...props }: ComponentPropsWithRef<typeof ScrollView> & {
  nativeGesture?: ReturnType<typeof Gesture.Native>;
}) {
  const view = <ScrollView {...props} />;
  return nativeGesture ? <GestureDetector gesture={nativeGesture}>{view}</GestureDetector> : view;
}

export function TimelineNativeGestureView({ panHandlers, nativeCallbacks, ...props }: ViewProps & {
  panHandlers: PanResponderInstance['panHandlers'];
  nativeCallbacks: TimelineNativePanCallbacks;
}) {
  const scrolls = useContext(TimelineNativeGestureContext);
  const geometry = useContext(TimelineNativeGeometryContext);
  const state = useSharedValue(initialTimelineNativePanState());
  const [delivery] = useState(() => createTimelineNativePanDelivery(nativeCallbacks));
  const [nativePan] = useState(() => Platform.OS === 'android'
    ? createTimelineNativePan(Gesture.Pan(), nativeCallbacks, scrolls, {
      state, deliver: delivery.dispatch, schedule: scheduleOnRN,
    }) : undefined);
  useEffect(() => {
    delivery.mount();
    return () => {
      const epoch = delivery.unmount();
      if (nativePan) scheduleOnUI(invalidateNativePan, state, epoch);
    };
  }, [delivery, nativePan, state]);
  useEffect(() => geometry?.subscribe(() => {
    const epoch = delivery.invalidate();
    if (nativePan) scheduleOnUI(invalidateNativePan, state, epoch);
  }), [delivery, geometry, nativePan, state]);
  if (!nativePan) return <View {...panHandlers} {...props} />;
  return <GestureDetector gesture={nativePan}><View {...props} /></GestureDetector>;
}
