import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const overlay = readFileSync(new URL('../src/components/editor/caption-overlay.tsx', import.meta.url), 'utf8');

test('paused caption editing has a dedicated non-truncating presentation mode', () => {
  assert.match(overlay, /editingPreview\?: boolean/);
  assert.match(overlay, /props\.editingPreview \? undefined : captionAnimationViewStyle/);
  assert.match(overlay, /!props\.editingPreview && style\.animation\.id\.startsWith\('emoji-'\)/);
  assert.match(overlay, /editingPreview \? 1 : 9/);
  assert.match(overlay, /const glyphWidth = editingPreview \? 1\.1 : 0\.62/);
  assert.match(overlay, /props\.text\.replace\(\/\\r\\n\/g, '\\n'\)\.split\('\\n'\)/);
  assert.match(overlay, /numberOfLines=\{1\}/);
});

test('ordinary authored text retains the production sizing floor', () => {
  assert.match(overlay, /fitAuthoredTextFont\(props\.style, props\.text, props\.canvas, props\.editingPreview\)/);
  assert.match(overlay, /editingPreview = false/);
});
