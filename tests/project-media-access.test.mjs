import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { relinkProjectVideo } from '../src/lib/project-media-relink.ts';
import { recoverProjectVideoAccess } from '../src/services/project-media-recovery.ts';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const oldUri = 'content://com.android.providers.media.documents/document/video%3A7121';
const newUri = 'content://com.android.externalstorage.documents/document/primary%3ADCIM%2Foriginal.mp4';
const info = { durationMs: 10_000, width: 1920, height: 1080, rotation: 0, frameRate: 30,
  hasAudio: true, hasVideo: true, hasVideoTrack: true, videoMimeType: 'video/avc' };
const document = { uri: newUri, name: 'original.mp4', size: 100_000 };

function fixture() {
  const project = createCaptionProject({ id: 'existing-project', name: 'Keep my edits', sources: [
    { id: 'source1', uri: oldUri, storageMode: 'linked', displayName: 'original.mp4', sizeBytes: 100_000,
      thumbnailUri: 'file:///private/existing-poster.jpg', ...info },
  ] });
  project.clips[0] = { ...project.clips[0], id: 'clip1', sourceStartMs: 2000, sourceEndMs: 8000,
    playbackRate: 1.5, muted: true, gapBeforeMs: 300, transitionAfter: { type: 'none', durationMs: 0 } };
  project.captions = [{ id: 'caption1', text: 'Edited caption', startMs: 300, endMs: 2000, wordIds: [], textMode: 'manual' }];
  project.captionTracks.translations = [{ id: 'translation1', cues: [{ text: 'Edited translation' }] }];
  project.transcription.sourceResults = { source1: { words: [{ id: 'word1', text: 'Original' }] } };
  return project;
}

function ports(overrides = {}) {
  return {
    check: async (uri) => ({ status: uri === oldUri ? 'permission-required' : 'ready' }),
    choose: async () => document,
    probe: async () => info,
    confirm: async () => true,
    persist: async () => {},
    releaseUnused: async () => {},
    ...overrides,
  };
}

test('relink releases abandoned grants only after save and unused new grants on cancellation', async () => {
  const events = [];
  await recoverProjectVideoAccess(fixture(), ports({
    persist: async () => { events.push('save'); },
    releaseUnused: async (uris) => { events.push('release:' + [...uris].join(',')); },
  }));
  assert.deepEqual(events, ['save', 'release:' + oldUri]);

  events.length = 0;
  await assert.rejects(recoverProjectVideoAccess(fixture(), ports({
    confirm: async () => false,
    persist: async () => assert.fail('cancelled recovery must not save'),
    releaseUnused: async (uris) => { events.push('release:' + [...uris].join(',')); },
  })), /cancelled/i);
  assert.deepEqual(events, ['release:' + newUri]);
});

test('re-link preserves every edit, source ID, cached thumbnail and draft base revision', () => {
  const project = fixture();
  const original = structuredClone(project);
  const next = relinkProjectVideo(project, project.sources[0], document, info);
  assert.deepEqual(project, original);
  assert.deepEqual(next, { ...original, sources: [{ ...original.sources[0], uri: newUri }] });
  for (const field of ['clips', 'captions', 'captionTracks', 'transcription', 'audioClips', 'layers', 'canvas']) {
    assert.equal(next[field], project[field]);
  }
  assert.equal(next.updatedAt, project.updatedAt);
});

test('all references to a selected source URI recover without touching an unrelated source', () => {
  const project = fixture();
  project.sources.push({ ...project.sources[0], id: 'duplicate' }, { ...project.sources[0], id: 'other', uri: 'content://provider/other' });
  project.backgroundReplacement.source = { kind: 'video', uri: oldUri, storageMode: 'linked', displayName: 'Original' };
  const next = relinkProjectVideo(project, project.sources[0], document, info);
  assert.deepEqual(next.sources.map((source) => [source.id, source.uri]), [
    ['source1', newUri], ['duplicate', newUri], ['other', 'content://provider/other'],
  ]);
  assert.equal(next.backgroundReplacement.source.uri, newUri);
  assert.equal(next.clips, project.clips);
});

