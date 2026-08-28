export type EditorRuntimePolicyInput = {
  appState: string;
  blockingUi: boolean;
};

export type EditorRuntimePolicy = {
  mediaAdmitted: boolean;
};

export function resolveEditorRuntimePolicy(input: EditorRuntimePolicyInput): EditorRuntimePolicy {
  return { mediaAdmitted: input.appState === 'active' && !input.blockingUi };
}
