import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const translator = readFileSync(fileURLToPath(new URL(
  '../modules/caption-translation/android/src/main/java/app/captionstudio/translation/NaturalCaptionTranslator.java',
  import.meta.url,
)), 'utf8');

test('model verification duration is recorded even when verification fails', () => {
  assert.match(translator, /long verificationStartNanos = System\.nanoTime\(\);/);
  assert.match(translator, /try \{\s*modelVerifier\.verify\([\s\S]*?\);\s*\} finally \{\s*run\.verificationMs = elapsedMilliseconds\(verificationStartNanos\);\s*logVerificationMetrics\(run\.verificationMs\);\s*\}/);
});

test('successful translation exposes verification time beside batch metrics', () => {
  assert.match(translator, /result\.put\("verificationMs", run\.verificationMs\);/);
  assert.match(translator, /result\.put\("batchMetrics", run\.metrics\);/);
});
