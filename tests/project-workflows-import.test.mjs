import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/services/project-workflows.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;

test('concurrent imports in one millisecond receive distinct project IDs', async () => {
  const saved = [];
  const exports = {};
  const FixedDate = class extends Date { static now() { return 1_800_000_000_000; } };
  const dependencies = {
    '@/lib/project-factory': { createCaptionProject: ({ id, sources }) => ({ id, sources }) },
    '@/lib/project-presentation': { humanVideoName: (name) => name },
    '@/services/media-import': { pickLinkedVideos: async () => [{ displayName: 'video.mp4', uri: 'content://video/1' }] },
    '@/services/database': { saveProject: async (project) => { saved.push(project); } },
    '@/services/caption-generation-session': { createCaptionGenerationSession: () => ({}) },
    'caption-media': { cancelAudioExtraction() {} },
  };
  runInNewContext(compiled, {
    exports,
    Date: FixedDate,
    require(name) { return dependencies[name] ?? {}; },
  });
  const [first, second] = await Promise.all([exports.importVideoProject(), exports.importVideoProject()]);
  assert.notEqual(first.id, second.id);
  assert.equal(saved.length, 2);
});

test('a rejected generation session emits no audio preparation progress', async () => {
  const exports = {};
  runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === '@/services/caption-generation-session') {
        return { createCaptionGenerationSession: () => ({ run: async () => { throw new Error('busy'); } }) };
      }
      if (name === 'caption-media') return { cancelAudioExtraction() {} };
      return {};
    },
  });
  const progress = [];
  await assert.rejects(exports.generateAndSaveProjectCaptions({}, (event) => progress.push(event)), /busy/);
  assert.deepEqual(progress, []);
});
