import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const overlay = readFileSync(new URL('../src/components/editor/caption-overlay.tsx', import.meta.url), 'utf8');
const painter = readFileSync(new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/TimelineTextPainter.kt', import.meta.url), 'utf8');

test('caption and authored text editing route through the shared presentation without local font caps', () => {
  assert.match(overlay, /<CaptionPresentation/);
  assert.match(overlay, /editingPreview=\{props\.editingPreview\}/);
  assert.doesNotMatch(overlay, /fitAuthoredTextFont|fitCaptionFont|numberOfLines|glyphWidth/);
});

test('paused editing disables effects while keeping the production measured layout', () => {
  assert.match(painter, /val fitted = presentationFor\(caption, words, outputWidth, outputHeight, authored\)/);
  assert.match(painter, /if \(editing\) TextAnimationState\(\) else captionAnimationState/);
  assert.match(painter, /val visible = editing \|\|/);
  assert.match(painter, /if \(!editing && style\.animationId\.startsWith\("emoji-"\)\)/);
});
