import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const repositoryRoot = new URL('../', import.meta.url);

test('caption generation consumes the audible timeline and restores real project media ownership', async () => {
  const [orchestrator, renderer, moduleSource, moduleType] = await Promise.all([
    readFile(new URL('src/services/project-transcription.ts', repositoryRoot), 'utf8'),
    readFile(new URL('src/services/timeline-audio-render.ts', repositoryRoot), 'utf8'),
    readFile(new URL('modules/caption-media/android/src/main/java/app/captionstudio/media/CaptionMediaModule.kt', repositoryRoot), 'utf8'),
    readFile(new URL('modules/caption-media/src/CaptionMediaModule.ts', repositoryRoot), 'utf8'),
  ]);
  assert.match(orchestrator, /createTimelineTranscriptionSession/);
  assert.match(orchestrator, /timelineSession\.restore/);
  assert.match(renderer, /sourceStartMs: entry\.startMs/);
  assert.match(renderer, /sourceEndMs: entry\.endMs/);
  assert.match(renderer, /restoreTimelineTranscription\(project, generated\)/);
  assert.match(moduleSource, /AsyncFunction\("renderTimelineAudio"\)/);
  assert.match(moduleType, /renderTimelineAudio\(outputUri:/);
  assert.match(moduleSource, /TimelineAudioRenderer\.cancel\(\)/);
});

test('ordinary transport and transitions share exactly two bounded decoder slots', async () => {
  const [controller, overlay] = await Promise.all([
    readFile(new URL('src/hooks/use-timeline-video-controller.ts', repositoryRoot), 'utf8'),
    readFile(new URL('src/components/editor/video-transition-overlay.tsx', repositoryRoot), 'utf8'),
  ]);
  assert.equal((controller.match(/useVideoPlayer\(null, configureTimelinePlayer\)/g) ?? []).length, 2);
  const source = ts.createSourceFile('controller.ts', controller, ts.ScriptTarget.Latest, true);
  const loads = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'loadPlayableVideoSource') loads.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(loads.length, 1, 'one authoritative SDK loader');
  const load = loads[0];
  assert.ok(ts.isAwaitExpression(load.parent), 'preparation must await the SDK loader');
  assert.deepEqual(load.arguments.slice(1).map(argument => argument.getText(source)), ['uri', '15_000', 'preparation.signal']);
  const adapter = load.arguments[0];
  assert.ok(ts.isConditionalExpression(adapter), 'Android tracks the same SDK player replacement');
  assert.equal(adapter.condition.getText(source), "Platform.OS === 'android'");
  assert.equal(adapter.whenFalse.getText(source), 'player', 'other platforms retain their direct SDK player');
  assert.ok(ts.isObjectLiteralExpression(adapter.whenTrue));
  const properties = new Map(adapter.whenTrue.properties.map(property => [property.name.getText(source), property]));
  assert.equal(properties.get('status').body.statements[0].expression.getText(source), 'player.status');
  assert.equal(properties.get('addListener').initializer.body.expression.getText(source), 'player.addListener');
  const replacements = [];
  function visitReplacement(node) {
    if (ts.isCallExpression(node)) replacements.push(node.expression.getText(source));
    ts.forEachChild(node, visitReplacement);
  }
  visitReplacement(properties.get('replaceAsync'));
  assert.ok(replacements.includes('player.replaceAsync'), 'tracking must forward replacement to the SDK');
  assert.match(controller, /preloadNext\(entry, slot, timelineMs\)/);
  assert.doesNotMatch(overlay, /useVideoPlayer/);
});
