import type { CaptionProject, VideoVisualLayer, VisualLayer } from '@/types/project';
import { videoOverlaySegments } from '@/lib/video-overlay-segments';

export function isAudibleVideoOverlay(layer: VisualLayer): layer is VideoVisualLayer {
  return layer.kind === 'video' && layer.includeAudio && layer.visible
    && layer.timelineVisible !== false && Boolean(layer.uri.trim());
}

/** Audio is controlled by Include audio and layer visibility, independently of picture opacity. */
export function audibleVideoOverlaysWithin(project: CaptionProject, durationMs: number) {
  return project.layers.flatMap((layer) => {
    if (!isAudibleVideoOverlay(layer)) return [];
    return videoOverlaySegments(layer, project.clips, durationMs).map((segment) => ({
      id: `overlay-audio:${layer.id}`, uri: layer.uri, ...segment, playbackRate: layer.playbackRate,
    }));
  });
}
