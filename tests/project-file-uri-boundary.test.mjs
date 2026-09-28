import assert from 'node:assert/strict';
import test from 'node:test';

import { assertProjectMediaReferences } from '../src/lib/project-file-uri-boundary.ts';

const roots = {
  documentDirectory: 'file:///data/user/0/com.xmilo_at_your_side.caption_studio/files/',
  cacheDirectory: 'file:///data/user/0/com.xmilo_at_your_side.caption_studio/cache/',
};

function project(uri) {
  return {
    sources: [{ uri, previewUri: `${roots.cacheDirectory}preview.mp4` }],
    audioSources: [{ uri: `${roots.documentDirectory}projects/p/audio/voice.m4a` }],
    layers: [{ kind: 'image', uri: `${roots.documentDirectory}projects/p/images/sticker.png` }],
    projectStyle: { font: { uri: `${roots.documentDirectory}fonts/custom.ttf` } },
    captions: [{ text: 'A literal file:///etc/passwd is just caption text.' }],
  };
}

test('project media admission accepts picker documents and app-owned files without interpreting caption text', () => {
  assert.doesNotThrow(() => assertProjectMediaReferences(project('content://picker/video/1'), roots));
  assert.doesNotThrow(() => assertProjectMediaReferences(project(`${roots.documentDirectory}projects/p/video.mp4`), roots));
});

test('project media admission rejects external, sibling-root, encoded traversal, and malformed file references', () => {
  for (const uri of [
    'file:///etc/passwd',
    'file:///data/user/0/com.xmilo_at_your_side.caption_studio/files-evil/video.mp4',
    `${roots.documentDirectory}%2e%2e/shared/video.mp4`,
    `${roots.documentDirectory}%252e%252e/shared/video.mp4`,
    `${roots.documentDirectory}video.mp4?unexpected=1`,
    `${roots.documentDirectory}video.mp4#fragment`,
  ]) {
    assert.throws(() => assertProjectMediaReferences(project(uri), roots), /app-owned|invalid/i, uri);
  }
});

test('project media admission checks nested URI fields and fails closed without app storage roots', () => {
  const nested = project('content://picker/video/1');
  nested.layers[0].uri = 'file:///storage/emulated/0/DCIM/other.jpg';
  assert.throws(() => assertProjectMediaReferences(nested, roots), /app-owned|invalid/i);
  assert.throws(() => assertProjectMediaReferences(project(`${roots.documentDirectory}video.mp4`), {
    documentDirectory: null,
    cacheDirectory: null,
  }), /app-owned|invalid/i);
});

test('project media admission rejects malformed content scheme references', () => {
  for (const uri of ['content:video/1', 'content:/video/1', 'content://']) {
    assert.throws(() => assertProjectMediaReferences(project(uri), roots), /app-owned|invalid/i, uri);
  }
});
