import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreviewSceneController } from '../src/lib/preview-scene-controller.ts';
import { applyPreviewSceneGeometry } from '../src/lib/preview-scene-project.ts';
import { resolveLayerGeometry } from '../src/lib/layer-geometry.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { addImageLayer, addVideoLayer, createWatermarkLayer } from '../src/lib/project-editor.ts';
import { createTranslationCaptionTrack, resolveCaptionPairs, setTranslationCueStyle } from '../src/lib/caption-tracks.ts';
import { resolveCaptionStyle } from '../src/lib/style-resolver.ts';
import { videoClipPreviewGeometry } from '../src/lib/video-transform.ts';
import { decodeVersionTwoProject } from '../src/lib/project-schema.ts';

const geometry = { position: { x: .5, y: .5 }, box: { width: .2, height: .2 },
  rotation: 0, scale: 1, scaleX: 1, scaleY: 1 };
const source = { id: 'source', uri: 'file:///source.mp4', storageMode: 'copied',
  displayName: 'source.mp4', durationMs: 5000, width: 1920, height: 1080, rotation: 0 };
const frame = { pageX: 71, pageY: 129 };
const point = (id, x, y = 150) => ({ id, x: x + frame.pageX, y: y + frame.pageY });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

function fixture(kind) {
  let project = createCaptionProject({ id: 'pinch', name: 'Pinch', sources: [source] });
  project.captions = [{ id: 'cue', text: 'Hello', wordIds: [], startMs: 0, endMs: 3000 }];
  project.projectStyle = { ...project.projectStyle, ...geometry };
  project = createTranslationCaptionTrack(project, { id: 'fr', languageTag: 'fr', displayName: 'French',
    translations: { cue: 'Bonjour' } });
  project = setTranslationCueStyle(project, 'fr', 'cue', geometry, project.updatedAt);
  if (kind === 'image') project = addImageLayer(project, { id: kind, name: kind,
    uri: 'file:///image.png', currentMs: 0, durationMs: 5000 }).project;
  if (kind === 'video-overlay') project = addVideoLayer(project, { id: kind, name: kind,
    uri: 'file:///pip.mp4', currentMs: 0, durationMs: 5000, sourceDurationMs: 5000, includeAudio: true }).project;
  if (kind === 'text' || kind === 'watermark') project.layers.push({ id: kind, kind: 'text', name: kind,
    text: kind, visible: true, startMs: 0, endMs: 3000, watermark: kind === 'watermark',
    style: { ...project.projectStyle } });
  project.layers = project.layers.map(layer => layer.kind === 'image' || layer.kind === 'video'
    ? { ...layer, ...geometry } : layer);
  const selection = kind === 'captions' ? { kind, captionId: 'cue' }
    : kind === 'translation' ? { kind, id: 'fr', captionId: 'cue' }
    : { kind: kind === 'watermark' ? 'text' : kind, id: kind };
  const read = p => resolveLayerGeometry(kind === 'captions' ? resolveCaptionStyle(p.projectStyle, p.captions[0])
    : kind === 'translation' ? resolveCaptionPairs(p, 'fr')[0].style
    : kind === 'text' || kind === 'watermark' ? p.layers.find(layer => layer.id === kind).style
    : p.layers.find(layer => layer.id === kind));
  return { project, selection, read };
}

// Exercise the real setters and persisted model for every first-pointer owner.
for (const kind of ['video-overlay', 'image', 'text', 'watermark', 'captions', 'translation']) {
  for (const order of [0, 1, 2]) for (const simultaneous of [false, true]) {
    test(`${kind}: ${simultaneous ? 'simultaneous' : 'staggered'} second contact on peer order ${order} transforms only first owner through JSON reopen`, () => {
      const f = fixture(kind);
      f.project.layers.push({ id: 'peer', kind: 'text', name: 'Peer', text: 'Peer', visible: true,
        startMs: 0, endMs: 3000, style: { ...f.project.projectStyle, ...geometry, position: { x: .8, y: .5 } } });
      exercisePeerPinch(f, kind, order, simultaneous, { width: 400, height: 300 });
    });
  }
}

