import assert from 'node:assert/strict';
import test from 'node:test';
import { createCaptionProject } from '../src/lib/project-factory.ts';
import { addImageLayer, addVideoLayer, createTextLayer, createWatermarkLayer } from '../src/lib/project-editor.ts';

const creators = {
  text: (project, id) => createTextLayer(project, id, 0, 5000),
  watermarks: (project, id) => createWatermarkLayer(project, id, 5000, 'Mark'),
  images: (project, id) => addImageLayer(project, { id, name: id, uri: 'file:///image.png', currentMs: 0, durationMs: 5000 }),
  videos: (project, id) => addVideoLayer(project, { id, name: id, uri: 'file:///overlay.mp4', currentMs: 0, durationMs: 5000, sourceDurationMs: 5000 }),
};

for (const [kind, create] of Object.entries(creators)) {
  test(`${kind}: first participating item retains its original fallback with or without tombstones`, () => {
    for (const withImage of [false, true]) {
      for (const withTombstone of [false, true]) {
        let project = createCaptionProject({ id: 'fallback', name: 'Fallback', sources: [{
          id: 'source', uri: 'file:///source.mp4', storageMode: 'copied', displayName: 'Source',
          durationMs: 5000, width: 1920, height: 1080, rotation: 0, frameRate: 30,
        }] });
        // The other text subtype must not count as a matching group.
        project = (kind === 'watermarks' ? creators.text : creators.watermarks)(project, 'other-text').project;
        if (withImage && kind !== 'images') project = creators.images(project, 'existing-image').project;
        if (kind !== 'videos') project = creators.videos(project, 'existing-video').project;
        if (withTombstone) {
          const hidden = { ...create(project, 'hidden').layer, timelineVisible: false };
          project = { ...project, layers: [hidden, ...project.layers] };
        }
        const before = [...project.layers];
        const firstImage = before.findIndex(layer => layer.kind === 'image');
        const insertion = ['text', 'watermarks'].includes(kind) && firstImage >= 0 ? firstImage : before.length;
        const result = create(project, 'fresh');
        const expected = [...before];
        expected.splice(insertion, 0, result.layer);
        assert.deepEqual(result.project.layers, expected);
        assert.deepEqual(project.layers, before, 'undo snapshot remains unchanged');
        for (const layer of before) assert.equal(result.project.layers.find(item => item.id === layer.id), layer);
      }
    }
  });
}
