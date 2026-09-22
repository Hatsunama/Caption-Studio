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

test('GitHub Pages publishes only the public privacy surface while the app stays local-only', () => {
  const workflow = readFileSync(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  const inApp = readFileSync(new URL('../src/app/privacy.tsx', import.meta.url), 'utf8');
  assert.equal(existsSync(new URL('../docs/privacy/index.html', import.meta.url)), true);
  assert.match(workflow, /cp -R docs\/privacy\/\. _site\/privacy\//);
  assert.match(workflow, /with:\s*\n\s*path: _site/);
  assert.doesNotMatch(workflow, /with:\s*\n\s*path: docs(?:\s|$)/);
  assert.doesNotMatch(inApp, /https:\/\/|Linking\.openURL/);
});
