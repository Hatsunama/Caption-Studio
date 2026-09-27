import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('onboarding links do not pin an old Android release', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const onboarding = readme.split('\n').slice(0, 90).join('\n');
  assert.match(onboarding, /https:\/\/github\.com\/Hatsunama\/Caption-Studio\/releases\b/);
  assert.doesNotMatch(onboarding, /releases\/(?:tag|download)\/v\d+\.\d+\.\d+/);
});
