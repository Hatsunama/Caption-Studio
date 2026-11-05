import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const fingerprintRequire = createRequire(require.resolve('@expo/fingerprint/package.json'));
const { glob } = fingerprintRequire('glob');
const { Minimatch } = fingerprintRequire('minimatch');
const paths = fingerprintRequire('./build/utils/Path.js');

function removeFixture(root) {
  const resolved = fs.realpathSync(root);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.match(path.basename(resolved), /^caption-fingerprint-[a-zA-Z0-9]+$/);
  fs.rmSync(resolved, { recursive: true, force: true });
}

test('fingerprint glob stops directory traversal after cancellation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-fingerprint-'));
  try {
    fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a', 'b', 'c', 'file.txt'), 'synthetic');
    const controller = new AbortController();
    let readsAfterAbort = 0;
    const probeFs = {
      readdir(directory, options, callback) {
        if (controller.signal.aborted) readsAfterAbort++;
        const entries = fs.readdirSync(directory, options);
        queueMicrotask(() => {
          if (!controller.signal.aborted) controller.abort(new Error('synthetic cancellation'));
          callback(null, entries);
        });
      },
    };
    await assert.rejects(glob('**/*', { cwd: root, fs: probeFs, signal: controller.signal }), /synthetic cancellation/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(readsAfterAbort, 0, 'rejected traversal must not keep reading child directories');
  } finally {
    removeFixture(root);
  }
});

test('fingerprint minimatch respects the configured pattern expansion budget', () => {
  // Six branches expose the old 64-pattern expansion without a large payload.
  const pattern = 'a/**/../b/c/'.repeat(6) + 'end';
  const matcher = new Minimatch(pattern, { optimizationLevel: 2, braceExpandMax: 8 });
  assert.ok(matcher.set.length <= 8, 'path optimization must respect the expansion budget too');
});

test('TypeScript parser matching keeps its file-selection contract and expansion budget', () => {
  const parserRequire = createRequire(require.resolve('@typescript-eslint/typescript-estree'));
  const { minimatch, Minimatch: ParserMinimatch } = parserRequire('minimatch');
  for (const [file, expected] of [['eslint.config.js', true], ['.config.js', true], ['src/editor.tsx', false]]) {
    assert.equal(minimatch(file, '*.js', { dot: true }), expected, file);
  }
  const matcher = new ParserMinimatch('a/**/../b/c/'.repeat(6) + 'end', { optimizationLevel: 2, braceExpandMax: 8 });
  assert.ok(matcher.set.length <= 8, 'the parser dependency must also enforce the pattern budget');
});

test('fingerprint matching preserves ignored paths, dotfiles and negated exceptions', async () => {
  const patterns = ['**/node_modules/**', '**/build/**', '**/.cache/**', '!src/build/keep.ts'];
  for (const [file, expected] of [
    ['node_modules/package/index.js', true], ['../node_modules/package/index.js', true],
    ['src/build/output.js', true], ['src/build/keep.ts', false],
    ['src/.cache/file', true], ['src/editor.tsx', false],
  ]) assert.equal(paths.isIgnoredPath(file, patterns), expected, file);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-fingerprint-'));
  try {
    for (const directory of ['src', 'node_modules/example']) fs.mkdirSync(path.join(root, directory), { recursive: true });
    for (const file of ['.gitignore', 'src/.gitignore', 'node_modules/example/.gitignore']) fs.writeFileSync(path.join(root, file), 'synthetic');
    assert.deepEqual((await glob('**/.gitignore', { cwd: root, ignore: ['node_modules'], follow: false }))
      .map(file => file.replaceAll('\\', '/')).sort(), ['.gitignore', 'node_modules/example/.gitignore', 'src/.gitignore']);
  } finally {
    removeFixture(root);
  }
});
