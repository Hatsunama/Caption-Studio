import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

import { createCaptionProject } from '../src/lib/project-factory.ts';
import { setVideoClipTransform, splitVideoClip } from '../src/lib/project-editor.ts';
import { decodeVersionTwoProject, serializeProjectSnapshot } from '../src/lib/project-schema.ts';

test('splitting video preserves source ownership, manual text, and valid child word references through persistence', () => {
  const source = { id: 'source', uri: 'content://video/source', storageMode: 'linked', displayName: 'source.mp4', durationMs: 6_000, width: 1080, height: 1920, rotation: 0 };
  const project = createCaptionProject({ id: 'split-integrity', name: 'Split integrity', sources: [source] });
  const clipId = project.clips[0].id;
  const sourceWords = [
    { id: 'word-left', text: 'left', startMs: 400, endMs: 1_200 },
    { id: 'word-cross', text: 'original', startMs: 2_700, endMs: 3_300 },
    { id: 'word-right', text: 'right', startMs: 4_000, endMs: 4_800 },
  ];
  project.transcription = {
    ...project.transcription,
    language: 'en',
    modelId: 'fast',
    words: sourceWords.map((word) => ({ ...word, id: `${clipId}-${word.id}` })),
    sourceResults: { source: { language: 'en', modelId: 'fast', generatedAt: '2026-01-01T00:00:00.000Z', words: sourceWords } },
  };
  project.captions = [
    { id: 'left-caption', text: 'left', textMode: 'automatic', timingMode: 'source', startMs: 400, endMs: 1_200, wordIds: [`${clipId}-word-left`], timelineVisible: true, sourceAnchor: { clipId, sourceStartMs: 400, sourceEndMs: 1_200, wordIds: [`${clipId}-word-left`] } },
    { id: 'cross-caption', text: 'do not rewrite me', textMode: 'manual', timingMode: 'source', startMs: 2_700, endMs: 3_300, wordIds: [`${clipId}-word-cross`], timelineVisible: true, styleOverride: { textColor: '#19D98B', italic: true }, sourceAnchor: { clipId, sourceStartMs: 2_700, sourceEndMs: 3_300, wordIds: [`${clipId}-word-cross`] } },
    { id: 'right-caption', text: 'right', textMode: 'automatic', timingMode: 'source', startMs: 4_000, endMs: 4_800, wordIds: [`${clipId}-word-right`], timelineVisible: true, sourceAnchor: { clipId, sourceStartMs: 4_000, sourceEndMs: 4_800, wordIds: [`${clipId}-word-right`] } },
  ];
  const before = structuredClone(project);

  const result = splitVideoClip(project, clipId, 3_000, 'left-clip', 'right-clip');
  assert.ok(result);
  const expected = [
    ['left-caption', 'left', 400, 1_200, 'left-clip', ['left-clip-word-left']],
    ['cross-caption', 'do not rewrite me', 2_700, 3_000, 'left-clip', ['left-clip-word-cross']],
    ['cross-caption-right-clip', 'do not rewrite me', 3_000, 3_300, 'right-clip', ['right-clip-word-cross']],
    ['right-caption', 'right', 4_000, 4_800, 'right-clip', ['right-clip-word-right']],
  ];
  const assertSplitCaptions = (current) => {
    assert.deepEqual(current.captions.map((caption) => [
      caption.id, caption.text, caption.startMs, caption.endMs, caption.sourceAnchor?.clipId, caption.wordIds,
    ]), expected);
    assert.equal(new Set(current.captions.map((caption) => caption.id)).size, 4);
    for (const caption of current.captions) {
      assert.equal(caption.timingMode, 'source');
      assert.equal(caption.timelineVisible, true);
      assert.deepEqual(caption.sourceAnchor.wordIds, caption.wordIds);
      assert.deepEqual([caption.sourceAnchor.sourceStartMs, caption.sourceAnchor.sourceEndMs], [caption.startMs, caption.endMs]);
      const owner = current.clips.find((clip) => clip.id === caption.sourceAnchor.clipId);
      assert.ok(owner && caption.sourceAnchor.sourceStartMs >= owner.sourceStartMs
        && caption.sourceAnchor.sourceEndMs <= owner.sourceEndMs);
      for (const id of caption.wordIds) {
        const word = current.transcription.words.find((word) => word.id === id);
        assert.ok(word && word.startMs < caption.endMs && word.endMs > caption.startMs);
        assert.ok(id.startsWith(`${owner.id}-`));
      }
    }
    for (const caption of current.captions.filter((caption) => caption.id.startsWith('cross-caption'))) {
      assert.equal(caption.textMode, 'manual');
      assert.equal(caption.text, before.captions[1].text, 'each child keeps the complete authored text');
      assert.deepEqual(caption.styleOverride, before.captions[1].styleOverride);
    }
    for (let index = 1; index < current.captions.length; index += 1) {
      assert.ok(current.captions[index - 1].endMs <= current.captions[index].startMs, 'source-owned fragments must not overlap');
    }
  };
  assertSplitCaptions(result.project);
  const recovered = decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(result.project)));
  assertSplitCaptions(recovered);
  assert.deepEqual(project, before, 'split and persistence must not mutate the input project');
});

