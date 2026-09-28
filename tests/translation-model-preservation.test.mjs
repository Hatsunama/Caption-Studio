import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../src/services/caption-translation.ts', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('async function translateWithModelRecovery('), source.indexOf('function pollNativeProgress('));
const compiled = ts.transpileModule(section, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function scenario({ valid = false, verificationError, failOnce = false, nativeCode = 'E_TRANSLATION_MODEL_INTEGRITY', cancelDuringVerification = false } = {}) {
  const counts = { downloads: 0, deletes: 0, hashes: 0, calls: 0, stops: 0 };
  const run = { cancelled: false };
  const model = { exists: true, uri: 'file:///model', name: 'model', parentDirectory: {}, delete() { counts.deletes++; this.exists = false; } };
  const marker = { exists: true, delete() { this.exists = false; } };
  const context = vm.createContext({
    Error, Object,
    File: class { constructor() { return marker; } },
    throwIfCancelled() { if (run.cancelled) throw new Error('cancelled'); },
    async ensureNaturalTranslationModel() { if (!model.exists) { counts.downloads++; model.exists = true; } return model; },
    async verifyTranslationModel() {
      counts.hashes++;
      assert.equal(marker.exists, false, 'reverification must not trust the rejected marker');
      if (cancelDuringVerification) run.cancelled = true;
      if (verificationError) throw verificationError;
      return valid;
    },
    isNativeModelIntegrityFailure: (error) => error?.code === 'E_TRANSLATION_MODEL_INTEGRITY',
    async translateWithNative() {
      counts.calls++;
      if (failOnce && counts.calls > 1) return 'translated';
      throw Object.assign(new Error('native failure'), { code: nativeCode });
    },
    pollNativeProgress: () => () => { counts.stops++; },
  });
  vm.runInContext(compiled, context);
  return { counts, model, start: () => vm.runInContext('translateWithModelRecovery', context)(run, []) };
}

test('confirmed integrity failure preserves the model and never starts a replacement download', async () => {
  const s = scenario();
  await assert.rejects(s.start(), (error) => error.code === 'E_TRANSLATION_MODEL_REPLACEMENT_REQUIRED');
  assert.equal(s.model.exists, true);
  assert.deepEqual(s.counts, { downloads: 0, deletes: 0, hashes: 1, calls: 1, stops: 1 });
});

test('a fresh successful hash permits one local retry without redownloading', async () => {
  const s = scenario({ valid: true, failOnce: true });
  assert.equal(await s.start(), 'translated');
  assert.deepEqual(s.counts, { downloads: 0, deletes: 0, hashes: 1, calls: 2, stops: 2 });
});

test('persistent native rejection is bounded and preserves a locally valid model', async () => {
  const s = scenario({ valid: true });
  await assert.rejects(s.start(), /kept/i);
  assert.equal(s.counts.calls, 2);
  assert.equal(s.counts.downloads, 0);
  assert.equal(s.counts.deletes, 0);
});

test('a read failure is not treated as proof of corruption', async () => {
  const s = scenario({ verificationError: new Error('read failed') });
  await assert.rejects(s.start(), /kept/i);
  assert.equal(s.counts.downloads, 0);
  assert.equal(s.counts.deletes, 0);
  assert.equal(s.counts.calls, 1);
});

test('cancellation during rechecking cannot start another inference or download', async () => {
  const s = scenario({ valid: true, cancelDuringVerification: true });
  await assert.rejects(s.start(), /cancelled/);
  assert.equal(s.counts.calls, 1);
  assert.equal(s.counts.deletes, 0);
  assert.equal(s.counts.downloads, 0);
});

test('ordinary native errors do not invalidate or replace the model', async () => {
  const s = scenario({ nativeCode: 'E_TRANSLATION_RUNTIME' });
  await assert.rejects(s.start(), /native failure/);
  assert.deepEqual(s.counts, { downloads: 0, deletes: 0, hashes: 0, calls: 1, stops: 1 });
});
