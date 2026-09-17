import { useRef } from 'react';
import { Image } from 'expo-image';
import { View } from 'react-native';
import { useLayerGesture } from '@/hooks/use-layer-gesture';
import { resolveLayerGeometry } from '@/lib/layer-geometry';
import { LayerTransformOverlay } from './layer-transform-overlay';
import type { ImageVisualLayer } from '@/types/project';

export function ImageLayerOverlay(props: {
  layer: ImageVisualLayer; interactive: boolean; selectable?: boolean; onSelect?: () => void;
  onInteractionStart?: () => void; onChange: (patch: Partial<ImageVisualLayer>) => void; onEnd: () => void; onDelete: () => void;
}) {
  const canvasRef = useRef<View>(null);
  const gesture = useLayerGesture({ id: props.layer.id, geometry: props.layer, interactive: props.interactive,
    onStart: props.onInteractionStart, onChange: props.onChange, onEnd: props.onEnd });
  const geometry = resolveLayerGeometry(gesture.geometry);
  return <View ref={canvasRef} pointerEvents="box-none" collapsable={false} style={{ position: 'absolute', inset: 0, zIndex: props.interactive ? 100 : 0 }} onLayout={({ nativeEvent }) => {
    gesture.measureCanvas(nativeEvent.layout.width, nativeEvent.layout.height, canvasRef.current);
  }}>
    <View pointerEvents="none" style={{ position: 'absolute',
      left: `${(geometry.position.x - geometry.box.width / 2) * 100}%`, top: `${(geometry.position.y - geometry.box.height / 2) * 100}%`,
      width: `${geometry.box.width * 100}%`, height: `${geometry.box.height * 100}%`,
      transform: [{ rotate: `${geometry.rotation}deg` }, { scaleX: geometry.scale * geometry.scaleX }, { scaleY: geometry.scale * geometry.scaleY }],
    }}><Image source={props.layer.uri} contentFit="contain" style={{ width: '100%', height: '100%', opacity: props.layer.opacity }} /></View>
    <LayerTransformOverlay geometry={geometry} interactive={props.interactive} selectable={props.selectable} responders={gesture.responders} onSelect={props.onSelect} onDelete={props.onDelete} />
  </View>;
}
