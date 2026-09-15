import { useMemo, useRef } from 'react';
import { View } from 'react-native';
import { useLayerGesture } from '@/hooks/use-layer-gesture';
import { resolveCaptionStyle } from '@/lib/style-resolver';
import { LayerTransformOverlay } from './layer-transform-overlay';
import { CaptionPresentation } from './caption-presentation';
import type { CaptionBlock, CaptionStyle, CaptionStylePatch, WordToken } from '@/types/project';

export function CaptionOverlay(props: {
  caption?: CaptionBlock;
  words: WordToken[];
  projectStyle: CaptionStyle;
  currentMs: number;
  interactive?: boolean;
  selectable?: boolean;
  preserveLineBreaks?: boolean;
  editingPreview?: boolean;
  onSelect?: () => void;
  onInteractionStart?: () => void;
  onTransform?: (patch: CaptionStylePatch) => void;
  onTransformEnd?: () => void;
  onDelete?: () => void;
}) {
  const canvasRef = useRef<View>(null);
  const style = useMemo(() => resolveCaptionStyle(props.projectStyle, props.caption), [props.projectStyle, props.caption]);
  const gesture = useLayerGesture({ id: props.caption?.id ?? '', geometry: style,
    interactive: props.interactive, selectable: props.selectable, onSelect: props.onSelect,
    onStart: props.onInteractionStart, onChange: props.onTransform, onEnd: props.onTransformEnd });
  if (!props.caption) return null;
  return <View ref={canvasRef} pointerEvents="box-none" collapsable={false} style={{ position: 'absolute', inset: 0 }}
    onLayout={({ nativeEvent }) => {
      gesture.measureCanvas(nativeEvent.layout.width, nativeEvent.layout.height, canvasRef.current);
    }}>
    <CaptionPresentation caption={props.caption} words={props.words} projectStyle={props.projectStyle} geometry={gesture.geometry}
      currentMs={props.currentMs} authored={Boolean(props.preserveLineBreaks)} editingPreview={props.editingPreview} />
    <LayerTransformOverlay geometry={gesture.geometry} interactive={props.interactive} selectable={props.selectable} responders={gesture.responders} onDelete={props.onDelete} />
  </View>;
}
