import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

import { decodeCaptionDraft } from '../src/lib/caption-script.ts';
import { mergeRecoveredDualCaptionDrafts } from '../src/lib/dual-caption-drafts.ts';
import { decodePersistedProject } from '../src/lib/project-codec.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { decodeVersionTwoProject, serializeProjectSnapshot } from '../src/lib/project-schema.ts';
import { setVideoClipTransform } from '../src/lib/project-editor.ts';

function project() {
  return createCaptionProject({ id: 'project-audit', name: 'Audit', sources: [{
    id: 'source-audit', uri: 'content://provider/video/1', storageMode: 'linked',
    displayName: 'video.mp4', durationMs: 6_000, width: 1920, height: 1080, rotation: 0,
  }] });
}

test('independent video scale survives a durable project round-trip', () => {
  const initial = project();
  const changed = setVideoClipTransform(initial, initial.clips[0].id, { scaleX: 1.75, scaleY: 0.62 });
  const reopened = decodePersistedProject(serializeProjectSnapshot(changed));
  assert.equal(reopened.clips[0].transform.scaleX, 1.75);
  assert.equal(reopened.clips[0].transform.scaleY, 0.62);
});

test('save rejects clip and audio states that reopen would reject', () => {
  const beyondSource = project();
  beyondSource.clips[0].sourceEndMs = 7_000;
  assert.throws(() => serializeProjectSnapshot(beyondSource), /source bounds/i);

  const duplicateAudio = project();
  duplicateAudio.audioSources = [{ id: 'audio-source', uri: 'file:///data/user/0/app/files/audio.m4a',
    storageMode: 'copied', displayName: 'audio.m4a', durationMs: 3_000 }];
  duplicateAudio.audioClips = [0, 1].map(() => ({ id: 'audio-clip', sourceId: 'audio-source',
    anchor: 'timeline', startMs: 0, sourceStartMs: 0, sourceEndMs: 1_000, volume: 1, muted: false,
    fadeInMs: 0, fadeOutMs: 0 }));
  assert.throws(() => serializeProjectSnapshot(duplicateAudio), /duplicate/i);
});

test('project decoding refuses local file traversal, including encoded segments', () => {
  const unsafe = project();
  unsafe.sources[0].uri = 'file:///data/user/0/app/files/projects/project-audit/../other.mp4';
  unsafe.sources[0].storageMode = 'copied';
  assert.throws(() => decodeVersionTwoProject(unsafe), /URI|path|traversal/i);

  const encoded = project();
  encoded.audioSources = [{ id: 'audio-source', uri: 'file:///data/user/0/app/files/audio/%2e%2e/other.m4a',
    storageMode: 'copied', displayName: 'audio.m4a', durationMs: 3_000 }];
  assert.throws(() => decodeVersionTwoProject(encoded), /URI|path|traversal/i);
});

test('recovered caption drafts return decoded defaults, not untrusted original objects', () => {
  const raw = [{ id: 'cue-1', text: 'Hello', startMs: 0, endMs: 1000, wordIds: [] }];
  const decoded = decodeCaptionDraft(raw);
  assert.equal(decoded?.[0].timelineVisible, true);
  assert.notEqual(decoded?.[0], raw[0]);
});

test('recovery preserves an intentional second-language word matching the primary', () => {
  const committed = { cue: { primaryText: 'All right', translatedText: 'D’accord' } };
  const recovered = { cue: { primaryText: 'OK', translatedText: 'OK' } };
  assert.equal(mergeRecoveredDualCaptionDrafts(recovered, committed).cue.translatedText, 'OK');
});

test('project persistence reports specific project errors without calling them storage failures', () => {
  const source = readFileSync(new URL('../src/services/project-persistence.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  runInNewContext(compiled, { exports, require(name) {
    if (name === '@/lib/persistence-boundaries') return { publishAfterDurableWrite() {} };
    if (name === '@/services/database') return { saveProject() {} };
    throw new Error(`Unexpected dependency ${name}`);
  } });
  assert.match(new exports.ProjectPersistenceError(new Error('This project has been deleted.')).message, /deleted/i);
  assert.match(new exports.ProjectPersistenceError('opaque failure').message, /not saved/i);
});
