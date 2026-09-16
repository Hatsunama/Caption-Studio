import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

import * as storagePolicy from '../src/services/export-storage-policy.ts';
import { assertExportSourcesAvailable } from '../src/lib/export-source-availability.ts';
import { createVideoExportSession, VideoExportCancelledError } from '../src/services/video-export-session.ts';

const { outputText } = ts.transpileModule(
  readFileSync(new URL('../src/services/project-export.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
);
const cacheDirectory = 'file:///cache/caption-studio-exports/';
const fileName = 'caption-studio-test-1777777777777-12345678.mp4';
const outputUri = `${cacheDirectory}${fileName}`;
const published = {
  outputUri,
  mediaUri: 'content://media/external/video/media/12',
  durationMs: 4000,
  width: 1080,
  height: 1920,
  sizeBytes: 2048,
};
const project = { name: 'Test project' };

function loadService(overrides = {}) {
  const calls = { native: 0, cancel: 0, available: 0, probes: 0, share: [], cleanup: [], released: 0 };
  const modules = {
    '@/lib/export-caption-pairs': { exportCaptionPairs: () => [] },
    '@/lib/export-source-availability': { assertExportSourcesAvailable },
    '@/lib/export-render-plan': {
      buildTimelineRenderPlan: () => ({ width: 1080, height: 1920, durationMs: 4000, frameRate: 30,
        clips: [{ id: 'clip1', uri: 'content://video/12' }], audioClips: [], layers: [] }),
      collectUnresolvedFontFamilies: () => [],
      toNativeRenderPlan: (plan) => plan,
    },
    '@/lib/subtitle-export': {
      visibleCaptions: () => [{}],
      serializeSrt: () => '1\n00:00:00,000 --> 00:00:01,000\nHello\n',
      serializeAss: () => '[Script Info]',
    },
    'expo-file-system/legacy': {
      cacheDirectory: 'file:///cache/',
      getInfoAsync: overrides.getInfo ?? (async () => ({ exists: true, isDirectory: false, size: published.sizeBytes })),
      writeAsStringAsync: async () => {},
      EncodingType: { UTF8: 'utf8' },
    },
    'expo-sharing': {
      isAvailableAsync: async () => {
        calls.available += 1;
        return overrides.isAvailable ? overrides.isAvailable() : true;
      },
      shareAsync: async (uri, options) => {
        calls.share.push({ uri, options });
        await overrides.share?.();
      },
    },
    'caption-media': { __esModule: true, default: {
      getMediaInfo: async () => {
        calls.probes += 1;
        return overrides.mediaInfo ? overrides.mediaInfo() : { durationMs: 4000, hasVideo: true, hasAudio: true };
      },
      validateImageFile: async () => ({ width: 1, height: 1 }),
      requestLegacyMediaWritePermission: overrides.permission ?? (async () => true),
      exportTimelineVideo: async (path) => {
        calls.native += 1;
        assert.equal(path, outputUri.replace(/^file:\/\//, ''));
        return overrides.native ? overrides.native() : published;
      },
      cancelTimelineVideoExport: async () => { calls.cancel += 1; },
    } },
    '@/services/export-storage': {
      ...storagePolicy,
      prepareCaptionStudioExportCache: overrides.prepare ?? (async () => cacheDirectory),
      createExportCacheFileName: (_name, extension) => fileName.replace(/mp4$/, extension),
      protectTemporaryVideoExportArtifacts: (uri) => {
        assert.equal(uri, outputUri);
        return () => { calls.released += 1; };
      },
      removeTemporaryVideoExportArtifacts: async (uri) => { calls.cleanup.push(uri); },
      removeFailedSubtitleExportArtifact: async (uri) => { calls.cleanup.push(uri); },
    },
    '@/services/export-font-assets': { resolveExportFontUris: async () => new Map() },
    '@/services/storage-policy': { requireFreeSpace: async () => {} },
    '@/services/video-export-session': { createVideoExportSession },
  };
  const module = { exports: {} };
  runInNewContext(outputText, {
    module,
    exports: module.exports,
    require: (id) => {
      assert.ok(Object.hasOwn(modules, id), `Unexpected dependency: ${id}`);
      return modules[id];
    },
  });
  return { ...module.exports, calls };
}

test('lost source access fails before rendering or publishing a video', async () => {
  const service = loadService({ mediaInfo: async () => { throw Error('Permission Denial'); } });
  await assert.rejects(service.exportProjectVideo(project), /Cannot export: the video source/);
  assert.equal(service.calls.probes, 1);
  assert.equal(service.calls.native, 0);
  assert.equal(service.calls.available, 0);
  assert.deepEqual(service.calls.cleanup, []);
});

for (const [name, overrides, expectedShares] of [
  ['successful sharing', {}, 1],
  ['unavailable sharing', { isAvailable: async () => false }, 0],
  ['availability check rejection', { isAvailable: async () => { throw Error('Unavailable'); } }, 0],
  ['share sheet rejection', { share: async () => { throw Error('No share target'); } }, 1],
  ['missing cache copy', { getInfo: async () => ({ exists: false }) }, 0],
  ['directory in place of cache copy', { getInfo: async () => ({ exists: true, isDirectory: true }) }, 0],
  ['empty cache copy', { getInfo: async () => ({ exists: true, size: 0 }) }, 0],
  ['incomplete cache copy', { getInfo: async () => ({ exists: true, size: 1 }) }, 0],
  ['cache inspection rejection', { getInfo: async () => { throw Error('Cache unavailable'); } }, 0],
]) {
  test(`published video succeeds exactly once despite ${name}`, async () => {
    const service = loadService(overrides);
    assert.deepEqual(await service.exportProjectVideo(project), published);
    assert.equal(service.calls.native, 1);
    assert.equal(service.calls.share.length, expectedShares);
    assert.deepEqual(service.calls.cleanup, [outputUri]);
    assert.equal(service.calls.released, 1);
    assert.equal(await service.cancelProjectVideoExport(), false);
    if (expectedShares) {
      assert.equal(service.calls.share[0].uri, outputUri);
      assert.equal(service.calls.share[0].options.mimeType, 'video/mp4');
    }
  });
}

test('cancellation while sharing cannot undo publication or remove the in-use cache copy', async () => {
  const sharing = deferred();
  const opened = deferred();
  const service = loadService({ share: () => { opened.resolve(); return sharing.promise; } });
  const exporting = service.exportProjectVideo(project);
  await opened.promise;
  assert.deepEqual(service.calls.cleanup, []);
  assert.equal(service.calls.released, 0);
  assert.equal(await service.cancelProjectVideoExport(), true);
  sharing.reject(Error('Share cancelled'));
  assert.deepEqual(await exporting, published);
  assert.equal(service.calls.native, 1);
  assert.deepEqual(service.calls.cleanup, [outputUri]);
  assert.equal(service.calls.released, 1);
});

test('failed optional sharing releases the session for a later explicit export without automatic retries', async () => {
  const service = loadService({ share: async () => { throw Error('Share failed'); } });
  await service.exportProjectVideo(project);
  assert.equal(service.calls.native, 1);
  await service.exportProjectVideo(project);
  assert.equal(service.calls.native, 2);
  assert.equal(service.calls.released, 2);
});

for (const [name, native, message] of [
  ['native publication failure', async () => { throw Error('Publication failed'); }, /Publication failed/],
  ['missing published URI', async () => ({ ...published, mediaUri: '' }), /media library copy is missing/],
  ['invalid native result', async () => null, /did not return a video/],
]) {
  test(`${name} still fails and cleans only temporary output`, async () => {
    const service = loadService({ native });
    await assert.rejects(service.exportProjectVideo(project), message);
    assert.equal(service.calls.native, 1);
    assert.equal(service.calls.available, 0);
    assert.deepEqual(service.calls.cleanup, [outputUri]);
    assert.equal(service.calls.released, 1);
  });
}

test('cancellation before native export still prevents publication and sharing', async () => {
  const preparation = deferred();
  const service = loadService({ prepare: () => preparation.promise });
  const exporting = service.exportProjectVideo(project);
  assert.equal(await service.cancelProjectVideoExport(), true);
  await assert.rejects(exporting, VideoExportCancelledError);
  preparation.resolve(cacheDirectory);
  assert.equal(service.calls.native, 0);
  assert.equal(service.calls.available, 0);
});

test('native-stage cancellation still rejects before verified delivery reaches JS', async () => {
  const native = deferred();
  const started = deferred();
  const service = loadService({ native: () => { started.resolve(); return native.promise; } });
  const exporting = service.exportProjectVideo(project);
  await started.promise;
  await service.cancelProjectVideoExport();
  native.reject(Error('Native export cancelled'));
  await assert.rejects(exporting, VideoExportCancelledError);
  assert.equal(service.calls.cancel, 1);
  assert.equal(service.calls.available, 0);
  assert.deepEqual(service.calls.cleanup, [outputUri]);
});

for (const format of ['srt', 'ass']) {
  test(`${format} sharing remains required because subtitles have no MediaStore publication`, async () => {
    const service = loadService({ isAvailable: async () => false });
    await assert.rejects(service.exportSubtitleFile(project, format), /sharing is unavailable/);
    assert.equal(service.calls.native, 0);
    assert.deepEqual(service.calls.cleanup, [outputUri.replace(/mp4$/, format)]);
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}
