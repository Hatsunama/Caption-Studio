import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const repositoryRoot = new URL('../', import.meta.url);

test('caption generation consumes the audible timeline and restores real project media ownership', async () => {
  const [orchestrator, renderer, moduleSource] = await Promise.all([
    readFile(new URL('src/services/project-transcription.ts', repositoryRoot), 'utf8'),
    readFile(new URL('src/services/timeline-audio-render.ts', repositoryRoot), 'utf8'),
    readFile(new URL('modules/caption-media/android/src/main/java/app/captionstudio/media/CaptionMediaModule.kt', repositoryRoot), 'utf8'),
  ]);
  assert.match(orchestrator, /createTimelineTranscriptionSession/);
  assert.match(orchestrator, /timelineSession\.restore/);
  assert.match(renderer, /sourceStartMs: entry\.startMs/);
  assert.match(renderer, /sourceEndMs: entry\.endMs/);
  assert.match(renderer, /restoreTimelineTranscription\(project, generated\)/);
  assert.match(moduleSource, /AsyncFunction\("renderTimelineAudio"\)/);
  assert.match(moduleSource, /TimelineAudioRenderer\.cancel\(\)/);
});

test('ordinary transport operations invalidate and pause stale standby media without reloading it', async () => {
  const controller = await readFile(new URL('src/hooks/use-timeline-video-controller.ts', repositoryRoot), 'utf8');
  assert.doesNotMatch(controller, /replaceAsync\(null\)/);
  assert.match(controller, /const invalidateStandbyPrime = useCallback/);
  assert.match(controller, /players\[oppositeTimelineSlot\(activeSlotRef\.current\)\]\.pause\(\)/);
  assert.doesNotMatch(controller, /^\s*setPhase\('loading'\);$/m);
});
