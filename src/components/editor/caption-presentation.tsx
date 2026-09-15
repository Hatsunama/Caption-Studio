import { memo, useEffect, useMemo, useState } from 'react';
import { requireNativeView } from 'expo';
import { Text, type ViewProps } from 'react-native';
import { resolveCaptionStyle } from '@/lib/style-resolver';
import { omitUndefinedDeep, serializeStyle } from '@/lib/export-render-plan';
import { resolveLayerGeometry, type LayerGeometryInput } from '@/lib/layer-geometry';
import { resolveExportFontUris } from '@/services/export-font-assets';
import type { CaptionBlock, CaptionStyle, WordToken } from '@/types/project';

const NativeCaptionPresentation = requireNativeView<ViewProps & {
  caption: Record<string, unknown>; geometry: Record<string, unknown>; currentMs: number; authored: boolean; editingPreview: boolean;
}>('CaptionMedia');

const fontRequests = new Map<string, ReturnType<typeof resolveExportFontUris>>();
function resolveFonts(families: string[]) {
  const key = families.sort().join('|');
  let request = fontRequests.get(key);
  if (!request) {
    request = resolveExportFontUris(families);
    fontRequests.set(key, request);
    void request.catch(() => fontRequests.delete(key));
  }
  return request;
}

export const CaptionPresentation = memo(function CaptionPresentation(props: {
  caption: CaptionBlock; words: WordToken[]; projectStyle: CaptionStyle; geometry: LayerGeometryInput;
  currentMs: number; authored: boolean; editingPreview?: boolean;
}) {
  const styles = useMemo(() => {
    const style = resolveCaptionStyle(props.projectStyle, props.caption);
    const byId = new Map(props.words.map((word) => [word.id, word]));
    const words = props.caption.wordIds.flatMap((id) => {
      const word = byId.get(id);
      return word ? [{ ...word, style: resolveCaptionStyle(props.projectStyle, props.caption, word) }] : [];
    });
    return { style, words };
  }, [props.projectStyle, props.caption, props.words]);
  const families = [...new Set([styles.style, ...styles.words.map((word) => word.style)]
    .filter((style) => style.font.source === 'built-in').map((style) => style.font.family))].sort().join('|');
  const [fonts, setFonts] = useState<{ key: string; uris: ReadonlyMap<string, string> }>({ key: '', uris: new Map() });
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    setError(undefined);
    void resolveFonts(families ? families.split('|') : []).then((uris) => { if (active) setFonts({ key: families, uris }); })
      .catch((caught: Error) => { if (active) setError(caught.message); });
    return () => { active = false; };
  }, [families]);
  const caption = useMemo(() => omitUndefinedDeep({
    id: props.caption.id, text: props.caption.text, startMs: props.caption.startMs, endMs: props.caption.endMs,
    style: serializeStyle(styles.style, fonts.uris),
    words: styles.words.map((word) => ({ text: word.text, startMs: word.startMs, endMs: word.endMs, style: serializeStyle(word.style, fonts.uris) })),
  }), [props.caption, styles, fonts]);
  if (error) return <Text accessibilityRole="alert" style={{ color: '#FF5267' }}>{error}</Text>;
  if (fonts.key !== families) return null;
  return <NativeCaptionPresentation pointerEvents="none" style={{ position: 'absolute', inset: 0 }}
    caption={caption} geometry={resolveLayerGeometry(props.geometry)} currentMs={props.currentMs}
    authored={props.authored} editingPreview={Boolean(props.editingPreview)} />;
});
