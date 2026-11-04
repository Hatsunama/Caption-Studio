import assert from 'node:assert/strict';
import test from 'node:test';
import { editorLayerSelection, editorSelectionState } from '../src/lib/editor-selection.ts';

test('selecting an overlay video opens sticker tools without selecting the main video clip', () => {
  const layer = { id: 'pip-1', kind: 'video' };
  const selection = editorLayerSelection({ captionTracks: { translations: [] }, layers: [layer] }, layer.id);
  assert.deepEqual(selection, { kind: 'video-overlay', id: layer.id });
  const state = editorSelectionState(selection);
  assert.equal(state.tool, 'stickers');
  assert.equal(state.layerId, layer.id);
  assert.equal(state.clipId, undefined);
});
