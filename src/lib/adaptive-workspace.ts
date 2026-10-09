type WorkspaceInput = {
  width: number;
  height: number;
  windowHeight: number;
  scriptEditorOpen: boolean;
  keyboardOpen: boolean;
  bottomInset?: number;
  topInset?: number;
};

export function editorWorkspaceLayout(input: WorkspaceInput) {
  const width = Math.max(0, input.width);
  const height = Math.max(0, input.height - Math.max(0, input.topInset ?? 0));
  const sideBySide = width >= 640 && width > height * 1.2;
  const previewWidth = sideBySide ? Math.min(width * 0.46, width - 320) : width;
  const bottomInset = Math.max(0, input.bottomInset ?? 0);
  const portraitPreview = input.scriptEditorOpen
    ? input.keyboardOpen
      ? Math.max(0, Math.min(180, height * 0.4, height - 145))
      : Math.min(500, height * 0.4)
    : Math.min(Math.max(280, input.windowHeight * 0.43), 500);
  return {
    sideBySide,
    previewWidth,
    editorWidth: sideBySide ? width - previewWidth : width,
    previewHeight: sideBySide
      ? Math.max(0, height - bottomInset)
      : Math.max(0, Math.min(portraitPreview, height - (input.scriptEditorOpen ? 145 : 144 + bottomInset))),
  };
}
