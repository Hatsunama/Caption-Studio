import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return ['.ts', '.tsx'].includes(extname(path)) ? [path] : [];
  });
}

test('domain and service layers do not depend on UI orchestration', () => {
  for (const file of sourceFiles(join(root, 'src', 'lib'))) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /from ['"]@\/(?:app|components|hooks|services)\//, file);
    assert.doesNotMatch(source, /from ['"](?:react-native|expo(?:-[^'"]*)?)['"]/, file);
    assert.doesNotMatch(source, /modules[\\/]caption-(?:media|translation)/, file);
  }
  for (const file of sourceFiles(join(root, 'src', 'services'))) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /from ['"]@\/(?:app|components|hooks)\//, file);
    assert.doesNotMatch(source, /\bAlert\.alert\(/, file);
  }
});

test('UI sees presentation metadata while provider and native layers own release and memory truth', () => {
  const editor = readFileSync(join(root, 'src', 'app', 'editor.tsx'), 'utf8');
  const provider = readFileSync(join(root, 'src', 'services', 'caption-translation.ts'), 'utf8');
  const transcription = readFileSync(join(root, 'src', 'services', 'transcription.ts'), 'utf8');
  const environment = readFileSync(join(root, 'modules', 'caption-translation', 'android', 'src', 'main', 'java', 'app', 'captionstudio', 'translation', 'AndroidTranslationEnvironment.java'), 'utf8');
  for (const directory of ['app', 'components', 'hooks']) {
    for (const file of sourceFiles(join(root, 'src', directory))) {
      assert.doesNotMatch(readFileSync(file, 'utf8'), /from ['"]caption-(?:media|translation)['"]/, file);
    }
  }
  assert.match(editor, /NATURAL_TRANSLATION_MODEL_LABEL/);
  assert.match(editor, /TRANSCRIPTION_MODEL_OPTIONS/);
  assert.doesNotMatch(editor, /TRANSCRIPTION_MODELS|downloadUrl|sha256|modelRevision|ggml-/);
  assert.doesNotMatch(provider, /export const NATURAL_TRANSLATION_MODEL\s*=/);
  assert.match(provider, /const NATURAL_TRANSLATION_MODEL\s*=/);
  assert.match(transcription, /const TRANSCRIPTION_MODELS:/);
  assert.doesNotMatch(transcription, /export const TRANSCRIPTION_MODELS/);
  assert.equal(existsSync(join(root, 'src', 'lib', 'model-catalog.ts')), false);
  assert.doesNotMatch(provider, /availMem|lowMemory|isLowRamDevice/);
  assert.match(environment, /isLowRamDevice/);
  assert.match(environment, /totalMem/);
  assert.doesNotMatch(environment, /memoryInfo\.(?:availMem|lowMemory)/);
});

test('emoji reaction data has one shared owner consumed by JS and Android', () => {
  const sharedCatalog = join(root, 'shared', 'emoji-reactions.json');
  const legacyNativeCatalog = join(root, 'modules', 'caption-media', 'android', 'src', 'main', 'assets', 'emoji-reactions.json');
  const reactions = readFileSync(join(root, 'src', 'lib', 'emoji-reactions.ts'), 'utf8');
  const gradle = readFileSync(join(root, 'modules', 'caption-media', 'android', 'build.gradle'), 'utf8');
  assert.equal(existsSync(sharedCatalog), true);
  assert.equal(existsSync(legacyNativeCatalog), false);
  assert.match(reactions, /shared\/emoji-reactions\.json/);
  assert.match(gradle, /assets\.srcDir file\('\.\.\/\.\.\/\.\.\/shared'\)/);
});

test('export consent is UI-owned and native cleanup never swallows fatal errors', () => {
  const editor = readFileSync(join(root, 'src', 'app', 'editor.tsx'), 'utf8');
  const nativeMedia = readFileSync(join(root, 'modules', 'caption-media', 'android', 'src', 'main', 'java', 'app', 'captionstudio', 'media', 'CaptionMediaModule.kt'), 'utf8');
  assert.match(editor, /exportTranslationSummary/);
  assert.match(editor, /Export with unfinished translations\?/);
  assert.equal(existsSync(join(root, 'src', 'services', 'translation-export-choice.ts')), false);
  assert.doesNotMatch(nativeMedia, /catch \([^)]*Throwable/);
  assert.match(nativeMedia, /cleanupMediaResource/);
});

test('model transfer, lifecycle, and provider release truth stay in their owning layers', () => {
  const transfer = readFileSync(join(root, 'src', 'services', 'verified-model-download.ts'), 'utf8');
  const lifecycle = readFileSync(join(root, 'src', 'hooks', 'use-foreground-operation.ts'), 'utf8');
  const editor = readFileSync(join(root, 'src', 'app', 'editor.tsx'), 'utf8');
  assert.match(transfer, /DownloadTask\.fromSavable/);
  assert.match(transfer, /verifySha256/);
  assert.doesNotMatch(transfer, /\bAppState\b|\bAlert\.alert\(/);
  assert.match(lifecycle, /AppState\.addEventListener/);
  assert.doesNotMatch(lifecycle, /downloadUrl|sha256|downloadBytes/);
  assert.doesNotMatch(editor, /DownloadTask|resumeData|downloadUrl|sha256/);
});
