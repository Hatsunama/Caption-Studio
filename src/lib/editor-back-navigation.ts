export type EditorBackStep =
  | 'blocked'
  | 'cancel-caption-generation'
  | 'cancel-video-export'
  | 'close-text-editor'
  | 'close-font-browser'
  | 'close-style-scope'
  | 'close-transition-timing'
  | 'close-audio-source'
  | 'close-language-picker'
  | 'close-dual-caption-editor'
  | 'close-script-editor'
  | 'clear-selection'
  | 'reveal-timeline'
  | 'confirm-exit';

export interface EditorBackState {
  interactionLocked: boolean;
  captionGenerationActive: boolean;
  videoExportActive: boolean;
  textEditorOpen: boolean;
  fontBrowserOpen: boolean;
  styleScopeOpen: boolean;
  transitionTimingOpen: boolean;
  audioSourceOpen: boolean;
  languagePickerOpen: boolean;
  dualCaptionEditorOpen: boolean;
  scriptEditorOpen: boolean;
  selectionActive: boolean;
  timelineRooted: boolean;
}

export function resolveEditorBackStep(state: EditorBackState): EditorBackStep {
  if (state.interactionLocked) return 'blocked';
  if (state.captionGenerationActive) return 'cancel-caption-generation';
  if (state.videoExportActive) return 'cancel-video-export';
  if (state.textEditorOpen) return 'close-text-editor';
  if (state.fontBrowserOpen) return 'close-font-browser';
  if (state.styleScopeOpen) return 'close-style-scope';
  if (state.transitionTimingOpen) return 'close-transition-timing';
  if (state.audioSourceOpen) return 'close-audio-source';
  if (state.languagePickerOpen) return 'close-language-picker';
  if (state.dualCaptionEditorOpen) return 'close-dual-caption-editor';
  if (state.scriptEditorOpen) return 'close-script-editor';
  if (state.selectionActive) return 'clear-selection';
  if (!state.timelineRooted) return 'reveal-timeline';
  return 'confirm-exit';
}
