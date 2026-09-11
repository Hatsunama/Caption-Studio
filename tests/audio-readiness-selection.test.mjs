import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
const timeline = readFileSync(new URL('../src/components/editor/layer-timeline.tsx', import.meta.url), 'utf8');
const workflows = readFileSync(new URL('../src/services/project-workflows.ts', import.meta.url), 'utf8');

test('new audio is waveform-ready before the project transaction publishes it', () => {
  assert.match(workflows, /prepareTimelineAudioSource[\s\S]*generateAudioWaveformPeaks/);
  assert.match(workflows, /waveformPeaks, waveformVersion: AUDIO_WAVEFORM_VERSION/);
  assert.ok(workflows.indexOf('source = await prepareTimelineAudioSource(importedSource)') < workflows.indexOf('addAudioSourceToProject(\n    project,\n    source,'));
  assert.ok(workflows.indexOf('source = await prepareTimelineAudioSource(extractedSource)') < workflows.lastIndexOf('addAudioSourceToProject(\n    project,\n    source,'));
  assert.match(editor, /Extracting, validating, and building the waveform[\s\S]*Playback starts when the audio is ready/);
});

test('empty preview and timeline surfaces clear every editor selection', () => {
  assert.match(editor, /const clearEditorSelection = \(\) => \{[\s\S]*setSelectedCaptionId\(undefined\)[\s\S]*setSelectedLayerId\(undefined\)[\s\S]*setSelectedClipId\(undefined\)[\s\S]*setSelectedAudioClipId\(undefined\)/);
  assert.match(editor, /accessibilityLabel="Clear editor selection"[\s\S]*onPress=\{clearEditorSelection\}/);
  assert.match(timeline, /onClearSelection: \(\) => void/);
  assert.match(timeline, /onPressTrack=\{\(x\) => \{ props\.onClearSelection\(\); props\.onSeek/);
  assert.match(timeline, /accessibilityLabel="Clear selection and seek timeline"/);
});
