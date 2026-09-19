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

test('ordinary transport and transitions share exactly two bounded decoder slots', async () => {
  const [controller, overlay] = await Promise.all([
    readFile(new URL('src/hooks/use-timeline-video-controller.ts', repositoryRoot), 'utf8'),
    readFile(new URL('src/components/editor/video-transition-overlay.tsx', repositoryRoot), 'utf8'),
  ]);
  assert.equal((controller.match(/useVideoPlayer\(null, configureTimelinePlayer\)/g) ?? []).length, 2);
  assert.match(controller, /await loadPlayableVideoSource\(player, uri, 15_000, preparation\.signal\)/);
  assert.match(controller, /preloadNext\(entry, slot, timelineMs\)/);
  assert.doesNotMatch(overlay, /useVideoPlayer/);
});
