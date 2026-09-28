import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const native = readFileSync(new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/CaptionMediaModule.kt', import.meta.url), 'utf8');

test('published videos use a durable MediaStore content URI with recipient read access', () => {
  assert.match(native, /AsyncFunction\("sharePublishedVideo"\)/);
  assert.match(native, /Intent\.ACTION_SEND/);
  assert.match(native, /Intent\.FLAG_GRANT_READ_URI_PERMISSION/);
  assert.match(native, /ClipData\.newUri/);
});

test('simultaneous diagnostic shares retain separate readable files after the chooser returns', async () => {
  const source = readFileSync(new URL('../src/services/local-diagnostics.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const shares = [];
  const deleted = [];
  const files = new Map();
  const modules = {
    'expo-file-system/legacy': {
      cacheDirectory: 'file:///cache/', documentDirectory: 'file:///documents/',
      getInfoAsync: async (uri) => ({ exists: files.has(uri), isDirectory: false }),
      readAsStringAsync: async (uri) => files.get(uri),
      writeAsStringAsync: async (uri, data) => { files.set(uri, data); },
      deleteAsync: async (uri) => { deleted.push(uri); files.delete(uri); },
      makeDirectoryAsync: async () => {},
      readDirectoryAsync: async () => [],
    },
    'expo-sharing': {
      isAvailableAsync: async () => true,
      shareAsync: async (uri) => { shares.push(uri); },
    },
    'caption-diagnostics': { __esModule: true, default: { getHistoricalExitReasons: async () => [] } },
    '@/lib/diagnostic-redaction': { mergeBoundedExitRecords: (_old, incoming) => incoming },
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require: (id) => modules[id] ?? (() => { throw new Error(`unexpected dependency ${id}`); })(),
  });
  await Promise.all([module.exports.shareLocalProcessExits(), module.exports.shareLocalProcessExits()]);
  assert.equal(shares.length, 2);
  assert.notEqual(shares[0], shares[1]);
  for (const uri of shares) {
    assert.equal(files.has(uri), true, 'recipient must still be able to read the shared file');
    assert.equal(deleted.includes(uri), false);
  }
});

test('diagnostic cleanup removes only expired owned snapshots that are not in use', async () => {
  const source = readFileSync(new URL('../src/services/local-diagnostics.ts', import.meta.url), 'utf8');
  const section = source.slice(source.indexOf('async function pruneOldDiagnosticShares('), source.indexOf('async function writeLocalProcessExits('));
  const code = ts.transpileModule(section, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const directory = 'file:///documents/diagnostic-shares/';
  const old = 'caption-studio-sanitized-diagnostics-1000000000000-1.json';
  const active = 'caption-studio-sanitized-diagnostics-1000000000000-2.json';
  const fresh = 'caption-studio-sanitized-diagnostics-1000000000000-3.json';
  const unrelated = 'user-file.json';
  const nowMs = 2_000_000_000_000;
  const deleted = [];
  const sandbox = {
    SHARED_DIAGNOSTIC_MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000,
    activeDiagnosticShares: new Set([directory + active]),
    FileSystem: {
      readDirectoryAsync: async () => [old, active, fresh, unrelated],
      getInfoAsync: async (uri) => ({ exists: true, isDirectory: false,
        modificationTime: uri.endsWith(fresh) ? (nowMs - 24 * 60 * 60 * 1000) / 1000 : (nowMs - 8 * 24 * 60 * 60 * 1000) / 1000 }),
      deleteAsync: async (uri) => { deleted.push(uri); },
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(code, context);
  await vm.runInContext('pruneOldDiagnosticShares', context)(directory, nowMs);
  assert.deepEqual(deleted, [directory + old]);
});
