import type { CaptionProject, VideoVisualLayer, VisualLayer } from '@/types/project';

export function isAudibleVideoOverlay(layer: VisualLayer): layer is VideoVisualLayer {
  return layer.kind === 'video' && layer.includeAudio && layer.visible
    && layer.timelineVisible !== false && Boolean(layer.uri.trim());
}

/** Audio is controlled by Include audio and layer visibility, independently of picture opacity. */
export function audibleVideoOverlaysWithin(project: CaptionProject, durationMs: number) {
  return project.layers.flatMap((layer) => {
    if (!isAudibleVideoOverlay(layer)) return [];
    const startMs = Math.max(0, layer.startMs);
    const sourceStartMs = layer.sourceStartMs + (startMs - layer.startMs) * layer.playbackRate;
    const endMs = Math.min(durationMs, layer.endMs,
      startMs + Math.max(0, layer.sourceDurationMs - sourceStartMs) / layer.playbackRate);
    if (endMs <= startMs || sourceStartMs >= layer.sourceDurationMs) return [];
    return [{ id: `overlay-audio:${layer.id}`, uri: layer.uri, startMs, endMs,
      sourceStartMs, sourceEndMs: sourceStartMs + (endMs - startMs) * layer.playbackRate,
      playbackRate: layer.playbackRate }];
  });
}
