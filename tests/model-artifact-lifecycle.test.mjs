import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MODEL_STORAGE_SUFFIXES,
  RESUMABLE_MODEL_SUFFIXES,
  removeModelArtifacts,
  storedModelBytes,
} from '../src/lib/model-artifact-lifecycle.ts';

test('unfinished model bytes remain visible and are removed with the model', () => {
  const files = new Map([
    ['qwen.download', 1_000_000_000],
    ['qwen.download.chunk', 8_388_608],
    ['qwen.download.chunk.offset', 3],
    ['qwen.download.resume.json', 120],
  ]);
  const resolve = (name) => ({
    get exists() { return files.has(name); },
    get size() { return files.get(name) ?? 0; },
    delete() { files.delete(name); },
  });
  assert.equal(storedModelBytes('qwen', resolve), 1_008_388_731);
  removeModelArtifacts('qwen', resolve);
  assert.equal(storedModelBytes('qwen', resolve), 0);
  assert.equal(files.size, 0);
});

test('download and provider cleanup use the same resumable artifact names', () => {
  for (const suffix of RESUMABLE_MODEL_SUFFIXES) assert.ok(MODEL_STORAGE_SUFFIXES.includes(suffix));
  const files = new Map([['model', 30], ['model.sha256', 2], ['model.download.chunk', 8]]);
  const resolve = (name) => ({
    get exists() { return files.has(name); },
    get size() { return files.get(name) ?? 0; },
    delete() { files.delete(name); },
  });
  removeModelArtifacts('model', resolve, RESUMABLE_MODEL_SUFFIXES);
  assert.deepEqual([...files.keys()], ['model', 'model.sha256']);
});