test('restoring the same URI requires no project rewrite', async () => {
  const project = fixture();
  let checks = 0;
  const next = await recoverProjectVideoAccess(project, ports({
    check: async () => ({ status: ++checks === 1 ? 'permission-required' : 'ready' }),
    choose: async () => ({ ...document, uri: oldUri }),
    persist: async () => assert.fail('same-URI grant recovery must not rewrite project data'),
  }));
  assert.equal(next, project);
});

test('readable durable sources reopen without picking, probing or rewriting', async () => {
  const project = fixture();
  assert.equal(await recoverProjectVideoAccess(project, ports({
    check: async () => ({ status: 'ready' }),
    choose: async () => assert.fail('unnecessary picker'),
    probe: async () => assert.fail('unnecessary decoder allocation'),
    persist: async () => assert.fail('unnecessary save'),
  })), project);
});

test('missing document and unavailable provider also offer recovery', async () => {
  for (const failure of ['missing', 'unavailable']) {
    let offered;
    await recoverProjectVideoAccess(fixture(), ports({
      check: async (uri) => ({ status: uri === oldUri ? failure : 'ready' }),
      choose: async (_source, status) => { offered = status; return document; },
    }));
    assert.equal(offered, failure);
  }
});

test('picker cancel, confirmation cancel, temporary grant and provider error never save', async () => {
  for (const overrides of [
    { choose: async () => null },
    { confirm: async () => false },
    { check: async () => ({ status: 'permission-required' }) },
    { choose: async () => { throw new Error('provider unavailable'); } },
  ]) {
    const project = fixture();
    const original = structuredClone(project);
    await assert.rejects(recoverProjectVideoAccess(project, ports({ ...overrides,
      persist: async () => assert.fail('failed recovery must not save'),
    })));
    assert.deepEqual(project, original);
  }
});

test('wrong file, missing decode, altered orientation and truncated source cannot replace edits', () => {
  const project = fixture();
  for (const metadata of [
    { ...info, durationMs: 5000 }, { ...info, width: 1280 }, { ...info, rotation: 90 },
    { ...info, hasVideo: false }, { ...info, durationMs: Number.NaN },
    { ...info, durationMs: 9999 }, // Covers the saved available source range, not just the current cut.
  ]) assert.throws(() => relinkProjectVideo(project, project.sources[0], document, metadata));
  assert.throws(() => relinkProjectVideo(project, project.sources[0], { ...document, size: 123 }, info));
  assert.throws(() => relinkProjectVideo(project, project.sources[0], { ...document, uri: 'file:///cache/copy.mp4' }, info));
  assert.equal(project.sources[0].uri, oldUri);
});

test('a compatible file with unknown provider size still requires explicit identity confirmation', async () => {
  let confirmed = false;
  let persisted = false;
  await recoverProjectVideoAccess(fixture(), ports({
    choose: async () => ({ ...document, size: null }),
    confirm: async () => { confirmed = true; return true; },
    persist: async () => { assert.equal(confirmed, true); persisted = true; },
  }));
  assert.equal(persisted, true);
});

test('a failed later source does not partially rewrite a multi-source project', async () => {
  const project = fixture();
  project.sources.push({ ...project.sources[0], id: 'source2', uri: 'content://provider/lost' });
  const original = structuredClone(project);
  await assert.rejects(recoverProjectVideoAccess(project, ports({
    check: async (uri) => ({ status: uri === newUri ? 'ready' : 'permission-required' }),
    choose: async (source) => source.id === 'source1' ? document : null,
    persist: async () => assert.fail('must not persist a partial recovery'),
  })), /preserved/);
  assert.deepEqual(project, original);
});

test('save rejection propagates without publishing the replacement or changing the input', async () => {
  const project = fixture();
  const original = structuredClone(project);
  await assert.rejects(recoverProjectVideoAccess(project, ports({
    persist: async (next) => { assert.equal(next.sources[0].uri, newUri); throw new Error('disk full'); },
  })), /disk full/);
  assert.deepEqual(project, original);
});

