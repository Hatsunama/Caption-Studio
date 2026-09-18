import { useMemo } from 'react';
import { View } from 'react-native';
import { resolveCaptionStyle } from '@/lib/style-resolver';
import { LayerTransformOverlay } from './layer-transform-overlay';
import { CaptionPresentation } from './caption-presentation';
import type { LayerGeometryInput } from '@/lib/layer-geometry';
import type { CaptionBlock, CaptionStyle, WordToken } from '@/types/project';

export function CaptionOverlay(props: {
  caption?: CaptionBlock;
  captions?: readonly CaptionBlock[];
  selectionCaption?: CaptionBlock;
  selectionStyle?: CaptionStyle;
  geometry?: LayerGeometryInput;
  words: WordToken[];
  projectStyle: CaptionStyle;
  currentMs: number;
  selected?: boolean;
  deletable?: boolean;
  preserveLineBreaks?: boolean;
  editingPreview?: boolean;
}) {
  const style = useMemo(() => resolveCaptionStyle(props.projectStyle, props.caption), [props.projectStyle, props.caption]);
  const selectionStyle = useMemo(() => props.selectionStyle
    ?? (props.selectionCaption ? resolveCaptionStyle(props.projectStyle, props.selectionCaption) : style),
  [props.selectionStyle, props.selectionCaption, props.projectStyle, style]);
  const geometry = props.geometry ?? selectionStyle;
  if (!props.caption && !props.selectionCaption) return null;
  return <View pointerEvents="none" collapsable={false} style={{ position: 'absolute', inset: 0 }}>
    {(props.captions ?? (props.caption ? [props.caption] : [])).map((caption) => (
      <CaptionPresentation key={caption.id} caption={caption} words={props.words} projectStyle={props.projectStyle}
        geometry={geometry}
        currentMs={props.currentMs} authored={Boolean(props.preserveLineBreaks)} editingPreview={props.editingPreview} />
    ))}
    <LayerTransformOverlay geometry={geometry} selected={props.selected} deletable={props.deletable} />
  </View>;
}
