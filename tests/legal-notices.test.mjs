import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('offline legal notices are present and Metro packages text assets', () => {
  const metro = readFileSync(new URL('../metro.config.js', import.meta.url), 'utf8');
  const notices = readFileSync(new URL('../src/services/legal-notices.ts', import.meta.url), 'utf8');
  assert.match(metro, /assetExts\.includes\('txt'\)/);
  assert.match(metro, /assetExts\.push\('txt'\)/);
  assert.match(notices, /third-party\/licenses\/Apache-2\.0\.txt/);
  assert.match(notices, /third-party\/licenses\/MIT-component-notices\.txt/);
  assert.match(notices, /assets\/fonts\/licenses\/anton-OFL\.txt/);
  assert.equal(existsSync(new URL('../third-party/licenses/Apache-2.0.txt', import.meta.url)), true);
  assert.equal(existsSync(new URL('../third-party/licenses/MIT-component-notices.txt', import.meta.url)), true);
  assert.equal(existsSync(new URL('../assets/fonts/licenses/anton-OFL.txt', import.meta.url)), true);
});

test('transcription runtime and downloaded model provenance are distributable offline', () => {
  const notices = readFileSync(new URL('../src/services/legal-notices.ts', import.meta.url), 'utf8');
  const models = readFileSync(new URL('../MODEL_NOTICES.md', import.meta.url), 'utf8');
  const mit = readFileSync(new URL('../third-party/licenses/MIT-component-notices.txt', import.meta.url), 'utf8');
  assert.match(notices, /whisper\.rn 0\.7\.0/);
  assert.match(notices, /Silero VAD v6\.2/);
  assert.match(models, /c521a4b02f422512d734391fdf08bb08c0862f68/);
  assert.match(models, /9ffd54a1e1ee413ddf265af9913beaf518d1639b/);
  assert.match(models, /2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987/);
  assert.match(mit, /Copyright \(c\) 2023 Jhen-Jie Hong/);
  assert.match(mit, /Copyright \(c\) 2020-present Silero Team/);
  assert.match(mit, /Copyright \(c\) 2022 OpenAI/);
});
