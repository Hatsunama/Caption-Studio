import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MAX_PROJECT_WATERMARKS, createWatermarkLayer } from '../src/lib/project-editor.ts';
import { decodeVersionTwoProject, serializeProjectSnapshot } from '../src/lib/project-schema.ts';
import { DEFAULT_CAPTION_STYLE } from '../src/types/project.ts';

function project() {
  return decodeVersionTwoProject({ schemaVersion: 2, id: 'watermark-project', name: 'Watermark', createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z', sources: [{ id: 'source', uri: 'file:///video.mp4', storageMode: 'copied', displayName: 'Video', durationMs: 12000, width: 1080, height: 1920, rotation: 0, frameRate: 30 }], clips: [{ id: 'clip', sourceId: 'source', sourceStartMs: 0, sourceEndMs: 12000 }], transcription: { language: 'en', modelId: 'fast', words: [] }, captions: [], projectStyle: structuredClone(DEFAULT_CAPTION_STYLE), layers: [{ id: 'captions', kind: 'captions', name: 'Captions', visible: true }] });
}

test('watermarks are persistent timeline-owned text layers with a five-item limit', () => {
  let next = project();
  for (let index = 0; index < MAX_PROJECT_WATERMARKS; index += 1) {
    const result = createWatermarkLayer(next, `watermark-${index}`, 12_000, `Mark ${index + 1}`);
    assert.ok(result);
    next = result.project;
    assert.equal(result.layer.watermark, true);
    assert.equal(result.layer.startMs, 0);
    assert.equal(result.layer.endMs, 12_000);
    assert.equal(result.layer.timingMode, 'timeline');
  }
  assert.equal(createWatermarkLayer(next, 'too-many', 12_000, 'Too many'), undefined);
  const restored = decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(next)));
  assert.equal(restored.layers.filter((layer) => layer.kind === 'text' && layer.watermark).length, MAX_PROJECT_WATERMARKS);
  assert.match(readFileSync(new URL('../src/components/editor/layer-timeline.tsx', import.meta.url), 'utf8'), /layer\.watermark \? '#E8579C88'/);
});