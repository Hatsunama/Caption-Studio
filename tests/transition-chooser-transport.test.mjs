import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { setVideoTransition } from '../src/lib/project-editor.ts';
import { buildClipTimeline } from '../src/lib/video-timeline.ts';
import { VIDEO_TRANSITION_PRESETS } from '../src/lib/video-transitions.ts';
import {
  buildVideoTransitionPreviewWindows,
  videoTransitionCompositeState,
  videoTransitionPreviewFrameAt,
} from '../src/lib/video-transition-preview.ts';
import { harness } from './transition-controller-host.mjs';

// Extract the UI's actual closure, including any future transport repair. Do not
// copy its implementation or replace synchronizeProject with a call-count spy.
const editor = ts.createSourceFile('editor.tsx',
  readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(editor);
const declaration = nodes.find(node => ts.isVariableDeclaration(node)
  && ts.isIdentifier(node.name) && node.name.text === 'applyTransition');
assert.ok(declaration?.initializer, 'actual editor applyTransition declaration is required');
const presetMap = nodes.find(node => ts.isCallExpression(node)
  && node.expression.getText(editor) === 'VIDEO_TRANSITION_PRESETS.map');
assert.ok(presetMap, 'actual transition chooser buttons are required');
const timingSheet = nodes.find(node => ts.isJsxSelfClosingElement(node)
  && node.tagName.getText(editor) === 'TransitionTimingSheet');
const timingChoice = timingSheet?.attributes.properties.find(node =>
  ts.isJsxAttribute(node) && node.name.getText(editor) === 'onChoose');
assert.ok(timingChoice?.initializer?.expression, 'actual timing-sheet callback is required');
function evaluate(expression, bindings) {
  const code = ts.transpileModule(`(${expression.getText(editor)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  return runInNewContext(code, bindings);
}
const snapshot = value => JSON.parse(JSON.stringify(value));
const clip = (id, sourceId) => ({
  id, sourceId, sourceStartMs: 1000, sourceEndMs: 5000,
  availableSourceStartMs: 0, availableSourceEndMs: 8000,
  gapBeforeMs: 0, gapAfterMs: 0, playbackRate: 1,
  muted: false, volume: .8, fadeInMs: 0, fadeOutMs: 0,
  transform: { position: { x: .5, y: .5 }, scale: 1, rotation: 0, fit: 'fit' },
  transitionAfter: { type: 'none', durationMs: 0 },
});
function fixture(initialDurationMs = 0) {
  const clips = [clip('out', 'source'), clip('in', 'other')];
  if (initialDurationMs) clips[0].transitionAfter = { type: 'crossfade', durationMs: initialDurationMs };
  const h = harness({ clips, sourceDurationMs: 8000 });
  let current = { ...h.project };
  let pending;
  const undo = [], persisted = [], commits = [], timingOpen = [];
  const bindings = {
    selectedClipId: 'out', selectedClip: current.clips[0],
    editorSession: { current: () => current },
    pushUndo: () => undo.push(snapshot(current)),
    setVideoTransition,
    get transport() { return h.transport; },
    setProject(next) { current = next; pending = next; commits.push(next); },
    persistProjectInBackground: () => persisted.push(snapshot(current)),
    setTransitionTimingOpen: value => timingOpen.push(value),
    transitionBoundaryAvailable: true, VIDEO_TRANSITION_PRESETS,
    chrome: { accent: 'accent' }, Action: 'Action',
    React: { createElement: (type, props) => ({ type, props }) },
  };
  const applyTransition = evaluate(declaration.initializer, bindings);
  bindings.applyTransition = applyTransition;
  return {
    h, bindings, applyTransition, undo, persisted, commits, timingOpen,
    get current() { return current; },
    buttons() { bindings.selectedClip = current.clips[0]; return evaluate(presetMap, bindings); },
    chooseDuration(ms) {
      bindings.selectedClip = current.clips[0];
      evaluate(timingChoice.initializer.expression, bindings)(ms);
    },
    async commit() {
      assert.ok(pending, 'the real handler must publish a project update');
      // Existing host captures its project container. Publish the exact domain
      // result's fields into that container, then render: new clips/sources feed
      // the real hook memo/layout effects and overlay. No readiness/slot writes,
      // seek, AppState cycle, or synthetic synchronization at the React seam.
      Object.assign(h.project, pending);
      pending = undefined;
      h.render();
      await h.complete();
    },
  };
}
const visibleClipIds = h => h.views
  .filter(view => view.ancestors.every(style => style.opacity !== 0))
  .map(view => h.transport.slots[h.players.indexOf(view.player)].preparedClipId).sort();
function frameAt(project, timelineMs) {
  return videoTransitionPreviewFrameAt(
    buildVideoTransitionPreviewWindows(buildClipTimeline(project.clips), project.sources), timelineMs);
}
function assertPaused(h) {
  assert.equal(h.transport.currentMs, 4250, 'chooser preserves the logical playhead');
  assert.equal(h.transport.isPlaying, false, 'chooser preserves pause intent');
  assert.equal(h.transport.phase, 'ready');
  assert.ok(h.players.every(player => !player.playing), 'paused decoders must not play; ordinary activation may retain clip volume settings');
}
function assertEdit(f, before, type, durationMs) {
  assert.equal(f.commits.length, 1);
  assert.deepEqual(f.undo, [before], 'one pre-edit undo snapshot');
  assert.deepEqual(f.persisted, [snapshot(f.current)], 'one persistence request with the domain result');
  assert.deepEqual(snapshot(f.current.clips[0].transitionAfter), { type, durationMs });
  assert.deepEqual(snapshot(f.current.clips[1]), before.clips[1]);
  assert.deepEqual(snapshot(f.current.sources), before.sources);
}
function assertCrossReady(f) {
  const { h } = f;
  assertPaused(h);
  const frame = frameAt(f.current, 4250);
  assert.ok(frame && frame.mode === 'composite');
  assert.equal(frame.startMs, 3500);
  assert.equal(frame.endMs, 4500);
  // This is the production predicate used to select the Waiting notice, with
  // actual controller slots; visibility independently checks the rendered pair.
  const state = videoTransitionCompositeState(frame, h.transport.slots);
  assert.equal(state.status, 'ready', 'chooser must prepare both legs instead of Waiting for video frames');
  assert.deepEqual(visibleClipIds(h), ['in', 'out']);
  for (const [id, sourceMs, uri] of [
    ['out', 5250, 'file:///source.mp4'], ['in', 1250, 'file:///other.mp4'],
  ]) {
    const slot = Array.from(h.transport.slots).findIndex(value => value.preparedClipId === id);
    assert.notEqual(slot, -1, `${id} must own a prepared slot`);
    assert.equal(h.transport.slots[slot].readiness, 'ready');
    assert.equal(h.transport.slots[slot].firstFrameReady, true);
    assert.equal(h.players[slot].loadedUri, uri);
    assert.ok(Math.abs(h.players[slot].currentTime * 1000 - sourceMs) < .001,
      `${id} must show the composite source frame at ${sourceMs}ms`);
  }
}

for (const initialDurationMs of [0, 350]) test(
  `actual chooser ${initialDurationMs ? 'extends Cross 350 to 1000' : 'selects Cross 1000 from clean cut'} at paused 4250 prepares both source frames`,
  async () => {
    const f = fixture(initialDurationMs);
    try {
      await f.h.complete();
      f.h.transport.seek(4250); await f.h.complete();
      assertPaused(f.h);
      assert.deepEqual(visibleClipIds(f.h), ['in']);
      assert.equal(frameAt(f.current, 4250), undefined,
        '4250 is ordinary initially (the 350ms window ends at 4175)');
      const before = snapshot(f.current);
      const chooserCalls = f.h.calls.length;
      if (initialDurationMs) {
        f.chooseDuration(1000); // Actual timing-sheet onChoose -> actual handler.
        assert.deepEqual(f.timingOpen, [false]);
      } else {
        f.applyTransition('crossfade', 1000);
      }
      await f.commit();
      assertEdit(f, before, 'crossfade', 1000);
      assert.deepEqual(f.h.calls.slice(chooserCalls).filter(call => call[0] === 'play' && call[2] === false), [],
        'choosing a transition while paused must not request audible playback');
      assertCrossReady(f);
    } finally { f.h.unmount(); }
  });

test('actual chooser buttons retain labels, selection, clean-cut persistence and boundary disabling', async () => {
  const f = fixture(1000);
  try {
    await f.h.complete();
    f.h.transport.seek(4250); await f.h.complete();
    const buttons = Array.from(f.buttons());
    assert.deepEqual(buttons.map(button => button.props.label), VIDEO_TRANSITION_PRESETS.map(preset => preset.name));
    assert.equal(buttons.find(button => button.props.label === 'Cross dissolve').props.color, 'accent');
    assert.ok(buttons.every(button => button.props.disabled === false));
    f.bindings.transitionBoundaryAvailable = false;
    const disabled = Array.from(f.buttons());
    assert.equal(disabled[0].props.label, 'Clean cut');
    assert.equal(disabled[0].props.disabled, false);
    assert.ok(disabled.slice(1).every(button => button.props.disabled === true));
    const before = snapshot(f.current);
    buttons[0].props.onPress(); // Execute the actual preset button callback.
    await f.commit();
    assertEdit(f, before, 'none', 0);
    assertPaused(f.h);
    assert.equal(frameAt(f.current, 4250), undefined);
    assert.deepEqual(visibleClipIds(f.h), ['in']);
    assert.equal(f.buttons()[0].props.color, 'accent');
  } finally { f.h.unmount(); }
});

test('actual chooser with no selected clip makes no edit, undo or persistence request', () => {
  const f = fixture();
  try {
    f.bindings.selectedClipId = undefined;
    f.applyTransition('crossfade', 1000);
    assert.deepEqual(f.commits, []);
    assert.deepEqual(f.undo, []);
    assert.deepEqual(f.persisted, []);
  } finally { f.h.unmount(); }
});
