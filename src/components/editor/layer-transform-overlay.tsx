import { Text, View } from 'react-native';
import { layerExtent, type LayerGeometryInput, type LayerGestureMode } from '@/lib/layer-geometry';
import { chrome } from '@/lib/ui-theme';
import { PREVIEW_CHROME } from '@/lib/preview-object-hit-test';

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
        return <View key={mode} style={{ position: 'absolute',
          ...(corner ? { right: -PREVIEW_CHROME.cornerSize / 2, bottom: -PREVIEW_CHROME.cornerSize / 2,
            width: PREVIEW_CHROME.cornerSize, height: PREVIEW_CHROME.cornerSize } : horizontal
            ? { [mode]: -PREVIEW_CHROME.edgeWidth / 2, top: '50%', marginTop: -PREVIEW_CHROME.edgeLength / 2,
              width: PREVIEW_CHROME.edgeWidth, height: PREVIEW_CHROME.edgeLength }
            : { [mode]: -PREVIEW_CHROME.edgeWidth / 2, left: '50%', marginLeft: -PREVIEW_CHROME.edgeLength / 2,
              width: PREVIEW_CHROME.edgeLength, height: PREVIEW_CHROME.edgeWidth }),
          alignItems: 'center', justifyContent: 'center',
        }}><View pointerEvents="none" style={{ width: corner ? 40 : horizontal ? 7 : 36, height: corner ? 40 : horizontal ? 36 : 7,
          borderRadius: corner ? 22 : 6, backgroundColor: chrome.accent, alignItems: 'center', justifyContent: 'center' }}>
          {corner ? <Text style={{ color: '#11140C', fontSize: 19 }}>{'\u2198'}</Text> : null}
        </View></View>;
      })}
      {props.deletable ? <View
        style={{ position: 'absolute', left: -PREVIEW_CHROME.deleteSize / 2, top: -PREVIEW_CHROME.deleteSize / 2,
          width: PREVIEW_CHROME.deleteSize, height: PREVIEW_CHROME.deleteSize, borderRadius: PREVIEW_CHROME.deleteSize / 2,
          backgroundColor: '#FF5267', alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#FFFFFF', fontSize: 22 }}>{'\u00d7'}</Text>
      </View> : null}
    </>
  </View>;
}
