import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
const preview = readFileSync(new URL('../src/services/person-compositor.ts', import.meta.url), 'utf8');
const exporter = readFileSync(new URL('../src/services/project-export.ts', import.meta.url), 'utf8');
const privacy = readFileSync(new URL('../src/app/privacy.tsx', import.meta.url), 'utf8');
const nativeModule = readFileSync(
  new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/CaptionMediaModule.kt', import.meta.url),
  'utf8',
);
const matte = readFileSync(
  new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/PersonMatteProcessor.kt', import.meta.url),
  'utf8',
);

test('optional Google ML processing is disclosed and consent-gated at every runtime entry point', () => {
  assert.match(editor, /Google MediaPipe and ML Kit can send encrypted engagement/);
  assert.match(editor, /Not now/);
  assert.match(editor, /Allow and enable/);
  assert.match(preview, /await requireBackgroundProcessingConsent\(\)/);
  assert.match(exporter, /project\.backgroundReplacement\.enabled[\s\S]*await session\.waitFor\(requireBackgroundProcessingConsent\(\)\)/);
});

test('background ML providers remain lazy until the optional feature is actually used', () => {
  assert.match(nativeModule, /private var previewSegmenter: MediaPipePersonSegmenter\? = null/);
  assert.match(nativeModule, /previewSegmenter \?: MediaPipePersonSegmenter\(context\)/);
  assert.match(nativeModule, /private var previewMatteProcessor: PersonMatteProcessor\? = null/);
  assert.match(nativeModule, /releasePreviewModelsLocked\(\)[\s\S]*previewSegmenter\?\.close\(\)[\s\S]*previewMatteProcessor\?\.close\(\)/);
  assert.match(matte, /private val faceDetector = lazy/);
});

test('the in-app privacy screen exposes revocation and a static public policy URL', () => {
  assert.match(privacy, /setBackgroundProcessingConsent\(false\)/);
  assert.match(privacy, /https:\/\/hatsunama\.github\.io\/Caption-Studio\/privacy\//);
});