test('preview layers own hit testing, authored lines, stable transform baselines, and timing UI', () => {
  const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
  const captions = readFileSync(new URL('../src/components/editor/caption-overlay.tsx', import.meta.url), 'utf8');
  const images = readFileSync(new URL('../src/components/editor/image-layer-overlay.tsx', import.meta.url), 'utf8');
  const gesture = readFileSync(new URL('../src/hooks/use-preview-scene-gesture.ts', import.meta.url), 'utf8');
  const presentation = readFileSync(new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/TextPresentation.kt', import.meta.url), 'utf8');
  assert.match(editor, /TransitionTimingSheet/);
  assert.match(editor, /Transition timing…/);
  assert.match(editor, /preserveLineBreaks/);
  assert.match(editor, /usePreviewSceneGesture\(\{/);
  assert.match(editor, /\{\.\.\.previewSceneResponders\}/);
  assert.match(captions, /<CaptionPresentation/);
  assert.match(captions, /authored=\{Boolean\(props\.preserveLineBreaks\)\}/);
  assert.match(captions, /pointerEvents="none"/);
  assert.doesNotMatch(captions, /zIndex:/);
  assert.doesNotMatch(captions, /selectable|onSelect/);
  assert.doesNotMatch(captions, /ref=\{\(node\) =>/);
  assert.match(images, /pointerEvents="none"/);
  assert.doesNotMatch(images, /zIndex:/);
  assert.doesNotMatch(images, /selectable|onSelect/);
  assert.doesNotMatch(images, /ref=\{\(node\) =>/);
  assert.match(presentation, /rawText\.replace\("\\r\\n", "\\n"\)/);
  assert.match(presentation, /text\.contains\('\\n'\)/);
  assert.match(gesture, /onStartShouldSetResponder: \(\) => optionsRef\.current\.enabled/);
  assert.doesNotMatch(gesture, /onStartShouldSetResponderCapture/);
  assert.match(gesture, /onResponderTerminationRequest: \(\) => false/);
  assert.doesNotMatch(images, /useLayerGesture/);
  assert.doesNotMatch(images, /function ImageCornerHandle/);
});

test('timeline seeks retain persistent slot ownership instead of replacing a decoder on transient status', async () => {
  const controller = readFileSync(new URL('../src/hooks/use-timeline-video-controller.ts', import.meta.url), 'utf8');
  assert.equal((controller.match(/useVideoPlayer\(null, configureTimelinePlayer\)/g) ?? []).length, 2);
  assert.match(controller, /runtime\.preparedClipId === entry\.clip\.id && runtime\.firstFrameReady/);
  const retirement = controller.slice(controller.indexOf('const retireSurfaceFrames ='), controller.indexOf('const suspendForTranslation ='));
  assert.match(retirement, /runtime\.prepareToken = nextPrepareToken\(runtime\.prepareToken\);/);
  assert.match(retirement, /runtime\.firstFrameReady = false/);
  assert.match(retirement, /runtime\.playbackUri = undefined/);
  assert.doesNotMatch(controller, /loadedPlaybackUri/);
  const source = ts.createSourceFile('controller.ts', controller, ts.ScriptTarget.Latest, true);
  const find = (root, predicate) => {
    const nodes = [];
    function visit(node) { if (predicate(node)) nodes.push(node); ts.forEachChild(node, visit); }
    visit(root); return nodes;
  };
  const declaration = (root, name) => {
    const matches = find(root, node => ts.isVariableDeclaration(node) && node.name.getText(source) === name);
    assert.equal(matches.length, 1, `one actual ${name} declaration`);
    return matches[0];
  };
  const operation = declaration(source, 'prepareSlotOperation').initializer;
  const guard = declaration(operation, 'sourceChanged').initializer;
  const bindings = { forceReload: false, uri: 'file:///authoritative.mp4', source: { id: 'source' }, windowEndMs: 5000 };
  const runtime = { playbackUri: bindings.uri, sourceId: 'source', appliedWindowEndMs: 5000, sourceMutation: undefined };
  const changed = (patch = {}, runtimePatch = {}) => runInNewContext(`(${guard.getText(source)})`, {
    ...bindings, ...patch, runtime: { ...runtime, ...runtimePatch }, player: { status: runtimePatch.status },
  }, { timeout: 1000 });
  assert.equal(changed(), false, 'same installed source and window retain the decoder');
  assert.equal(changed({ forceReload: true }), true);
  assert.equal(changed({ uri: 'file:///other.mp4' }), true);
  assert.equal(changed({ source: { id: 'other' } }), true);
  for (const windowEndMs of [undefined, null, 4000, 6000]) {
    assert.equal(changed({ windowEndMs }), true, 'a different window requires installation');
    assert.equal(changed({ windowEndMs }, { appliedWindowEndMs: windowEndMs }), false, 'equal windows retain ownership');
  }
  for (const sourceMutation of [undefined, null, Promise.resolve()]) {
    assert.equal(changed({}, { sourceMutation }), sourceMutation != null, 'pending SDK mutation requires replacement');
  }
  for (const status of ['idle', 'loading', 'readyToPlay', 'error']) for (const firstFrameReady of [false, true]) {
    assert.equal(changed({}, { status, readiness: status, firstFrameReady }), false, 'transient status does not replace a decoder');
  }

  // Follow the parent AST pattern in timeline-audio-ownership: inspect the actual
  // awaited call, then execute its small adapter against a single SDK player.
  const loads = find(source, node => ts.isCallExpression(node) && node.expression.getText(source) === 'loadPlayableVideoSource');
  assert.equal(loads.length, 1, 'one authoritative SDK loader');
  const load = loads[0];
  assert.ok(ts.isAwaitExpression(load.parent));
  assert.ok(ts.isExpressionStatement(load.parent.parent));
  const branch = load.parent.parent.parent;
  assert.ok(ts.isBlock(branch) && ts.isIfStatement(branch.parent));
  assert.equal(branch.parent.expression.getText(source), 'sourceChanged');
  assert.equal(branch.parent.thenStatement, branch, 'the SDK loader runs in the changed-source branch');
  assert.ok(find(operation, node => node === load).length === 1, 'loader belongs to the guarded preparation operation');
  assert.deepEqual(load.arguments.slice(1).map(argument => argument.getText(source)), ['uri', '15_000', 'preparation.signal']);
  assert.equal(declaration(operation, 'source').initializer.getText(source), 'sourceForEntry(entry)');
  assert.equal(declaration(operation, 'uri').initializer.getText(source), 'videoPlaybackUri(source)');
  assert.equal(declaration(operation, 'windowEndMs').initializer.getText(source), 'windowEndForEntry(entry)');
  assert.equal(declaration(operation, 'player').initializer.getText(source), 'playerForSlot(slot)');
  const adapter = load.arguments[0];
  assert.ok(ts.isConditionalExpression(adapter));
  assert.equal(adapter.condition.getText(source), "Platform.OS === 'android'");
  for (const OS of ['android', 'ios', 'web']) for (const reject of [false, true]) {
    const calls = [];
    let resolveTask, rejectTask;
    const task = new Promise((resolve, reject) => { resolveTask = resolve; rejectTask = reject; });
    const listener = () => {};
    const subscription = { remove() {} };
    const player = {
      status: 'loading',
      addListener(event, callback) { assert.equal(this, player); calls.push([event, callback]); return subscription; },
      replaceAsync(uri) { assert.equal(this, player); calls.push(uri); return task; },
    };
    const runtime = {};
    const actual = runInNewContext(`(${adapter.getText(source)})`, { Platform: { OS }, player, runtime }, { timeout: 1000 });
    if (OS !== 'android') assert.equal(actual, player, 'iOS/web receive the same SDK player directly');
    assert.equal(actual.status, 'loading'); player.status = 'readyToPlay';
    assert.equal(actual.status, 'readyToPlay', 'adapter reads live SDK status');
    assert.equal(actual.addListener('statusChange', listener), subscription);
    assert.equal(actual.replaceAsync(bindings.uri), task, 'adapter returns the SDK replacement promise');
    assert.deepEqual(calls, [['statusChange', listener], bindings.uri], 'same SDK receives the listener and authoritative URI');
    assert.equal(runtime.sourceMutation, OS === 'android' ? task : undefined);
    if (reject) rejectTask(new Error('SDK replacement failed')); else resolveTask();
    await task.catch(() => {});
    assert.equal(runtime.sourceMutation, undefined, 'settled SDK mutations clear on success and failure');
  }
});

test('preparation identities advance monotonically and reject invalid or exhausted ownership', () => {
  const controller = readFileSync(new URL('../src/hooks/use-timeline-video-controller.ts', import.meta.url), 'utf8');
  const helper = controller.match(/^function nextPrepareToken\(previous: number\) \{[\s\S]*?^\}/m);
  assert.ok(helper, 'execute the actual controller helper, without duplicating its implementation');
  const nextPrepareToken = runInNewContext(`${stripTypeScriptTypes(helper[0])}\nnextPrepareToken;`, {}, { timeout: 1_000 });

  let token = 0;
  const identities = new Set([token]);
  for (let expected = 1; expected <= 1_024; expected += 1) {
    const next = nextPrepareToken(token);
    assert.equal(next, expected);
    assert.ok(Number.isSafeInteger(next));
    assert.ok(next > token);
    assert.ok(!identities.has(next), 'retired preparation identities must never be reused');
    identities.add(next);
    token = next;
  }

  for (const [previous, expected] of [
    [2_147_483_647, 2_147_483_648],
    [4_294_967_295, 4_294_967_296],
    [Number.MAX_SAFE_INTEGER - 2, Number.MAX_SAFE_INTEGER - 1],
    [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER],
  ]) {
    assert.equal(nextPrepareToken(previous), expected);
  }

  for (const invalid of [
    -1, -Number.MAX_SAFE_INTEGER, 0.5, -0.5, NaN, Infinity, -Infinity,
    Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1,
    undefined, null, '0', true, false, {}, [], 0n, Symbol('token'),
  ]) {
    assert.throws(() => nextPrepareToken(invalid), /preparation request identity was exhausted/);
  }
});

for (const x of [-4, 4]) test(`accepted off-canvas main-video positions survive edits and draft recovery: ${x}`, () => {
  const sources = ['landscape', 'portrait'].map((id, i) => ({ id, uri: `file:///${id}.mp4`, storageMode: 'copied', displayName: `${id}.mp4`, durationMs: 8000,
    width: i ? 360 : 640, height: i ? 640 : 360, rotation: 0 }));
  let project = createCaptionProject({ id: `offcanvas-${x}`, name: 'Synthetic compatibility fixture', sources });
  const ids = project.clips.map(clip => clip.id);
  for (const id of ids) project = setVideoClipTransform(project, id, { position: { x, y: .5 } });
  const recovered = decodeVersionTwoProject(JSON.parse(serializeProjectSnapshot(project)));
  assert.deepEqual(recovered.clips.map(clip => clip.id), ids);
  assert.deepEqual(recovered.clips.map(clip => clip.transform.position), [{ x, y: .5 }, { x, y: .5 }]);
  assert.deepEqual(recovered.clips.map(clip => [clip.sourceStartMs, clip.sourceEndMs, clip.playbackRate]), [[0, 8000, 1], [0, 8000, 1]],
    'fixing preview admission must not clamp saved geometry or change the clip timeline');
});
