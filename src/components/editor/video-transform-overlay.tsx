import { useMemo, useRef } from 'react';
import { type GestureResponderEvent, PanResponder, Text, View } from 'react-native';

import { chrome } from '@/lib/ui-theme';
import type { VideoTransform, VideoTransformPatch } from '@/types/project';

type TouchPoint = { pageX: number; pageY: number };

export function VideoTransformOverlay(props: {
  transform: VideoTransform;
  onInteractionStart?: () => void;
  onChange: (patch: VideoTransformPatch) => void;
  onEnd: () => void;
}) {
  const rootRef = useRef<View>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const metrics = useRef({ width: 1, height: 1, pageX: 0, pageY: 0 });
  const start = useRef({
    position: { x: 0.5, y: 0.5 },
    scale: 1,
    rotation: 0,
    touches: [] as TouchPoint[],
    touchCount: 0,
  });

  const rebase = (touches: TouchPoint[]) => {
    const current = propsRef.current.transform;
    start.current = {
      position: { ...current.position },
      scale: current.scale,
      rotation: current.rotation,
      touches,
      touchCount: touches.length >= 2 ? 2 : 1,
    };
  };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          propsRef.current.onInteractionStart?.();
          rebase(readTouches(event));
        },
        onPanResponderMove: (event) => {
          const touches = readTouches(event);
          if (touches.length === 0) return;
          const touchCount = touches.length >= 2 ? 2 : 1;
          if (start.current.touchCount !== touchCount) {
            rebase(touches);
            return;
          }

          const origin = start.current;
          const size = metrics.current;
          if (touchCount === 2 && origin.touches.length >= 2) {
            const originalDistance = distance(origin.touches[0], origin.touches[1]);
            const nextDistance = distance(touches[0], touches[1]);
            const originalCenter = midpoint(origin.touches[0], origin.touches[1]);
            const nextCenter = midpoint(touches[0], touches[1]);
            propsRef.current.onChange({
              position: {
                x: clamp(origin.position.x + (nextCenter.pageX - originalCenter.pageX) / size.width, -0.5, 1.5),
                y: clamp(origin.position.y + (nextCenter.pageY - originalCenter.pageY) / size.height, -0.5, 1.5),
              },
              scale: clamp(origin.scale * (nextDistance / Math.max(8, originalDistance)), 0.2, 5),
              rotation: normalizeDegrees(
                origin.rotation +
                  shortestAngleDelta(angle(origin.touches[0], origin.touches[1]), angle(touches[0], touches[1])),
              ),
            });
            return;
          }

          const initial = origin.touches[0];
          propsRef.current.onChange({
            position: {
              x: clamp(origin.position.x + (touches[0].pageX - initial.pageX) / size.width, -0.5, 1.5),
              y: clamp(origin.position.y + (touches[0].pageY - initial.pageY) / size.height, -0.5, 1.5),
            },
          });
        },
        onPanResponderRelease: () => propsRef.current.onEnd(),
        onPanResponderTerminate: () => propsRef.current.onEnd(),
      }),
    [],
  );

  return (
    <View
      ref={rootRef}
      collapsable={false}
      {...responder.panHandlers}
      onLayout={({ nativeEvent }) => {
        metrics.current = {
          ...metrics.current,
          width: Math.max(1, nativeEvent.layout.width),
          height: Math.max(1, nativeEvent.layout.height),
        };
        rootRef.current?.measureInWindow((pageX, pageY) => {
          metrics.current = { ...metrics.current, pageX, pageY };
        });
      }}
      style={{
        position: 'absolute',
        inset: 0,
        borderWidth: 2,
        borderColor: chrome.accent,
        borderRadius: chrome.radius.lg,
      }}>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: 10,
          top: 10,
          paddingHorizontal: 9,
          paddingVertical: 5,
          borderRadius: chrome.radius.md,
          backgroundColor: chrome.overlay,
        }}>
        <Text style={{ color: chrome.accent, fontSize: 10, fontWeight: '700' }}>
          DRAG • PINCH • TWIST
        </Text>
      </View>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          right: 10,
          top: 10,
          paddingHorizontal: 9,
          paddingVertical: 5,
          borderRadius: chrome.radius.md,
          backgroundColor: chrome.overlay,
        }}>
        <Text style={{ color: '#FFFFFF', fontSize: 10, fontWeight: '800' }}>
          {Math.round(props.transform.scale * 100)}% • {Math.round(props.transform.rotation)}°
        </Text>
      </View>
      <View pointerEvents="none" style={{ position: 'absolute', left: '50%', top: '50%', width: 18, height: 2, marginLeft: -9, marginTop: -1, backgroundColor: 'rgba(223,255,53,0.75)' }} />
      <View pointerEvents="none" style={{ position: 'absolute', left: '50%', top: '50%', width: 2, height: 18, marginLeft: -1, marginTop: -9, backgroundColor: 'rgba(223,255,53,0.75)' }} />
    </View>
  );
}

function readTouches(event: GestureResponderEvent): TouchPoint[] {
  return event.nativeEvent.touches.map((touch) => ({ pageX: touch.pageX, pageY: touch.pageY }));
}

function midpoint(a: TouchPoint, b: TouchPoint): TouchPoint {
  return { pageX: (a.pageX + b.pageX) / 2, pageY: (a.pageY + b.pageY) / 2 };
}

function distance(a: TouchPoint, b: TouchPoint) {
  return Math.hypot(b.pageX - a.pageX, b.pageY - a.pageY);
}

function angle(a: TouchPoint, b: TouchPoint) {
  return (Math.atan2(b.pageY - a.pageY, b.pageX - a.pageX) * 180) / Math.PI;
}

function shortestAngleDelta(from: number, to: number) {
  return normalizeDegrees(to - from);
}

function normalizeDegrees(value: number) {
  let result = value % 360;
  if (result > 180) result -= 360;
  if (result < -180) result += 360;
  return result;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
