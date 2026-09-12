import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const scriptEditor = readFileSync(
  new URL('../src/components/editor/script-editor.tsx', import.meta.url),
  'utf8',
);
const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');

test('caption script editor stays in the editor and synchronizes to the timeline transport', () => {
  assert.doesNotMatch(scriptEditor, /<Modal/);
  assert.match(scriptEditor, /position: 'absolute'/);
  assert.match(scriptEditor, /height: '50%'/);
  assert.match(scriptEditor, /currentMs: number/);
  assert.match(scriptEditor, /onSeekTimeline: \(timelineMs: number\) => void/);
  assert.match(scriptEditor, /onScroll=\{\(event\) => seekToCenteredCaption/);
  assert.match(scriptEditor, /scrollToIndex\(\{ index, animated: true, viewPosition: 0\.5 \}\)/);
  assert.match(scriptEditor, /backgroundColor: '#B7FF4A'/);
  assert.match(editor, /currentMs=\{currentMs\}/);
  assert.match(editor, /onSeekTimeline=\{seekTimeline\}/);
});
