import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');

test('undo and redo reconcile every timeline selection type', () => {
  const undo = editor.slice(editor.indexOf('  const undo = () => {'), editor.indexOf('  const redo = () => {'));
  const redo = editor.slice(editor.indexOf('  const redo = () => {'), editor.indexOf('  const generateCaptions = async () => {'));
  for (const operation of [undo, redo]) {
    assert.match(operation, /setSelectedClipId/);
    assert.match(operation, /setSelectedAudioClipId/);
  }
});

test('unfinished-translation consent precedes export overlay and native work', () => {
  for (const [start, end] of [
    ['  const exportVideo = async () => {', '  const exportSubtitles = async'],
    ['  const exportSubtitles = async', '  const showExportMenu ='],
  ]) {
    const operation = editor.slice(editor.indexOf(start), editor.indexOf(end));
    assert.ok(operation.indexOf('confirmOptionalTranslationExport') < operation.indexOf('setExporting(true)'));
  }
});
