import type { CaptionBlock, CaptionProject } from '@/types/project';

/** Selection never participates in the content query at the fixed playhead. */
export function captionPreviewState(captions: readonly CaptionBlock[], currentMs: number, selectedId?: string) {
  const active = captions.filter((caption) => caption.timelineVisible !== false
    && currentMs >= caption.startMs && currentMs < caption.endMs);
  return {
    active: active[0],
    activeCaptions: active.filter((caption) => caption.text.trim()),
    selected: captions.find((caption) => caption.id === selectedId && caption.timelineVisible !== false),
  };
}

export function projectHasEditorLayer(project: CaptionProject, id?: string) {
  return project.layers.some((layer) => layer.id === id)
    || project.captionTracks.translations.some((track) => track.id === id);
}