test('native contract owns result grants before returning URIs, with read-only access and no copies', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const picker = read('modules/caption-media/android/src/main/java/app/captionstudio/media/LinkedVideoDocuments.kt');
  const access = read('modules/caption-media/android/src/main/java/app/captionstudio/media/DocumentReadAccess.kt');
  const workflow = read('src/services/project-workflows.ts');
  const mediaImport = read('src/services/media-import.ts');
  assert.match(picker, /Intent\(Intent.ACTION_OPEN_DOCUMENT\)/);
  assert.match(picker, /Intent.CATEGORY_OPENABLE/);
  assert.match(picker, /withRetainedDocumentResults[\s\S]*retainResult\(it, intent.flags\)[\s\S]*promise.resolve/);
  assert.match(picker, /intent.data[\s\S]*intent.clipData/);
  assert.match(picker, /RESULT_CANCELED[\s\S]*"canceled" to true/);
  assert.match(access, /FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION/);
  assert.match(access, /takePersistableUriPermission[\s\S]*retained\(uri\)/);
  assert.match(access, /openAssetFileDescriptor\(uri, "r"\).*use/);
  assert.doesNotMatch(picker + access, /FLAG_GRANT_WRITE|MANAGE_EXTERNAL_STORAGE|READ_MEDIA_VIDEO|copyTo/);
  assert.match(workflow, /project = await ensureProjectVideoAccess\(project, prompts\);[\s\S]*const loadedProject/);
  assert.match(mediaImport, /pickVideoDocuments\(true\)/);
  assert.match(mediaImport, /pickVideoDocuments\(false\)/);
  assert.doesNotMatch(mediaImport, /type: 'video\/\*'/);
});

function loadWithPorts(path, dependencies) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  runInNewContext(outputText, { exports, require: (name) => {
    assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency: ${name}`);
    return dependencies[name];
  } });
  return exports;
}

test('service adapts native access and UI decisions, deduplicates opens, and retries after cancellation', async () => {
  const calls = [];
  const service = loadWithPorts('src/services/project-media-access.ts', {
    'caption-media': { __esModule: true, default: {
      checkReadAccess: async (uri) => { calls.push('check'); return { status: uri === oldUri ? 'permission-required' : 'ready' }; },
      pickVideoDocuments: async (multiple) => { assert.equal(multiple, false); calls.push('pick'); return { canceled: false, assets: [document] }; },
      getMediaInfo: async () => { calls.push('probe'); return info; },
    } },
    '@/services/project-media-recovery': { recoverProjectVideoAccess },
    '@/services/database': { saveProject: async () => { calls.push('save'); } },
    '@/services/media-permissions': { releaseUnreferencedReadPermissions: async () => {} },
  });
  const project = fixture();
  const original = structuredClone(project);
  const prompts = {
    requestOriginal: async () => { calls.push('request'); return false; },
    confirmOriginal: async () => { calls.push('confirm'); return true; },
  };
  const first = service.ensureProjectVideoAccess(project, prompts);
  assert.equal(service.ensureProjectVideoAccess(project, prompts), first);
  await assert.rejects(first, /preserved/);
  assert.deepEqual(calls, ['check', 'request']);
  calls.length = 0;
  const next = await service.ensureProjectVideoAccess(project, {
    ...prompts, requestOriginal: async () => { calls.push('request'); return true; },
  });
  assert.deepEqual(calls, ['check', 'request', 'pick', 'check', 'probe', 'confirm', 'save']);
  assert.equal(next.sources[0].uri, newUri);
  assert.deepEqual(project, original);
});

test('UI requires an explicit affirmative action and dismissing either prompt cancels', async () => {
  let alert;
  const { projectMediaRecoveryPrompts: prompts } = loadWithPorts('src/components/editor/project-media-recovery-prompts.ts', {
    'react-native': { Alert: { alert: (...args) => { alert = args; } } },
  });
  for (const start of [
    () => prompts.requestOriginal(fixture().sources[0], 'unavailable'),
    () => prompts.confirmOriginal(fixture().sources[0], document),
  ]) {
    const dismissed = start();
    alert[3].onDismiss();
    assert.equal(await dismissed, false);
    const cancelled = start();
    alert[2][0].onPress();
    assert.equal(await cancelled, false);
    const accepted = start();
    alert[2][1].onPress();
    assert.equal(await accepted, true);
  }
});
