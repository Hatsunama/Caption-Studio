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
    assert.doesNotMatch(source, /import\s*\{[^}]*\bAlert\b[^}]*\}\s*from\s*['"]react-native['"]/, `${path.basename(filePath)} imports UI prompts`);
  }
});

test('media recovery keeps domain compatibility, service workflow, and UI prompts in their owning layers', async () => {
  const read = (file) => readFile(path.join(sourceRoot, file), 'utf8');
  const domain = await read('lib/project-media-relink.ts');
  const types = await read('types/project-media-recovery.ts');
  const workflow = await read('services/project-media-recovery.ts');
  const adapter = await read('services/project-media-access.ts');
  const prompts = await read('components/editor/project-media-recovery-prompts.ts');
  const editor = await read('app/editor.tsx');
  assert.doesNotMatch(domain + types, /caption-media|react-native|@\/services\/|ports\.(?:check|persist|choose)/);
  assert.match(workflow, /await ports\.persist\(recovered\)/);
  assert.doesNotMatch(workflow + adapter, /Alert|Restore video access|Confirm original video|clearProjectEditorDraftJournals|deleteProject|releaseReadPermission|copyTo/);
  assert.match(adapter, /CaptionMedia\.checkReadAccess/);
  assert.match(adapter, /prompts\.requestOriginal/);
  assert.match(adapter, /prompts\.confirmOriginal/);
  assert.match(prompts, /Alert\.alert/);
  assert.match(editor, /loadProjectForEditing\(projectId, projectMediaRecoveryPrompts\)/);
});
