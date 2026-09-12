import type { CaptionProject } from '@/types/project';

export type EditorTool = 'captions' | 'stickers' | 'video' | 'audio';

export type EditorSelection =
  | { kind: 'video' | 'audio'; id: string }
  | { kind: 'captions'; captionId?: string }
  | { kind: 'translation'; id: string; captionId?: string }
  | { kind: 'text' | 'image'; id: string };

const SELECTION_TO_TOOL = {
  video: 'video',
  audio: 'audio',
  captions: 'captions',
  translation: 'captions',
  text: 'stickers',
  image: 'stickers',
} as const satisfies Record<EditorSelection['kind'], EditorTool>;

export function shouldOpenEditorTool(current: EditorTool, next: EditorTool) {
  return current !== next;
}

export function editorSelectionState(selection: EditorSelection) {
  return {
    tool: SELECTION_TO_TOOL[selection.kind],
    clipId: selection.kind === 'video' ? selection.id : undefined,
    audioClipId: selection.kind === 'audio' ? selection.id : undefined,
    captionId: selection.kind === 'captions' || selection.kind === 'translation' ? selection.captionId : undefined,
    layerId: selection.kind === 'captions' ? 'captions'
      : selection.kind === 'translation' || selection.kind === 'text' || selection.kind === 'image' ? selection.id : undefined,
    translationTrackId: selection.kind === 'translation' ? selection.id : undefined,
  };
}

export function editorLayerSelection(
  project: CaptionProject,
  layerId: string,
  captionId?: string,
): EditorSelection | undefined {
  if (project.captionTracks.translations.some((track) => track.id === layerId)) {
    return { kind: 'translation', id: layerId, captionId };
  }
  const layer = project.layers.find((candidate) => candidate.id === layerId);
  if (!layer) return undefined;
  return layer.kind === 'captions'
    ? { kind: 'captions', captionId }
    : { kind: layer.kind, id: layer.id };
}
