import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import { sameModelFileIdentity } from '../src/lib/model-verification-lease.ts';

const source = readFileSync(new URL('../src/services/transcription.ts', import.meta.url), 'utf8');
const identity = { fileName: 'caption.bin', sizeBytes: 32, modifiedAtMs: 100, createdAtMs: 50 };

function compileSection(start, end, sandbox, name) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  const code = ts.transpileModule(source.slice(from, to), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const context = vm.createContext(sandbox);
  vm.runInContext(code, context);
  return vm.runInContext(name, context);
}

test('the same verified model is hashed once within one caption generation operation', async () => {
  const file = { exists: true, size: 32, name: identity.fileName, lastModified: 100, creationTime: 50 };
  let hashes = 0;
  const sandbox = {
    CAPTION_MODEL: { fileName: identity.fileName, downloadBytes: 32, sha256: 'a' },
    Paths: { document: 'documents' },
    Directory: class { create() {} },
    File: class { constructor() { return file; } },
    pruneObsoleteModelFiles() {},
    activeModelDownload: undefined,
    modelFileIdentity: () => ({ ...identity, modifiedAtMs: file.lastModified }),
    sameModelFileIdentity,
    verifyModelFile: async () => { hashes++; return true; },
  };
  const reservation = compileSection(
    'async function modelReplacementReservation(', 'export async function transcribeVideoLocally(', sandbox,
    'modelReplacementReservation',
  );
  const ready = await reservation(file, { downloadBytes: 32, sha256: 'a' });
  assert.equal(ready.bytes, 0);
  assert.equal(hashes, 1);
  const ensure = compileSection('async function ensureModel(', 'async function ensureVadModel(', sandbox, 'ensureModel');
  assert.equal(await ensure(undefined, undefined, ready.verifiedIdentity), file);
  assert.equal(hashes, 1);
  file.lastModified = 101;
  assert.equal(await ensure(undefined, undefined, ready.verifiedIdentity), file);
  assert.equal(hashes, 2, 'changed files must be verified again');
});

test('a same-size replacement cannot reuse the in-operation verification', () => {
  assert.equal(sameModelFileIdentity(identity, { ...identity, modifiedAtMs: 101 }), false);
  assert.equal(sameModelFileIdentity(identity, { ...identity, createdAtMs: 51 }), false);
  assert.equal(sameModelFileIdentity(identity, { ...identity, fileName: 'other.bin' }), false);
});

test('an Android API 24-25 null creation time can reuse only the same verified file lease', () => {
  const withoutCreationTime = { ...identity, createdAtMs: null };
  assert.equal(sameModelFileIdentity(withoutCreationTime, { ...withoutCreationTime }), true);
  assert.equal(sameModelFileIdentity(withoutCreationTime, { ...withoutCreationTime, modifiedAtMs: 101 }), false);
  assert.equal(sameModelFileIdentity(withoutCreationTime, identity), false);
  assert.equal(sameModelFileIdentity({ ...withoutCreationTime, modifiedAtMs: null }, withoutCreationTime), false);
});
