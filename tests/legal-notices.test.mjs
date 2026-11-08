import vm from 'node:vm';
import { createRequire } from 'node:module';
const ts = createRequire(import.meta.url)('typescript');
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
  const thirdParty = readFileSync(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.packages['node_modules/whisper.rn'].version, '0.7.4');
  for (const surface of [notices, models, thirdParty, mit]) assert.match(surface, /whisper\.rn(?:`)? 0\.7\.4/);
  assert.match(notices, /Whisper ggml tiny multilingual caption model/);
  assert.doesNotMatch(notices, /tiny, base, and small/);
  assert.match(models, /one multilingual Whisper tiny model and a Silero VAD/);
  assert.doesNotMatch(models, /ggml-(?:base|small)-q5_1\.bin|Fast,|Balanced,|Accurate,/);
  assert.match(notices, /Silero VAD v6\.2/);
  assert.match(models, /c521a4b02f422512d734391fdf08bb08c0862f68/);
  assert.match(models, /9ffd54a1e1ee413ddf265af9913beaf518d1639b/);
  assert.match(models, /2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987/);
  assert.match(mit, /Copyright \(c\) 2023 Jhen-Jie Hong/);
  assert.match(mit, /Copyright \(c\) 2020-present Silero Team/);
  assert.match(mit, /Copyright \(c\) 2022 OpenAI/);
});

// Reuses the whole-service CommonJS VM fixture pattern in shared-output-lifetime.test.mjs.
async function loadNoticeService(versions) {
  const source = readFileSync(new URL('../src/services/legal-notices.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const modules = {
    'expo-asset': { Asset: { fromModule: () => { throw new Error('Overview must stay offline'); } } },
    'expo-file-system/legacy': { readAsStringAsync: () => { throw new Error('Overview must stay offline'); } },
    '../../third-party/licenses/Apache-2.0.txt': 1,
    '../../third-party/licenses/MIT-component-notices.txt': 2,
    '../../assets/fonts/licenses/anton-OFL.txt': 3,
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require: (id) => {
      if (id === '../../shared/native-notice-versions.json') {
        return versions ?? JSON.parse(readFileSync(new URL('../shared/native-notice-versions.json', import.meta.url), 'utf8'));
      }
      if (!Object.hasOwn(modules, id)) throw new Error('Unexpected notice dependency: ' + id);
      return modules[id];
    },
  }, { timeout: 1000 });
  return module.exports.LEGAL_NOTICE_DOCUMENTS;
}

test('actual overview.load emits captured selected native versions', async () => {
  const documents = await loadNoticeService();
  assert.deepEqual(Array.from(documents, ({ id }) => id), ['overview', 'mit', 'ofl', 'apache']);
  const overview = documents.find(({ id }) => id === 'overview');
  assert.equal(overview.title, 'Attributions');
  const text = await overview.load();
  assert.match(text, /Kotlin reflection 2\.3\.21 — Apache License 2\.0/);
  assert.match(text, /Kotlin coroutines Android 1\.10\.2 — Apache License 2\.0/);
  assert.doesNotMatch(text, /Kotlin reflection 2\.2\.21|Kotlin coroutines Android 1\.9\.0/);
});


test('actual overview.load reads the same canonical JSON as the receipt verifier', async () => {
  const require = createRequire(import.meta.url);
  const canonical = require('../shared/native-notice-versions.json');
  const { verifyNativeNoticeVersions } = require('../scripts/verify-native-notice-versions.cjs');
  const report = process.env.NATIVE_NOTICE_RUNTIME_REPORT
    ? readFileSync(process.env.NATIVE_NOTICE_RUNTIME_REPORT, 'utf8')
    : readFileSync(new URL('./fixtures/native-notice-runtime.txt', import.meta.url), 'utf8');
  const actual = verifyNativeNoticeVersions(report);
  assert.deepEqual(actual, canonical);
  const text = await (await loadNoticeService()).find(({ id }) => id === 'overview').load();
  assert.ok(text.includes('Kotlin reflection ' + actual['org.jetbrains.kotlin:kotlin-reflect'] + ' — Apache License 2.0'));
  assert.ok(text.includes('Kotlin coroutines Android ' + actual['org.jetbrains.kotlinx:kotlinx-coroutines-android'] + ' — Apache License 2.0'));
  const substituted = { 'org.jetbrains.kotlin:kotlin-reflect': '0.0.1', 'org.jetbrains.kotlinx:kotlinx-coroutines-android': '0.0.2' };
  const other = await (await loadNoticeService(substituted)).find(({ id }) => id === 'overview').load();
  assert.equal(other, text.replace('Kotlin reflection ' + canonical['org.jetbrains.kotlin:kotlin-reflect'], 'Kotlin reflection 0.0.1').replace('Kotlin coroutines Android ' + canonical['org.jetbrains.kotlinx:kotlinx-coroutines-android'], 'Kotlin coroutines Android 0.0.2'));
});
