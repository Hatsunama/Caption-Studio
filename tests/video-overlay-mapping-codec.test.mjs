import assert from 'node:assert/strict';
import test from 'node:test';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { addVideoLayer, setLayerTiming } from '../src/lib/project-editor.ts';
import { decodePersistedProject } from '../src/lib/project-codec.ts';
import { setClipPlaybackRate } from '../src/lib/video-timeline.ts';
import { videoOverlaySegments } from '../src/lib/video-overlay-segments.ts';

function fixture() {
  let p = createCaptionProject({ id: 'codec-mapping', name: 'Codec', sources: [{ id: 'main', uri: 'file:///main.mp4',
    displayName: 'Main', storageMode: 'copied', durationMs: 8000, width: 360, height: 640, rotation: 0 }] });
  return addVideoLayer(p, { id: 'pip', name: 'PiP', uri: 'file:///pip.mp4', currentMs: 1000,
    durationMs: 8000, sourceDurationMs: 8000, sourceStartMs: 500 }).project;
}
const layer = p => p.layers.find(l => l.id === 'pip');
const roundtrip = p => decodePersistedProject(JSON.stringify(p));
const segments = p => videoOverlaySegments(layer(p), p.clips, Infinity);

test('legacy drafts retain output and omit mapping until an affected edit', () => {
  const p = fixture();
  const old = roundtrip(p);
  assert.equal(layer(old).sourceMapping, undefined);
  assert.deepEqual(segments(old), segments(p));
  assert.deepEqual(segments(roundtrip(old)), segments(p));
  assert.equal(old.schemaVersion, 2);
  const edited = roundtrip(setLayerTiming(old, 'pip', 'start', 1250, 4000));
  assert.ok(layer(edited).sourceMapping);
  assert.equal(edited.schemaVersion, 2);
  assert.deepEqual(segments(roundtrip(setLayerTiming(edited, 'pip', 'start', 1000, 4000))), segments(p));
});

for (const [name, alter] of [
  ['non-array', l => { l.sourceMapping = {}; }],
  ['null', l => { l.sourceMapping = null; }],
  ['nonfinite media', l => { l.sourceMapping[0].mediaStartMs = Infinity; }],
  ['outside selected media', l => { l.sourceMapping[0].mediaStartMs = 9000; }],
  ['negative media', l => { l.sourceMapping[0].mediaStartMs = -1; }],
  ['invalid rate', l => { l.sourceMapping[0].ownerRate = 0; }],
  ['missing rate', l => { delete l.sourceMapping[0].ownerRate; }],
  ['unknown owner', l => { l.sourceMapping[0].clipId = 'unknown'; }],
  ['empty interval', l => { l.sourceMapping[0].sourceEndMs = l.sourceMapping[0].sourceStartMs; }],
  ['outside owner media', l => { l.sourceMapping[0].sourceEndMs = 8001; }],
  ['overlap', l => { l.sourceMapping.push({ ...l.sourceMapping[0], mediaStartMs: 100 }); }],
  ['unmapped selection', l => { l.sourceMapping = []; }],
  ['timeline contradiction', l => { l.timingMode = 'timeline'; }],
  ['existing 5000 bound', l => { l.sourceMapping = Array.from({ length: 5001 }, () => ({ ...l.sourceMapping[0] })); }],
]) test(`malformed video mapping rejects ${name}`, () => {
  const p = setLayerTiming(fixture(), 'pip', 'start', 1250, 4000);
  alter(layer(p));
  assert.throws(() => roundtrip(p));
});


test('latent full association may exceed available output after a main-rate edit and still restores', () => {
  let p = setLayerTiming(fixture(), 'pip', 'start', 1250, 4000);
  const before = segments(p);
  p = roundtrip(setClipPlaybackRate(p, p.clips[0].id, 0.25));
  assert.ok(segments(p).every(s => s.sourceStartMs >= 0 && s.sourceEndMs <= 8000));
  p = roundtrip(setClipPlaybackRate(p, p.clips[0].id, 1));
  assert.deepEqual(segments(p), before);
});
