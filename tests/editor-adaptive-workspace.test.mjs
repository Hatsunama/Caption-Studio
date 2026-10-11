import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
const expression = source.match(/const previewHeight = ([\s\S]*?);\r?\n/)[1];
const url = new URL('../src/lib/adaptive-workspace.ts', import.meta.url);
const policy = existsSync(url) ? await import(url) : undefined;
function preview(context) {
  const workspaceLayout = policy?.editorWorkspaceLayout({ width: context.width, height: context.workspaceHeight,
    windowHeight: context.height, scriptEditorOpen: context.scriptEditorOpen, keyboardOpen: context.scriptKeyboardOpen });
  return runInNewContext(expression, { ...context, workspaceLayout });
}
test('a short native root reserves timeline and toolbar space', () => {
  assert.ok(preview({ width: 300, height: 800, workspaceHeight: 252, scriptEditorOpen: false, scriptKeyboardOpen: false }) <= 108);
});
test('the established portrait preview is preserved when the root has room', () => {
  assert.equal(preview({ width: 360, height: 800, workspaceHeight: 744, scriptEditorOpen: false, scriptKeyboardOpen: false }), 344);
});
test('wide roots place useful media beside an independently usable editor', () => {
  assert.ok(policy, 'adaptive workspace policy is required');
  const value = policy.editorWorkspaceLayout({ width: 780, height: 312, windowHeight: 360, scriptEditorOpen: false, keyboardOpen: false });
  assert.equal(value.sideBySide, true);
  assert.ok(value.previewWidth >= 240 && value.editorWidth >= 320);
  assert.ok(value.previewWidth + value.editorWidth <= 780 && value.previewHeight <= 312);
});
test('the typing root retains caption rows above the keyboard', () => {
  assert.ok(preview({ width: 360, height: 800, workspaceHeight: 220, scriptEditorOpen: true, scriptKeyboardOpen: true }) <= 75);
});

test('a hidden-header landscape workspace reserves the actual top system inset', () => {
  const layout = policy.editorWorkspaceLayout({ width: 760, height: 360, windowHeight: 360, topInset: 24, bottomInset: 16, scriptEditorOpen: false, keyboardOpen: false });
  assert.equal(layout.sideBySide, true);
  assert.equal(layout.previewHeight, 320);
});
