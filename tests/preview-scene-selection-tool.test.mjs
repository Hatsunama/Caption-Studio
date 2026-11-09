import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { transformSync } from 'esbuild';
import { editorSelectionState, shouldOpenEditorTool } from '../src/lib/editor-selection.ts';
import { createPreviewSceneController } from '../src/lib/preview-scene-controller.ts';

// Compile the actual editor callbacks together, preserving their call relationship.
const source = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
function declaration(name) {
  const start = source.indexOf(`  const ${name} = (`);
  const end = source.indexOf('\n  };', start);
  assert.ok(start >= 0 && end > start, `production ${name} declaration must exist`);
  return source.slice(start, end + '\n  };'.length);
}
const callbacks = transformSync([
  declaration('openEditorTool'), declaration('selectEditorObject'),
  'return { openEditorTool, selectEditorObject };',
].join('\n'), { loader: 'ts' }).code;

const geometry = { position: { x: .5, y: .5 }, box: { width: .2, height: .2 },
  rotation: 0, scale: 1, scaleX: 1, scaleY: 1 };
const origin = { pageX: 71, pageY: 129 };
const point = (id, x = 200) => ({ id, x: x + origin.pageX, y: 150 + origin.pageY });
const scenarios = [
  ['PiP', { kind: 'video-overlay', id: 'pip' }, 'stickers'],
  ['image', { kind: 'image', id: 'image' }, 'stickers'],
  ['text', { kind: 'text', id: 'text' }, 'stickers'],
  ['watermark', { kind: 'text', id: 'watermark' }, 'stickers'],
  ['primary cue', { kind: 'captions', captionId: 'cue' }, 'captions'],
  ['translation cue', { kind: 'translation', id: 'fr', captionId: 'cue' }, 'captions'],
];

for (const [label, selection, tool] of scenarios) {
  for (const simultaneous of [false, true]) test(`${label}: Audio hands tools back on repeat ${simultaneous ? 'simultaneous' : 'staggered'} pinch grant`, () => {
    const state = {};
    const calls = { selections: [], commits: [], tools: [], starts: 0, ends: 0, pauses: 0 };
    const context = {
      editorSelectionState, shouldOpenEditorTool, activeToolRef: { current: 'video' },
      transport: { pause() { calls.pauses++; } },
      setActiveTool(value) { state.tool = value; calls.tools.push(value); },
    };
    for (const [setter, key] of Object.entries({
      setSelectedCaptionId: 'captionId', setSelectedLayerId: 'layerId',
      setSelectedClipId: 'clipId', setSelectedAudioClipId: 'audioClipId',
      setSelectedTranslationTrackId: 'translationTrackId',
    })) context[setter] = value => { state[key] = value; };
    const editor = new Function(...Object.keys(context), callbacks)(...Object.values(context));
    const foreground = { key: 'foreground', selection, geometry, order: 1, deletable: true };
    const background = { key: 'main', selection: { kind: 'video', id: 'main' },
      geometry: { ...geometry, box: { width: 1, height: 1 } }, order: -1, yieldToForeground: true };
    const targets = [background, foreground], before = structuredClone(targets);
    const controller = createPreviewSceneController();
    let selectedKey;
    const configure = () => controller.configure({ targets, selectedKey, enabled: true, contextKey: 'project:0',
      onSelect(value) {
        calls.selections.push(value);
        editor.selectEditorObject(value);
        selectedKey = targets.find(target => target.selection === value).key;
        configure(); // Selection synchronously rerenders with the same geometry.
      },
      onClearSelection() { assert.fail('must retain selection'); },
      onDelete() { assert.fail('must not delete'); },
      onChange(target, draft) { calls.commits.push({ key: target.key, selection: target.selection, draft }); },
      onInteractionStart() { calls.starts++; context.transport.pause(); },
      onInteractionEnd() { calls.ends++; },
    });
    configure(); controller.layout({ width: 400, height: 300 });
    controller.grant([point(7)], origin); controller.end([], [point(7)]); controller.release();
    assert.equal(state.tool, tool);
    const selectedState = { ...state };
    editor.openEditorTool('audio'); // Real toolbar callback keeps the layer selected.
    assert.deepEqual(state, { ...selectedState, tool: 'audio' });
    configure();
    controller.grant(simultaneous ? [point(7), point(2, 300)] : [point(7)], origin);
    assert.equal(state.tool, tool, 'selected layer must reopen its tool immediately on grant');
    assert.deepEqual(state, selectedState, 'all selection fields retain the original object identity');
    assert.equal(controller.selectedKey, foreground.key);
    assert.deepEqual(calls.selections, [selection, selection]);
    assert.deepEqual(calls.tools, [tool, 'audio', tool]);
    if (!simultaneous) controller.start([point(2, 300), point(7)]);
    controller.move([point(7, 150), point(2, 350)]);
    const draft = controller.geometryFor(foreground.key, geometry);
    assert.equal(draft.scale, 2); assert.equal(draft.position.x, .375);
    assert.equal(controller.selectedKey, foreground.key);
    assert.deepEqual(controller.geometryFor(background.key, background.geometry), background.geometry);
    assert.equal(calls.commits.length, 0, 'drafts cannot save geometry');
    controller.end([], [point(7, 150), point(2, 350)]); controller.release(); controller.release();
    assert.equal(calls.commits.length, 1, 'release produces exactly one save callback');
    assert.equal(calls.commits[0].key, foreground.key);
    assert.equal(calls.commits[0].selection, selection);
    assert.deepEqual(calls.commits[0].draft, draft);
    assert.deepEqual(calls.selections, [selection, selection], 'pinch never cycles to main');
    assert.deepEqual(calls.tools, [tool, 'audio', tool], 'moves and release do not reopen tools');
    assert.equal(calls.starts, 2); assert.equal(calls.ends, 2);
    assert.equal(calls.pauses, 4, 'selection and interaction-start pause paths both remain active');
    assert.deepEqual(targets, before, 'all source geometry remains immutable');
  });
}