for (const order of [0, 1, 2]) for (const simultaneous of [false, true]) {
  test(`default watermark: ${simultaneous ? 'simultaneous' : 'staggered'} second contact over peer order ${order} on native-like canvas`, () => {
    const f = fixture('watermark');
    f.project.layers = f.project.layers.filter(layer => layer.id !== 'watermark');
    f.project = createWatermarkLayer(f.project, 'watermark', 5000, 'Watermark').project;
    assert.deepEqual(f.read(f.project), { ...geometry, position: { x: .5, y: .9 }, box: { width: .7, height: .14 } });
    f.project.layers.push({ id: 'peer', kind: 'text', name: 'Peer', text: 'Peer', visible: true,
      startMs: 0, endMs: 3000, style: { ...f.project.projectStyle, ...geometry, position: { x: .8, y: .5 } } });
    exercisePeerPinch(f, 'watermark', order, simultaneous, { width: 360, height: 202.5 });
  });
}

function exercisePeerPinch(f, kind, order, simultaneous, size) {
  f.project.audioSources = [{ id: 'audio', uri: 'file:///audio.m4a', storageMode: 'copied',
    displayName: 'Audio', durationMs: 5000, origin: 'video-audio' }];
  f.project.audioClips = [{ id: 'audio-clip', sourceId: 'audio', anchor: 'video', videoClipId: f.project.clips[0].id,
    requestedSourceStartMs: 0, requestedSourceEndMs: 5000, anchorOffsetMs: 0,
    startMs: 0, sourceStartMs: 0, sourceEndMs: 5000, volume: .7, muted: false, fadeInMs: 10, fadeOutMs: 20 }];
  f.project = createTranslationCaptionTrack(f.project, { id: 'de', languageTag: 'de', displayName: 'German', translations: { cue: 'Hallo' } });
  const inputOriginal = structuredClone(f.project);
  let project = decodeVersionTwoProject(JSON.parse(JSON.stringify(f.project)));
  const original = decodeVersionTwoProject(JSON.parse(JSON.stringify(project))), committedKeys = [], selections = [];
  let starts = 0, ends = 0;
  const owner = { key: kind, selection: f.selection, geometry: f.read(project), order: 1, deletable: true };
  const peerLayer = project.layers.find(layer => layer.id === 'peer');
  const peer = { key: 'z:peer', selection: { kind: 'text', id: 'peer' }, geometry: resolveLayerGeometry(peerLayer.style), order };
  const main = { key: 'main', selection: { kind: 'video', id: project.clips[0].id },
    geometry: videoClipPreviewGeometry(project, project.clips[0].id), order: -1, yieldToForeground: true };
  const c = createPreviewSceneController();
  let options = { targets: [main, owner, peer], enabled: true, contextKey: 'peer:0',
    onSelect(selection) {
      selections.push(selection);
      options = { ...options, selectedKey: kind, targets: [...options.targets].reverse() };
      c.configure(options);
    },
    onClearSelection() { assert.fail('first pointer hits owner'); }, onDelete() { assert.fail('pinch must not delete'); },
    onInteractionStart() { starts++; }, onInteractionEnd() { ends++; },
    onChange(target, draft) { committedKeys.push(target.key); project = applyPreviewSceneGeometry(project, target, draft); },
  };
  c.configure(options); c.layout(size);
  const local = (id, x, y) => ({ id, x: frame.pageX + x, y: frame.pageY + y });
  const first = local(7, size.width * owner.geometry.position.x, size.height * owner.geometry.position.y);
  const second = local(2, size.width * .8, size.height * .5);
  const pivot = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  const spread = p => ({ id: p.id, x: pivot.x + 1.5 * (p.x - pivot.x), y: pivot.y + 1.5 * (p.y - pivot.y) });
  c.grant(simultaneous ? [first, second] : [first], frame);
  if (!simultaneous) c.start([second, first]);
  // A third contact on a peer must never replace either admitted pointer.
  c.start([local(0, size.width * .8, size.height * .5), second, first]);
  c.move([local(0, 5, 5), spread(second), spread(first)]);
  const draft = c.geometryFor(kind, owner.geometry);
  near(draft.scale, 1.5); near(draft.rotation, 0);
  near(draft.position.x, owner.geometry.position.x + (owner.geometry.position.x - .8) * .25);
  near(draft.position.y, owner.geometry.position.y + (owner.geometry.position.y - .5) * .25);
  near(draft.scaleX, 1); near(draft.scaleY, 1);
  assert.equal(c.selectedKey, kind);
  assert.deepEqual(c.geometryFor(peer.key, peer.geometry), peer.geometry);
  assert.deepEqual(c.geometryFor(main.key, main.geometry), main.geometry);
  assert.deepEqual(project, original); assert.deepEqual(committedKeys, []);
  c.end([], [spread(first), spread(second), local(0, 5, 5)]); c.release(); c.release();
  assert.deepEqual(committedKeys, [kind]); assert.deepEqual(selections, [f.selection]);
  assert.equal(starts, 1); assert.equal(ends, 1);
  const reopened = decodeVersionTwoProject(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(f.read(project), draft); assert.deepEqual(f.read(reopened), draft);
  for (const p of [project, reopened]) {
    assert.deepEqual(p.layers.filter(layer => layer.id !== f.selection.id), original.layers.filter(layer => layer.id !== f.selection.id));
    for (const key of ['clips', 'sources', 'audioClips', 'audioSources', 'canvas', 'videoTransform']) assert.deepEqual(p[key], original[key], key);
    if (kind !== 'captions') assert.deepEqual(p.captions, original.captions);
    if (kind !== 'captions') assert.deepEqual(p.projectStyle, original.projectStyle);
    if (kind !== 'translation') assert.deepEqual(p.captionTracks, original.captionTracks);
    if (kind === 'translation') assert.deepEqual(p.captionTracks.translations.filter(track => track.id !== 'fr'), original.captionTracks.translations.filter(track => track.id !== 'fr'));
  }
  assert.deepEqual(f.project, inputOriginal, 'input project remains immutable');
  if (kind === 'video-overlay') {
    const { position, box, scale, scaleX, scaleY, rotation, ...metadata } = original.layers.find(layer => layer.id === kind);
    assert.deepEqual(reopened.layers.find(layer => layer.id === kind), { ...metadata, ...draft });
  }
}

for (const kind of ['video-overlay', 'image', 'text', 'watermark', 'captions', 'translation']) {
  for (const cancel of [false, true]) test(`${kind}: repeat pinch ${cancel ? 'cancels without persistence' : 'persists the captured foreground through reopen'}`, () => {
    const f = fixture(kind), original = structuredClone(f.project);
    let project = f.project, commits = 0, starts = 0, ends = 0, selected = kind;
    const background = { key: 'main', selection: { kind: 'video', id: project.clips[0].id },
      geometry: videoClipPreviewGeometry(project, project.clips[0].id), order: -1, yieldToForeground: true };
    const foreground = { key: kind, selection: f.selection, geometry: f.read(project), order: 1, deletable: true };
    const controller = createPreviewSceneController();
    const options = () => ({ targets: [background, foreground], selectedKey: selected, enabled: true,
      contextKey: 'pinch:0', onSelect(value) {
        selected = value === f.selection ? kind : 'main'; controller.configure(options());
      }, onClearSelection() { assert.fail('unexpected empty canvas'); },
      onDelete() { assert.fail('pinch must not delete'); },
      onChange(target, draft) { commits++; project = applyPreviewSceneGeometry(project, target, draft); },
      onInteractionStart() { starts++; }, onInteractionEnd() { ends++; } });
    controller.configure(options()); controller.layout({ width: 400, height: 300 });
    // Selection tap followed by a pinch whose second contact is on main footage.
    controller.grant([point(7, 200)], frame); controller.end([], [point(7, 200)]); controller.release();
    controller.grant([point(7, 200)], frame); controller.start([point(2, 300), point(7, 200)]);
    controller.move([point(7, 150), point(2, 350)]);
    const draft = controller.geometryFor(kind, foreground.geometry);
    near(draft.scale, 2); near(draft.position.x, .375);
    assert.equal(controller.selectedKey, kind); assert.equal(commits, 0);
    if (cancel) controller.cancel();
    else { controller.end([], [point(7, 150), point(2, 350)]); controller.release(); }
    controller.release();
    assert.equal(starts, 2); assert.equal(ends, 2); assert.equal(commits, cancel ? 0 : 1);
    assert.deepEqual(f.project, original, 'input project remains immutable');
    assert.deepEqual(project.clips, original.clips, 'background footage must not change');
    assert.deepEqual(project.sources, original.sources);
    assert.deepEqual(project.audioClips, original.audioClips);
    assert.deepEqual(project.canvas, original.canvas);
    if (cancel) assert.equal(project, f.project);
    else {
      assert.deepEqual(f.read(project), draft);
      const reopened = decodeVersionTwoProject(JSON.parse(JSON.stringify(project)));
      assert.deepEqual(f.read(reopened), draft);
      if (kind === 'video-overlay') {
        assert.equal(reopened.layers.find(layer => layer.id === kind).includeAudio, true);
        assert.equal(reopened.layers.find(layer => layer.id === kind).sourceDurationMs, 5000);
      }
    }
  });
}
