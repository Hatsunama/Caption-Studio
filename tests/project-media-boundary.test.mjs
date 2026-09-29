import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const root = 'file:///documents/projects/project-one/';
const other = 'file:///documents/projects/project-two/';

function harness(initial = {}, sourceBytes = 100) {
  const files = new Map(Object.entries(initial));
  const deleted = [];
  const copied = [];
  const moved = [];
  const generated = [];
  let copiedBytes = 0;
  let copyFailure = false;
  let moveFailure = false;
  const fs = {
    documentDirectory: 'file:///documents/',
    cacheDirectory: 'file:///cache/',
    getInfoAsync: async (uri) => files.has(uri)
      ? { exists: true, isDirectory: files.get(uri) === 'directory', size: typeof files.get(uri) === 'number' ? files.get(uri) : 100 }
      : { exists: false, isDirectory: false, size: 0 },
    makeDirectoryAsync: async (uri) => { files.set(uri, 'directory'); },
    readDirectoryAsync: async (uri) => [...files.keys()]
      .filter((key) => key.startsWith(uri) && key.slice(uri.length) && !key.slice(uri.length).includes('/'))
      .map((key) => key.slice(uri.length)),
    deleteAsync: async (uri) => { deleted.push(uri); files.delete(uri); },
    copyAsync: async ({ from, to }) => {
      copied.push({ from, to });
      if (copyFailure) { files.set(to, 'partial'); throw new Error('copy failed'); }
      files.set(to, 'audio');
    },
    moveAsync: async ({ from, to }) => {
      moved.push({ from, to });
      files.set(to, files.get(from));
      if (moveFailure) throw new Error('move failed');
      files.delete(from);
    },
  };
  class File {
    constructor(uri) { this.uri = uri; }
    create() { files.set(this.uri, 0); }
    open() {
      let offset = 0;
      return {
        readBytes(length) {
          const count = Math.min(length, sourceBytes - offset);
          offset += count;
          return new Uint8Array(count);
        },
        writeBytes(bytes) {
          if (copyFailure) { files.set(this.uri, 1); throw new Error('copy failed'); }
          copiedBytes += bytes.length;
          files.set(this.uri, (files.get(this.uri) ?? 0) + bytes.length);
        },
        close() {},
        uri: this.uri,
      };
    }
  }
  const source = readFileSync(new URL('../src/services/project-media.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  const deps = {
    'expo-file-system/legacy': fs,
    'expo-file-system': { File, FileMode: { ReadOnly: 'r', WriteOnly: 'w' } },
    'caption-media': { __esModule: true, default: {
      generateVideoThumbnail: async (_source, output) => { generated.push(output); files.set(output, 'file'); },
      getMediaInfo: async () => ({ hasAudio: true, durationMs: 1000 }),
      getVideoPlaybackSupport: async () => ({ supported: true }),
    } },
    '@/lib/audio-waveform': { audioWaveformPeakCount: () => 10 },
    '@/lib/media-validation': { assertSupportedVideo: () => {} },
    '@/services/storage-policy': { requireFreeSpace: async () => {} },
  };
  class FixedDate extends Date { static now() { return 1234567890; } }
  const fixedMath = Object.create(Math);
  fixedMath.random = () => 0.5;
  runInNewContext(outputText, { exports, require: (name) => deps[name], Date: FixedDate, Math: fixedMath });
  return { service: exports, files, deleted, copied, moved, generated, copiedBytes: () => copiedBytes, failCopy: () => { copyFailure = true; }, failMove: () => { moveFailure = true; } };
}

test('generated poster path cannot escape the project directory through its ID', async () => {
  const h = harness();
  await h.service.generateProjectThumbnail('../project-two', 'source', 'content://picker/video/1');
  assert.equal(h.generated.length, 1);
  assert.equal(h.generated[0].includes('/../'), false);
});

test('owned deletion accepts direct project files but rejects traversal and neighboring projects', async () => {
  const valid = `${root}audio/old.m4a`;
  const attacks = [
    `${root}../project-two/secret.m4a`,
    `${root}%2e%2e/project-two/secret.m4a`,
    `${root}%252e%252e/project-two/secret.m4a`,
    `${root}audio/%2e%2e/%2e%2e/project-two/secret.m4a`,
    `${other}secret.m4a`,
    'content://picker/image/1',
  ];
  const h = harness(Object.fromEntries([valid, ...attacks].map((uri) => [uri, 'file'])));
  await h.service.deleteProjectOwnedFiles('project-one', [valid, ...attacks]);
  assert.deepEqual(h.deleted, [valid]);
});

test('a forged cached poster or preview is never reused or deleted', async () => {
  const poster = `${root}../project-two/source-x-poster-v3.jpg`;
  const preview = `${root}%2e%2e/project-two/previews/source-x-v1.mp4`;
  const h = harness({ [poster]: 'file', [preview]: 'file' });
  const thumbnail = await h.service.ensureProjectThumbnail({ projectId: 'project-one', sourceId: 'x', videoUri: 'content://picker/video/1', thumbnailUri: poster });
  const optimized = await h.service.ensureProjectVideoPreview({ projectId: 'project-one', source: {
    id: 'x', uri: 'content://picker/video/1', previewUri: preview, durationMs: 1000, width: 100, height: 100,
  } });
  assert.equal(thumbnail, `${root}source-x-poster-v3.jpg`);
  assert.equal(optimized, undefined);
  assert.equal(h.deleted.includes(poster), false);
  assert.equal(h.deleted.includes(preview), false);
});

test('audio import validates staging and preserves a colliding existing file', async () => {
  const previous = `${root}audio/clip.m4a`;
  const h = harness({ [previous]: 'previous' });
  const uri = await h.service.storeProjectAudio({ projectId: 'project-one', audioId: 'clip', sourceUri: 'content://picker/audio/1', fileName: 'song.m4a' });
  assert.notEqual(uri, previous);
  assert.equal(h.files.get(previous), 'previous');
  assert.equal(h.files.get(uri), 100);
  assert.equal(h.copied.length, 0);
  assert.equal(h.copiedBytes(), 100);
  assert.equal(h.moved[0].to, uri);
});

test('failed audio copy leaves no final file and cleans staging', async () => {
  const h = harness();
  h.failCopy();
  await assert.rejects(h.service.storeProjectAudio({ projectId: 'project-one', audioId: 'clip', sourceUri: 'content://picker/audio/1', fileName: 'song.m4a' }), /copy failed/);
  assert.equal(h.moved.length, 0);
  assert.equal([...h.files.keys()].some((uri) => uri.includes('.staging-')), false);
  assert.equal([...h.files.keys()].some((uri) => uri.endsWith('/audio/clip.m4a')), false);
});

test('copied audio stops at the explicit limit even when picker metadata understates its size', async () => {
  const h = harness({ 'content://picker/audio/large': 'source' }, 257 * 1024 * 1024);
  await assert.rejects(
    h.service.storeProjectAudio({ projectId: 'project-one', audioId: 'large', sourceUri: 'content://picker/audio/large', fileName: 'large.m4a' }),
    /256 MB import limit/,
  );
  assert.ok(h.copiedBytes() <= 256 * 1024 * 1024);
  assert.equal(h.moved.length, 0);
});

test('audio destination collision preserves the existing file and removes staging', async () => {
  const destination = `${root}audio/clip-1234567890-i.m4a`;
  const h = harness({ [destination]: 'previous' });
  await assert.rejects(
    h.service.storeProjectAudio({ projectId: 'project-one', audioId: 'clip', sourceUri: 'content://picker/audio/1', fileName: 'song.m4a' }),
    /unique audio file/,
  );
  assert.equal(h.files.get(destination), 'previous');
  assert.equal(h.deleted.includes(destination), false);
  assert.equal([...h.files.keys()].some((uri) => uri.includes('.staging-')), false);
});

test('failed audio promotion removes partial destination and staging', async () => {
  const h = harness();
  h.failMove();
  await assert.rejects(
    h.service.storeProjectAudio({ projectId: 'project-one', audioId: 'clip', sourceUri: 'content://picker/audio/1', fileName: 'song.m4a' }),
    /move failed/,
  );
  assert.equal(h.files.has(h.moved[0].to), false);
  assert.equal([...h.files.keys()].some((uri) => uri.includes('.staging-')), false);
});
