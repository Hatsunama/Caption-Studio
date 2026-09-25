import assert from 'node:assert/strict';
import test from 'node:test';
import { previewInteractionAtPoint } from '../src/lib/preview-object-hit-test.ts';

test('a selected back-most video cannot hide a foreground object under its resize chrome', () => {
  const video = { key: 'video:one', order: -1, yieldToForeground: true,
    selection: { kind: 'video', id: 'one' },
    geometry: { position: { x: 0.5, y: 0.5 }, box: { width: 1, height: 1 },
      scale: 1, scaleX: 1, scaleY: 1, rotation: 0 } };
  const caption = { key: 'translation:zh:one', order: 1,
    selection: { kind: 'translation', id: 'zh', captionId: 'one' },
    geometry: { position: { x: 0.5, y: 0.08 }, box: { width: 0.4, height: 0.1 },
      scale: 1, scaleX: 1, scaleY: 1, rotation: 0 } };
  const interaction = previewInteractionAtPoint([video, caption], video.key,
    { x: 200, y: 16 }, { width: 400, height: 300 });
  assert.equal(interaction?.target.key, caption.key);
  assert.equal(interaction?.mode, 'move');
});
