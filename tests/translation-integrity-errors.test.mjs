import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import { modelVerificationMarkerMatches } from '../src/lib/model-verification.ts';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

function executableSection(source, start, end, sandbox, exportedName) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, 'expected production function boundaries');
  const section = source.slice(from, to);
  const compiled = ts.transpileModule(section, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const context = vm.createContext(sandbox);
  vm.runInContext(compiled, context);
  return context[exportedName];
}

test('translation marker cannot trust a same-sized changed model and is rebound after hashing', async () => {
  const source = await read('src/services/caption-translation.ts');
  const expectedHash = 'a'.repeat(64);
  const model = {
    exists: true, size: 4, name: 'model.bin', uri: 'file:///model.bin',
    parentDirectory: {}, lastModified: 200, creationTime: 100,
  };
  const marker = {
    exists: true, raw: expectedHash, deleted: false,
    async text() { return this.raw; },
    write(value) { this.raw = value; this.exists = true; },
    delete() { this.deleted = true; this.exists = false; },
  };
  const sandbox = {
    NATURAL_TRANSLATION_MODEL: { downloadBytes: 4, sha256: expectedHash },
    File: class { constructor() { return marker; } },
    CaptionMedia: { sha256: async () => 'b'.repeat(64) },
    modelVerificationMarkerMatches,
    modelFileIdentity: (file) => ({
      fileName: file.name, sizeBytes: file.size,
      modifiedAtMs: file.lastModified, createdAtMs: file.creationTime,
    }),
    writeTranslationModelVerificationMarker: async (file, sha) => {
      marker.write(JSON.stringify({
        schemaVersion: 1, fileName: file.name, sizeBytes: file.size,
        sha256: sha, modifiedAtMs: file.lastModified, createdAtMs: file.creationTime,
      }));
    },
  };
  const verify = executableSection(source, 'async function verifyTranslationModel(', 'function requireNaturalCaptionTranslationLimits(', sandbox, 'verifyTranslationModel');
  assert.equal(await verify(model), false);
  assert.equal(marker.exists, false);

  marker.exists = true;
  marker.raw = expectedHash;
  sandbox.CaptionMedia.sha256 = async () => expectedHash;
  assert.equal(await verify(model), true);
  assert.equal(modelVerificationMarkerMatches(marker.raw, sandbox.modelFileIdentity(model), expectedHash), true);
});

test('progress polling reports a read failure while the translation continues', async () => {
  const source = await read('src/services/caption-translation.ts');
  const run = { id: Symbol('translation'), cancelled: false };
  const notices = [];
  let tick;
  let rejectRead = true;
  const sandbox = {
    activeTranslation: run,
    setInterval: (callback) => { tick = callback; return 1; },
    clearInterval: () => {},
    CaptionTranslation: {
      getNaturalCaptionTranslationProgress: async () => {
        if (rejectRead) throw new Error('progress unavailable');
        return { stage: 'translating', processedItems: 1, totalItems: 2 };
      },
    },
    captionTranslationProgress: () => ({ stage: 'translating', progress: 0.5, detail: 'Translating locally' }),
  };
  const poll = executableSection(source, 'function pollNativeProgress(', 'export function captionTranslationProgress(', sandbox, 'pollNativeProgress');
  const stop = poll(run, (value) => notices.push(value));
  tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(run.cancelled, false);
  assert.match(notices[0]?.detail ?? '', /progress.*unavailable/i);
  rejectRead = false;
  tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notices.at(-1)?.progress, 0.5);
  stop();
});

test('translation style save rejection is shown ahead of the existing editor banner', async () => {
  const source = await read('src/app/editor.tsx');
  const errors = [];
  const sandbox = {
    workspaceMountedRef: { current: true },
    commitEditorProject: async () => { throw new Error('disk full'); },
    setTranslationStyleSaveError: (message) => errors.push(message),
  };
  const commit = executableSection(source, 'const commitTranslationTrackPatch =', 'const adjustTranslationGap =', sandbox, 'commitTranslationTrackPatch');
  commit(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(errors.at(-1) ?? '', /disk full/);
  assert.match(source, /translationStyleSaveError\s*\?\?\s*captionInterruptionMessage/);
});

test('native model digest gate remains in place', async () => {
  const source = await read('modules/caption-translation/android/src/main/java/app/captionstudio/translation/OfficialQwenModelVerifier.java');
  assert.match(source, /MessageDigest\.getInstance\("SHA-256"\)/);
  assert.match(source, /if \(!EXPECTED_MODEL_SHA256\.equals\(actualHash\)\) throw integrityFailure\(\)/);
});
