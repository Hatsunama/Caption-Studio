import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreviewSceneController } from '../src/lib/preview-scene-controller.ts';
import { applyPreviewSceneGeometry } from '../src/lib/preview-scene-project.ts';
import { resolveLayerGeometry } from '../src/lib/layer-geometry.ts';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { addImageLayer, addVideoLayer } from '../src/lib/project-editor.ts';
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
