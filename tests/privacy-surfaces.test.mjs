import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('public and in-app privacy surfaces state the shipped local runtime, backup limits, and plain legal contact', () => {
  const markdown = readFileSync(new URL('../PRIVACY.md', import.meta.url), 'utf8');
  const publicHtml = readFileSync(new URL('../docs/privacy/index.html', import.meta.url), 'utf8');
  const inApp = readFileSync(new URL('../src/app/privacy.tsx', import.meta.url), 'utf8');
  for (const policy of [markdown, publicHtml, inApp]) {
    assert.doesNotMatch(policy, /ML Kit|MediaPipe|background-removal/);
    assert.match(policy, /device-to-device migration/);
    assert.match(policy, /xmilo_at_your_side@proton\.me/);
    assert.doesNotMatch(policy, /security\/advisories\/new/);
  }
});

test('public and store copy describe one caption model and supported multilingual translation', () => {
  const markdown = readFileSync(new URL('../PRIVACY.md', import.meta.url), 'utf8');
  const publicHtml = readFileSync(new URL('../docs/privacy/index.html', import.meta.url), 'utf8');
  const listing = readFileSync(new URL('../play-store/listing.md', import.meta.url), 'utf8');
  const safety = readFileSync(new URL('../play-store/data-safety-notes.md', import.meta.url), 'utf8');
  for (const policy of [markdown, publicHtml]) {
    assert.match(policy, /one multilingual Whisper tiny model and a Silero VAD/);
    assert.match(policy, /supported caption-language pair/);
    assert.doesNotMatch(policy, /first choose|English.Chinese translation/);
  }
  assert.match(listing, /one downloadable Whisper tiny model and speech detection/);
  assert.doesNotMatch(listing, /Fast, Balanced, and Accurate|selected model|English.Chinese translation/);
  assert.match(safety, /one immutable, hash-pinned multilingual Whisper tiny model and one Silero VAD/);
  assert.match(safety, /supported caption-language pairs/);
  assert.doesNotMatch(safety, /first transcription-model selection|English.Chinese translation/);
});

test('GitHub Pages publishes only the public privacy surface while the app stays local-only', () => {
  const workflow = readFileSync(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  const inApp = readFileSync(new URL('../src/app/privacy.tsx', import.meta.url), 'utf8');
  assert.equal(existsSync(new URL('../docs/privacy/index.html', import.meta.url)), true);
  assert.match(workflow, /cp -R docs\/privacy\/\. _site\/privacy\//);
  assert.match(workflow, /with:\s*\n\s*path: _site/);
  assert.doesNotMatch(workflow, /with:\s*\n\s*path: docs(?:\s|$)/);
  assert.doesNotMatch(inApp, /https:\/\/|Linking\.openURL/);
});
