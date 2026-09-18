import { Image } from 'expo-image';
import { View } from 'react-native';
import { resolveLayerGeometry, type LayerGeometryInput } from '@/lib/layer-geometry';
import type { ImageVisualLayer } from '@/types/project';

export function ImageLayerOverlay(props: {
  layer: ImageVisualLayer; geometry?: LayerGeometryInput; selected: boolean; deletable?: boolean;
}) {
  const geometry = resolveLayerGeometry(props.geometry ?? props.layer);
  return <View pointerEvents="none" collapsable={false} style={{ position: 'absolute', inset: 0 }}>
    <View pointerEvents="none" style={{ position: 'absolute',
      left: `${(geometry.position.x - geometry.box.width / 2) * 100}%`, top: `${(geometry.position.y - geometry.box.height / 2) * 100}%`,
      width: `${geometry.box.width * 100}%`, height: `${geometry.box.height * 100}%`,
      transform: [{ rotate: `${geometry.rotation}deg` }, { scaleX: geometry.scale * geometry.scaleX }, { scaleY: geometry.scale * geometry.scaleY }],
    }}><Image source={props.layer.uri} contentFit="contain" style={{ width: '100%', height: '100%', opacity: props.layer.opacity }} /></View>
  </View>;
}
