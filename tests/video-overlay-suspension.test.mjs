import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/components/editor/video-layer-overlay.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  target: ts.ScriptTarget.ES2022, esModuleInterop: true,
} }).outputText;

test('translation preview suspension unmounts the overlay player and restores it afterward', () => {
  let playerMounts = 0;
  const exports = {};
  vm.runInNewContext(code, { exports, require: (id) => {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return require('react/jsx-runtime');
    if (id === 'react-native') return { View: ({ children }) => React.createElement('div', null, children) };
    if (id === 'expo-video') return { VideoView: () => React.createElement('video'), useVideoPlayer: () => {
      playerMounts++;
      return { currentTime: 0, play() {}, pause() {} };
    } };
    if (id === '@/lib/layer-geometry') return { resolveLayerGeometry: () => ({
      position: { x: 0.5, y: 0.5 }, box: { width: 0.5, height: 0.5 },
      rotation: 0, scale: 1, scaleX: 1, scaleY: 1,
    }) };
    if (id === '@/lib/video-overlay-playback') return { overlayPlaybackState: () => ({
      visible: true, seconds: 1, playing: false,
    }) };
    throw new Error(`Unexpected dependency: ${id}`);
  } });
  const layer = { id: 'pip', uri: 'file:///pip.mp4', startMs: 0, endMs: 3000,
    sourceStartMs: 0, playbackRate: 1, includeAudio: true, opacity: 1 };
  const render = (suspended) => renderToStaticMarkup(React.createElement(exports.VideoLayerOverlay,
    { layer, timelineMs: 1000, isPlaying: false, suspended }));
  assert.equal(render(true), '');
  assert.equal(playerMounts, 0);
  assert.match(render(false), /<video/);
  assert.equal(playerMounts, 1);
  assert.equal(render(true), '');
  assert.equal(playerMounts, 1);
});
