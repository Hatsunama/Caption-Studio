import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../src', import.meta.url));
const nativeModulePattern = /(?:from\s+|import\s*\()(['"])(caption-media|caption-translation|caption-diagnostics)\1/;
const internalModuleBypassPattern = /(?:from\s+|import\s*\()(['"])(?:\.\.\/)+modules\//;

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  }));
  return nested.flat();
}

test('native modules are consumed only through the service layer public boundary', async () => {
  for (const filePath of await sourceFiles(sourceRoot)) {
    const source = await readFile(filePath, 'utf8');
    const relativePath = path.relative(sourceRoot, filePath).replaceAll('\\', '/');
    assert.doesNotMatch(source, internalModuleBypassPattern, `${relativePath} bypasses a module public API`);
    if (!relativePath.startsWith('services/')) {
      assert.doesNotMatch(source, nativeModulePattern, `${relativePath} owns a native call outside services`);
    }
  }
});

test('domain libraries and services do not depend on presentation layers', async () => {
  for (const filePath of await sourceFiles(path.join(sourceRoot, 'lib'))) {
    const source = await readFile(filePath, 'utf8');
    assert.doesNotMatch(source, /@\/(?:app|components|hooks|services)\//, `${path.basename(filePath)} is not a pure domain dependency`);
  }
  for (const filePath of await sourceFiles(path.join(sourceRoot, 'services'))) {
    const source = await readFile(filePath, 'utf8');
    assert.doesNotMatch(source, /@\/(?:app|components|hooks)\//, `${path.basename(filePath)} depends on presentation code`);
  }
});
