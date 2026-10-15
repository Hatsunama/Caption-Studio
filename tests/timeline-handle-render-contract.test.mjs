import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as geometry from '../src/lib/timeline-handle-layout.ts';

// Execute the real component bodies with inert JSX/hooks. This checks rendered
// geometry without loading React Native or exercising gesture state machines.
const source = readFileSync(new URL('../src/components/editor/layer-timeline.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('layer-timeline.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['TimedBlock', 'DirectTimelineGestureSurface', 'VideoClipBlock', 'VideoMoveGrip'];
const declarations = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
assert.equal(declarations.length, names.length);
const jsxNames = new Set();
function visit(node) {
  if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName)) {
    jsxNames.add(node.tagName.text);
  }
  ts.forEachChild(node, visit);
}
declarations.forEach(visit);
const code = ts.transpileModule(declarations.map((node) => node.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'Fragment' },
}).outputText;
const components = vm.runInNewContext(`${code}\n({ ${names.join(', ')} })`, {
  ...Object.fromEntries([...jsxNames].map((name) => [name, name])),
  ...geometry,
  h: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) }),
  Fragment: 'Fragment',
  LANE_HEIGHT: 32,
  TIMELINE_EDGE_HANDLE_WIDTH: 24,
  REORDER_TILE: 64,
  REORDER_GAP: 4,
  chrome: { radius: { sm: 6 }, accent: '#fff' },
  useState: (initial) => [typeof initial === 'function' ? initial() : initial],
  useRef: (current) => ({ current }),
  useContext: () => null,
  useCallback: (callback) => callback,
  useEffect: () => {},
  TimelineGestureGeometryContext: {},
  createTimelineBoundaryFeedback: () => ({}),
  PanResponder: { create: (callbacks) => ({ panHandlers: callbacks }) },
});
function find(tree, name) {
  if (tree && (tree.type === name || tree.type?.name === name)) return tree;
  for (const child of tree?.children ?? []) {
    const found = find(child, name);
    if (found) return found;
  }
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const base = { selected: true, durationMs: 60_000, trackWidth: 960, lane: 0, color: '#123456', label: 'clip', clip: {} };

test('TimedBlock renders complete selected shells at both track bounds', () => {
  for (const width of [1.92, 7.99, 32]) {
    for (const left of [0, 960 - width]) {
      const tree = components.TimedBlock({ ...base, startMs: left / 960 * 60_000, endMs: (left + width) / 960 * 60_000 });
      const style = tree.props.style;
      const expected = geometry.timelineHandleHitLayout(true, width);
      close(style.left, left + expected.envelope.left);
      close(style.width, expected.envelope.width);
      const artwork = tree.children[0];
      close(style.left + artwork.props.style.left, left);
      close(artwork.props.style.width, width);
      const surface = find(tree, 'DirectTimelineGestureSurface');
      const rendered = components.DirectTimelineGestureSurface(surface.props);
      const grips = rendered.children.filter((child) => child.type === 'TimelineTimingGrip');
      assert.equal(grips.length, 3);
      const start = grips.find((child) => child.props.edge === 'start').props;
      const move = grips.find((child) => child.props.edge === 'move').props;
      const end = grips.find((child) => child.props.edge === 'end').props;
      assert.equal(start.width, 24);
      assert.equal(end.width, 24);
      assert.ok(move.width >= 8);
      assert.equal(start.left, 0);
      assert.equal(start.left + start.width, move.left);
      assert.equal(move.left + move.width, end.left);
      close(end.left + end.width, style.width);
    }
  }
});

test('VideoMoveGrip renders the authoritative move rectangle passed by VideoClipBlock', () => {
  for (const width of [2, 7.99, 32, 240]) {
    for (const left of [0, 960 - width]) {
      const props = { ...base, startMs: left / 960 * 60_000, endMs: (left + width + 2) / 960 * 60_000 };
      const tree = components.VideoClipBlock(props);
      const actualWidth = tree.children[0].props.style.width;
      const expected = geometry.timelineVideoHandleLayout(left, actualWidth, 960, true);
      const child = find(tree, 'VideoMoveGrip');
      const move = components.VideoMoveGrip(child.props).props.style;
      close(move.left, expected.moveLeft);
      close(move.width, expected.moveWidth);
      close(tree.props.style.left + tree.children[0].props.style.left, left);
      close(tree.props.style.width, expected.width);
    }
  }
});

test('selected shells contain the complete vertical markers without moving artwork', () => {
  const tree = components.TimedBlock({ ...base, lane: 2, startMs: 1000, endMs: 2000 });
  assert.equal(tree.props.style.top, 2 * 32 - 3);
  assert.equal(tree.props.style.height, 38);
  assert.equal(tree.props.style.top + tree.children[0].props.style.top, 2 * 32);
  const surface = find(tree, 'DirectTimelineGestureSurface');
  const rendered = components.DirectTimelineGestureSurface(surface.props);
  assert.equal(rendered.props.style.height, 38);
  for (const grip of rendered.children.filter((child) => child.type === 'TimelineTimingGrip')) assert.equal(grip.props.height, 38);
  const video = components.VideoClipBlock({ ...base, startMs: 1000, endMs: 2000 });
  assert.equal(video.props.style.top, 0);
  assert.equal(video.props.style.bottom, 0);
  assert.equal(video.children[0].props.style.top, 3);
  assert.equal(video.children[0].props.style.bottom, 3);
});
