import { useMemo, useRef } from 'react';
import { Image } from 'expo-image';
import { type GestureResponderEvent, PanResponder, Pressable, Text, View } from 'react-native';

import type { ImageVisualLayer } from '@/types/project';

type Touch = { pageX: number; pageY: number };

export function ImageLayerOverlay(props: {
  layer: ImageVisualLayer;
  interactive: boolean;
  selectable?: boolean;
  onSelect?: () => void;
  onInteractionStart?: () => void;
  onChange: (patch: Partial<ImageVisualLayer>) => void;
  onEnd: () => void;
  onDelete: () => void;
}) {
  const propsRef = useRef(props);
  propsRef.current = props;
  const canvas = useRef({ width: 1, height: 1 });
  const start = useRef({
    position: props.layer.position,
    box: props.layer.box,
    rotation: props.layer.rotation,
    touches: [] as Touch[],
    touchCount: 0,
  });

  const rebase = (touches: Touch[]) => {
    const layer = propsRef.current.layer;
    start.current = {
      position: { ...layer.position },
      box: { ...layer.box },
      rotation: layer.rotation,
      touches,
      touchCount: touches.length >= 2 ? 2 : 1,
    };
  };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => Boolean(propsRef.current.interactive || propsRef.current.selectable),
        onMoveShouldSetPanResponder: () => propsRef.current.interactive,
        onPanResponderGrant: (event) => {
          if (!propsRef.current.interactive) {
            propsRef.current.onSelect?.();
            return;
          }
          propsRef.current.onInteractionStart?.();
          rebase(readTouches(event));
        },
        onPanResponderMove: (event) => {
          if (!propsRef.current.interactive) return;
          const touches = readTouches(event);
          if (touches.length === 0) return;
          const count = touches.length >= 2 ? 2 : 1;
          if (count !== start.current.touchCount) {
            rebase(touches);
            return;
          }
          const size = canvas.current;
          if (count === 2 && start.current.touches.length >= 2) {
            const initialCenter = midpoint(start.current.touches[0], start.current.touches[1]);
            const nextCenter = midpoint(touches[0], touches[1]);
            const initialDistance = distance(start.current.touches[0], start.current.touches[1]);
            const scale = initialDistance > 8 ? distance(touches[0], touches[1]) / initialDistance : 1;
            propsRef.current.onChange({
              position: {
                x: clamp(start.current.position.x + (nextCenter.pageX - initialCenter.pageX) / size.width, 0, 1),
                y: clamp(start.current.position.y + (nextCenter.pageY - initialCenter.pageY) / size.height, 0, 1),
              },
              box: {
                width: clamp(start.current.box.width * scale, 0.06, 1.5),
                height: clamp(start.current.box.height * scale, 0.04, 1.5),
              },
              rotation: normalize(start.current.rotation + angleDelta(angle(start.current.touches[0], start.current.touches[1]), angle(touches[0], touches[1]))),
            });
          } else {
            propsRef.current.onChange({
              position: {
                x: clamp(start.current.position.x + (touches[0].pageX - start.current.touches[0].pageX) / size.width, 0, 1),
                y: clamp(start.current.position.y + (touches[0].pageY - start.current.touches[0].pageY) / size.height, 0, 1),
              },
            });
          }
        },
        onPanResponderRelease: () => propsRef.current.onEnd(),
        onPanResponderTerminate: () => propsRef.current.onEnd(),
      }),
    [],
  );

  return (
    <View
      pointerEvents="box-none"
      onLayout={({ nativeEvent }) => {
        canvas.current = {
          width: Math.max(1, nativeEvent.layout.width),
          height: Math.max(1, nativeEvent.layout.height),
        };
      }}
      style={{ position: 'absolute', inset: 0 }}>
      <View
        {...responder.panHandlers}
        style={{
          position: 'absolute',
          left: `${(props.layer.position.x - props.layer.box.width / 2) * 100}%`,
          top: `${(props.layer.position.y - props.layer.box.height / 2) * 100}%`,
          width: `${props.layer.box.width * 100}%`,
          height: `${props.layer.box.height * 100}%`,
          minWidth: 36,
          minHeight: 36,
          transform: [{ rotate: `${props.layer.rotation}deg` }],
          borderWidth: props.interactive ? 2 : 0,
          borderColor: '#64E8FF',
        }}>
        <Image source={props.layer.uri} contentFit="contain" style={{ width: '100%', height: '100%', opacity: props.layer.opacity }} />
        {props.interactive ? (
          <>
            <Pressable
              onPress={props.onDelete}
              hitSlop={10}
              style={{ position: 'absolute', left: -20, top: -20, width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20, backgroundColor: '#FF5267' }}>
              <Text style={{ color: '#FFF', fontSize: 22, fontWeight: '900' }}>×</Text>
            </Pressable>
            <ImageCornerHandle layer={props.layer} canvas={canvas} onStart={props.onInteractionStart} onChange={props.onChange} onEnd={props.onEnd} />
          </>
        ) : null}
      </View>
    </View>
  );
}

function ImageCornerHandle(props: {
  layer: ImageVisualLayer;
  canvas: React.RefObject<{ width: number; height: number }>;
  onStart?: () => void;
  onChange: (patch: Partial<ImageVisualLayer>) => void;
  onEnd: () => void;
}) {
  const propsRef = useRef(props);
  propsRef.current = props;
  const start = useRef({ box: props.layer.box });
  const responder = useMemo(
    () => PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        propsRef.current.onStart?.();
        start.current = { box: { ...propsRef.current.layer.box } };
      },
      onPanResponderMove: (_event, gesture) => {
        const size = propsRef.current.canvas.current;
        const scale = clamp(1 + (gesture.dx + gesture.dy) / Math.max(100, (size.width + size.height) * 0.35), 0.2, 5);
        propsRef.current.onChange({
          box: { width: clamp(start.current.box.width * scale, 0.06, 1.5), height: clamp(start.current.box.height * scale, 0.04, 1.5) },
        });
      },
      onPanResponderRelease: () => propsRef.current.onEnd(),
      onPanResponderTerminate: () => propsRef.current.onEnd(),
    }),
    [],
  );
  return (
    <View {...responder.panHandlers} style={{ position: 'absolute', right: -23, bottom: -23, width: 46, height: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 23, backgroundColor: '#64E8FF' }}>
      <Text pointerEvents="none" style={{ color: '#092028', fontSize: 19, fontWeight: '900' }}>↘</Text>
    </View>
  );
}

function readTouches(event: GestureResponderEvent): Touch[] {
  return event.nativeEvent.touches.map((touch) => ({ pageX: touch.pageX, pageY: touch.pageY }));
}
function midpoint(a: Touch, b: Touch): Touch { return { pageX: (a.pageX + b.pageX) / 2, pageY: (a.pageY + b.pageY) / 2 }; }
function distance(a: Touch, b: Touch) { return Math.hypot(b.pageX - a.pageX, b.pageY - a.pageY); }
function angle(a: Touch, b: Touch) { return Math.atan2(b.pageY - a.pageY, b.pageX - a.pageX) * 180 / Math.PI; }
function angleDelta(from: number, to: number) { return normalize(to - from); }
function normalize(value: number) { let next = value % 360; if (next > 180) next -= 360; if (next < -180) next += 360; return next; }
function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }
