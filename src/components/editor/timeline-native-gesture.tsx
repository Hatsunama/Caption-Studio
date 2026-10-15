import { createContext, useContext, useState, type ComponentPropsWithRef } from 'react';
import { Platform, ScrollView, View, type PanResponderInstance, type ViewProps } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { createTimelineNativePan, type TimelineNativePanCallbacks } from './timeline-native-pan';

type NativeScrolls = ReturnType<typeof Gesture.Native>[];
export const TimelineNativeGestureContext = createContext<NativeScrolls>([]);

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
  const [nativePan] = useState(() => Platform.OS === 'android'
    ? createTimelineNativePan(Gesture.Pan(), nativeCallbacks, scrolls) : undefined);
  if (!nativePan) return <View {...panHandlers} {...props} />;
  return <GestureDetector gesture={nativePan}><View {...props} /></GestureDetector>;
}
