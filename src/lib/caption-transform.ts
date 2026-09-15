import { resolveLayerGeometry } from '@/lib/layer-geometry';
import type { CaptionStylePatch } from '@/types/project';

// Geometry belongs to a caption timeline track. Cue/word overrides own text
// appearance only; keep this list shared by both language mutation boundaries.
export const CAPTION_TRANSFORM_KEYS = ['position', 'box', 'rotation', 'scale', 'scaleX', 'scaleY'] as const;

export function hasCaptionTransform(patch: CaptionStylePatch) {
  return CAPTION_TRANSFORM_KEYS.some((key) => patch[key] !== undefined);
}

export function withoutCaptionTransform(patch?: CaptionStylePatch): CaptionStylePatch | undefined {
  if (!patch) return undefined;
  const next = { ...patch };
  for (const key of CAPTION_TRANSFORM_KEYS) delete next[key];
  return Object.keys(next).length ? next : undefined;
}

export { resolveLayerGeometry as captionTransform };
