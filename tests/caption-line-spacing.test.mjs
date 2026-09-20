import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CAPTION_LINE_HEIGHT_MAX,
  CAPTION_LINE_HEIGHT_MIN,
  captionLineHeightAtProgress,
  captionLineHeightProgress,
  normalizeCaptionLineHeight,
} from '../src/lib/caption-line-spacing.ts';

test('caption line spacing stays inside the usable font-relative range', () => {
  assert.equal(CAPTION_LINE_HEIGHT_MIN, 0.72);
  assert.equal(CAPTION_LINE_HEIGHT_MAX, 1.12);
  assert.equal(normalizeCaptionLineHeight(-10), CAPTION_LINE_HEIGHT_MIN);
  assert.equal(normalizeCaptionLineHeight(2.2), CAPTION_LINE_HEIGHT_MAX);
  assert.equal(captionLineHeightAtProgress(0), CAPTION_LINE_HEIGHT_MIN);
  assert.equal(captionLineHeightAtProgress(1), CAPTION_LINE_HEIGHT_MAX);
  assert.equal(captionLineHeightProgress(CAPTION_LINE_HEIGHT_MIN), 0);
  assert.equal(captionLineHeightProgress(CAPTION_LINE_HEIGHT_MAX), 1);
});

test('line spacing is owned by layout baselines rather than glyph geometry', () => {
  const browser = readFileSync(new URL('../src/components/editor/animation-browser.tsx', import.meta.url), 'utf8');
  const schema = readFileSync(new URL('../src/lib/project-schema.ts', import.meta.url), 'utf8');
  const nativePresentation = readFileSync(new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/TextPresentation.kt', import.meta.url), 'utf8');

  assert.match(browser, /captionLineHeightAtProgress/);
  assert.match(browser, /captionLineHeightProgress/);
  assert.match(schema, /normalizeCaptionLineHeight/);
  assert.match(nativePresentation, /setLineSpacing\(0f, style\.lineHeight\)/);
  assert.doesNotMatch(nativePresentation, /fontSize \* run\.style\.lineHeight/);
});
