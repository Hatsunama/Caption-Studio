import { Text, View } from 'react-native';
import { layerExtent, type LayerGeometryInput, type LayerGestureMode } from '@/lib/layer-geometry';
import { chrome } from '@/lib/ui-theme';

export function LayerTransformOverlay(props: {
  geometry: LayerGeometryInput; selected?: boolean; deletable?: boolean;
}) {
  if (!props.selected) return null;
  const extent = layerExtent(props.geometry);
  return <View pointerEvents="none" style={{ position: 'absolute',
    left: `${(props.geometry.position.x - extent.width / 2) * 100}%`, top: `${(props.geometry.position.y - extent.height / 2) * 100}%`,
    width: `${extent.width * 100}%`, height: `${extent.height * 100}%`, transform: [{ rotate: `${props.geometry.rotation}deg` }],
  }}>
    <>
      <View pointerEvents="none" style={{ position: 'absolute', inset: 0, borderWidth: 2, borderColor: chrome.accent, borderRadius: 4 }} />
      {(['left', 'right', 'top', 'bottom', 'corner'] as LayerGestureMode[]).map((mode) => {
        const horizontal = mode === 'left' || mode === 'right';
        const corner = mode === 'corner';
        return <View key={mode} style={{ position: 'absolute', zIndex: 20,
          ...(corner ? { right: -23, bottom: -23, width: 46, height: 46 } : horizontal
            ? { [mode]: -18, top: '50%', marginTop: -30, width: 36, height: 60 }
            : { [mode]: -18, left: '50%', marginLeft: -30, width: 60, height: 36 }),
          alignItems: 'center', justifyContent: 'center',
        }}><View pointerEvents="none" style={{ width: corner ? 40 : horizontal ? 7 : 36, height: corner ? 40 : horizontal ? 36 : 7,
          borderRadius: corner ? 22 : 6, backgroundColor: chrome.accent, alignItems: 'center', justifyContent: 'center' }}>
          {corner ? <Text style={{ color: '#11140C', fontSize: 19 }}>{'\u2198'}</Text> : null}
        </View></View>;
      })}
      {props.deletable ? <View
        style={{ position: 'absolute', left: -20, top: -20, zIndex: 30, width: 40, height: 40, borderRadius: 20, backgroundColor: '#FF5267', alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#FFFFFF', fontSize: 22 }}>{'\u00d7'}</Text>
      </View> : null}
    </>
  </View>;
}
