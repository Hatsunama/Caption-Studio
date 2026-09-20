export type EditorRuntimePolicyInput = {
  appState: string;
  blockingUi: boolean;
};

export type EditorRuntimePolicy = {
  mediaAdmitted: boolean;
  videoSurfacesAdmitted: boolean;
};

export function resolveEditorRuntimePolicy(input: EditorRuntimePolicyInput): EditorRuntimePolicy {
  const foreground = input.appState === 'active' || input.appState === 'unknown';
  return {
    mediaAdmitted: foreground && !input.blockingUi,
    // A modal pauses playback, but must not detach a surface being prepared.
    videoSurfacesAdmitted: foreground,
  };
}
