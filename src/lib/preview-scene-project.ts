import { resolveCaptionPairs, setTranslationCueStyle } from '@/lib/caption-tracks';
import { sameLayerGeometry, type LayerGeometry } from '@/lib/layer-geometry';
import { setImageLayer, setTextLayerStyle, setVideoClipTransform } from '@/lib/project-editor';
import { videoClipPreviewGeometry } from '@/lib/video-transform';
import { applyStylePatch, resolveCaptionStyle } from '@/lib/style-resolver';
import type { EditorSelection } from '@/lib/editor-selection';
import type { PreviewSceneTarget } from '@/lib/preview-scene-controller';
import type { CaptionProject } from '@/types/project';

/** Resolve captured identity against the latest project, never current selection.
 * Reject removed/replaced geometry so a late release cannot overwrite another edit.
 */
export function applyPreviewSceneGeometry(project: CaptionProject, target: PreviewSceneTarget<EditorSelection>, geometry: LayerGeometry) {
  const selection = target.selection;
  if (selection.kind === 'video') {
    const current = videoClipPreviewGeometry(project, selection.id);
    if (!current || !sameLayerGeometry(current, target.geometry)
      || sameLayerGeometry(target.geometry, geometry)) return project;
    return setVideoClipTransform(project, selection.id, {
      position: geometry.position, scale: geometry.scale,
      scaleX: geometry.scaleX, scaleY: geometry.scaleY, rotation: geometry.rotation,
    });
  }
  if (selection.kind === 'captions') {
    const cue = project.captions.find((caption) => caption.id === selection.captionId);
    if (!cue || !sameLayerGeometry(resolveCaptionStyle(project.projectStyle, cue), target.geometry)
      || sameLayerGeometry(target.geometry, geometry)) return project;
    return applyStylePatch(project, cue.id, 'all', geometry);
  }
  if (selection.kind === 'translation') {
    if (!project.captionTracks.translations.some((track) => track.id === selection.id)) return project;
    const pair = resolveCaptionPairs(project, selection.id).find((candidate) => candidate.source.id === selection.captionId);
    if (!pair || !sameLayerGeometry(pair.style, target.geometry) || sameLayerGeometry(target.geometry, geometry)) return project;
    return setTranslationCueStyle(project, selection.id, pair.source.id, geometry, new Date().toISOString());
  }
  if (selection.kind !== 'text' && selection.kind !== 'image') return project;
  const layer = project.layers.find((candidate) => candidate.id === selection.id && candidate.kind === selection.kind);
  if (!layer || layer.kind === 'captions') return project;
  const current = layer.kind === 'text' ? layer.style : layer;
  if (!sameLayerGeometry(current, target.geometry) || sameLayerGeometry(current, geometry)) return project;
  return layer.kind === 'text' ? setTextLayerStyle(project, layer.id, geometry) : setImageLayer(project, layer.id, geometry);
}
