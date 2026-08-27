import { useEventListener } from 'expo';
import { useVideoPlayer } from 'expo-video';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  buildClipTimeline,
  clipPlaybackVolume,
  sourceTimeAt,
  timelineSegmentAt,
  timelineTimeAt,
  type ClipTimelineEntry,
} from '@/lib/video-timeline';
import { configureTimelinePlayer } from '@/lib/video-playback-policy';
import type { CaptionProject } from '@/types/project';

type Target = {
  generation: number;
  timelineMs: number;
};

export function useTimelineVideoController(
  project: CaptionProject,
  onError: (message: string) => void,
) {
  const entries = useMemo(() => buildClipTimeline(project.clips), [project.clips]);
  const initialEntryRef = useRef<ClipTimelineEntry | undefined>(entries[0]);
  const initialSourceRef = useRef(
    project.sources.find((source) => source.id === initialEntryRef.current?.clip.sourceId) ?? project.sources[0],
  );
  const player = useVideoPlayer(initialSourceRef.current?.uri ?? null, (instance) => {
    configureTimelinePlayer(instance);
    if (initialEntryRef.current) instance.currentTime = initialEntryRef.current.clip.sourceStartMs / 1000;
  });

  const [currentMs, setCurrentMsState] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [phase, setPhaseState] = useState<'loading' | 'ready' | 'gap' | 'ended'>(initialEntryRef.current ? 'loading' : 'ended');

  const projectRef = useRef(project);
  const entriesRef = useRef(entries);
  const currentMsRef = useRef(0);
  const playIntentRef = useRef(false);
  const nativePlayingRef = useRef(false);
  const phaseRef = useRef<'loading' | 'ready' | 'gap' | 'ended'>(initialEntryRef.current ? 'loading' : 'ended');
  const confirmedSourceIdRef = useRef<string | undefined>(initialSourceRef.current?.id);
  const activeClipIdRef = useRef<string | undefined>(initialEntryRef.current?.clip.id);
  const desiredRef = useRef<Target | undefined>(undefined);
  const processingRef = useRef<Promise<void> | undefined>(undefined);
  const drainTargetsRef = useRef<() => Promise<void>>(async () => {});
  const generationRef = useRef(0);
  const boundaryClipIdRef = useRef<string | undefined>(undefined);
  const gapFrameRef = useRef<number | undefined>(undefined);
  const internalPauseGenerationRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);
  const onErrorRef = useRef(onError);

  projectRef.current = project;
  entriesRef.current = entries;
  onErrorRef.current = onError;

  const setPhase = (next: 'loading' | 'ready' | 'gap' | 'ended') => {
    phaseRef.current = next;
    if (mountedRef.current) setPhaseState(next);
  };

  const setCurrentMs = (value: number) => {
    const duration = entriesRef.current.at(-1)?.afterGapEndMs ?? 0;
    const next = clamp(value, 0, duration);
    currentMsRef.current = next;
    if (mountedRef.current) setCurrentMsState(next);
  };

  const cancelGapClock = () => {
    if (gapFrameRef.current != null) cancelAnimationFrame(gapFrameRef.current);
    gapFrameRef.current = undefined;
  };

  const stopTransport = useCallback(() => {
    playIntentRef.current = false;
    boundaryClipIdRef.current = undefined;
    internalPauseGenerationRef.current = undefined;
    cancelGapClock();
    player.pause();
    if (mountedRef.current) setIsPlaying(false);
  }, [player]);

  const sourceForEntry = (entry: ClipTimelineEntry) => {
    const source = projectRef.current.sources.find((candidate) => candidate.id === entry.clip.sourceId);
    if (!source) throw new Error('This clip has lost its source video.');
    return source;
  };

  const runGap = (startMs: number, endMs: number, next: ClipTimelineEntry | undefined, generation: number) => {
    cancelGapClock();
    internalPauseGenerationRef.current = generation;
    player.pause();
    activeClipIdRef.current = undefined;
    boundaryClipIdRef.current = undefined;
    setPhase('gap');
    setCurrentMs(startMs);
    if (!playIntentRef.current) return;
    const startedAt = performance.now();
    const tick = (now: number) => {
      if (!playIntentRef.current || !mountedRef.current) return;
      const timelineMs = Math.min(endMs, startMs + now - startedAt);
      setCurrentMs(timelineMs);
      if (timelineMs >= endMs) {
        if (next) {
          desiredRef.current = { generation: ++generationRef.current, timelineMs: next.startMs };
          void drainTargetsRef.current();
        } else {
          stopTransport();
          setCurrentMs(endMs);
          setPhase('ended');
        }
        return;
      }
      gapFrameRef.current = requestAnimationFrame(tick);
    };
    gapFrameRef.current = requestAnimationFrame(tick);
  };

  const applyClipTarget = async (entry: ClipTimelineEntry, timelineMs: number, generation: number) => {
    cancelGapClock();
    const source = sourceForEntry(entry);
    const sourceChanged = confirmedSourceIdRef.current !== source.id;
    internalPauseGenerationRef.current = generation;
    player.pause();
    if (sourceChanged) {
      setPhase('loading');
      await player.replaceAsync(source.uri);
      if (!mountedRef.current) return;
      confirmedSourceIdRef.current = source.id;
    }
    if (generation !== generationRef.current) return;
    activeClipIdRef.current = entry.clip.id;
    boundaryClipIdRef.current = undefined;
    player.playbackRate = entry.clip.playbackRate;
    player.muted = entry.clip.muted;
    player.volume = clipPlaybackVolume(entry.clip, timelineMs - entry.startMs);
    player.currentTime = sourceTimeAt(entry, timelineMs) / 1000;
    setCurrentMs(timelineMs);
    setPhase('ready');
    if (playIntentRef.current) player.play();
  };

  async function drainTargets() {
    if (processingRef.current) return processingRef.current;
    const operation = (async () => {
      while (desiredRef.current && mountedRef.current) {
        const target = desiredRef.current;
        desiredRef.current = undefined;
        const segment = timelineSegmentAt(entriesRef.current, target.timelineMs);
        if (!segment) {
          stopTransport();
          setCurrentMs(entriesRef.current.at(-1)?.afterGapEndMs ?? 0);
          setPhase('ended');
          continue;
        }
        if (segment.kind === 'gap') {
          runGap(target.timelineMs, segment.endMs, segment.next, target.generation);
          continue;
        }
        await applyClipTarget(segment.entry, target.timelineMs, target.generation);
      }
    })().catch((error) => {
      if (!mountedRef.current) return;
      stopTransport();
      onErrorRef.current(error instanceof Error ? error.message : 'The video timeline could not be played.');
    }).finally(() => {
      processingRef.current = undefined;
      if (desiredRef.current && mountedRef.current) void drainTargetsRef.current();
    });
    processingRef.current = operation;
    return operation;
  }
  drainTargetsRef.current = drainTargets;

  const seek = useCallback((timelineMs: number) => {
    const duration = entriesRef.current.at(-1)?.afterGapEndMs ?? 0;
    const targetMs = clamp(timelineMs, 0, duration);
    setCurrentMs(targetMs);
    desiredRef.current = { generation: ++generationRef.current, timelineMs: targetMs };
    void drainTargetsRef.current();
  }, []);

  const play = useCallback(() => {
    const duration = entriesRef.current.at(-1)?.afterGapEndMs ?? 0;
    const targetMs = currentMsRef.current >= duration - 1 ? 0 : currentMsRef.current;
    playIntentRef.current = true;
    setIsPlaying(true);
    desiredRef.current = { generation: ++generationRef.current, timelineMs: targetMs };
    void drainTargetsRef.current();
  }, []);

  const pause = useCallback(() => {
    stopTransport();
    const segment = timelineSegmentAt(entriesRef.current, currentMsRef.current);
    if (segment?.kind === 'gap') setPhase('gap');
  }, [stopTransport]);

  const synchronizeProject = useCallback((nextProject: CaptionProject) => {
    projectRef.current = nextProject;
    entriesRef.current = buildClipTimeline(nextProject.clips);
    const duration = entriesRef.current.at(-1)?.afterGapEndMs ?? 0;
    const timelineMs = clamp(currentMsRef.current, 0, duration);
    setCurrentMs(timelineMs);
    desiredRef.current = { generation: ++generationRef.current, timelineMs };
    void drainTargetsRef.current();
  }, []);

  const advanceFrom = (entry: ClipTimelineEntry) => {
    if (!playIntentRef.current || boundaryClipIdRef.current === entry.clip.id) return;
    boundaryClipIdRef.current = entry.clip.id;
    const currentEntries = entriesRef.current;
    const index = currentEntries.findIndex((candidate) => candidate.clip.id === entry.clip.id);
    const next = currentEntries[index + 1];
    const gapEndMs = next?.startMs ?? entry.afterGapEndMs;
    if (gapEndMs > entry.endMs) {
      runGap(entry.endMs, gapEndMs, next, ++generationRef.current);
      return;
    }
    if (!next) {
      stopTransport();
      setCurrentMs(entry.endMs);
      setPhase('ended');
      return;
    }
    setPhase('loading');
    setCurrentMs(next.startMs);
    desiredRef.current = { generation: ++generationRef.current, timelineMs: next.startMs };
    void drainTargetsRef.current();
  };

  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    if (!playIntentRef.current || processingRef.current) return;
    const entry = entriesRef.current.find((candidate) => candidate.clip.id === activeClipIdRef.current);
    if (!entry) return;
    const sourceMs = currentTime * 1000;
    const tolerance = Math.max(4, entry.clip.playbackRate * 12);
    if (sourceMs >= entry.clip.sourceEndMs - tolerance) {
      advanceFrom(entry);
      return;
    }
    player.volume = clipPlaybackVolume(entry.clip, timelineTimeAt(entry, sourceMs) - entry.startMs);
    setCurrentMs(clamp(timelineTimeAt(entry, sourceMs), entry.startMs, entry.endMs));
  });

  useEventListener(player, 'playToEnd', () => {
    const entry = entriesRef.current.find((candidate) => candidate.clip.id === activeClipIdRef.current);
    if (entry) advanceFrom(entry);
  });

  useEventListener(player, 'playingChange', ({ isPlaying: nativePlaying }) => {
    nativePlayingRef.current = nativePlaying;
    if (nativePlaying) {
      internalPauseGenerationRef.current = undefined;
      return;
    }
    if (!playIntentRef.current || processingRef.current || phaseRef.current !== 'ready') return;
    if (internalPauseGenerationRef.current === generationRef.current) return;
    const entry = entriesRef.current.find((candidate) => candidate.clip.id === activeClipIdRef.current);
    if (entry && player.currentTime * 1000 >= entry.clip.sourceEndMs - 200) {
      advanceFrom(entry);
      return;
    }
    stopTransport();
  });

  useEventListener(player, 'statusChange', ({ status, error }) => {
    if (status === 'error') {
      stopTransport();
      onErrorRef.current(error?.message ?? 'The current video could not be decoded.');
    }
  });

  useEffect(() => {
    mountedRef.current = true;
    desiredRef.current = { generation: ++generationRef.current, timelineMs: 0 };
    void drainTargetsRef.current();
    return () => {
      mountedRef.current = false;
      playIntentRef.current = false;
      desiredRef.current = undefined;
      generationRef.current += 1;
      boundaryClipIdRef.current = undefined;
      cancelGapClock();
    };
  }, [player]);

  return {
    player,
    currentMs,
    isPlaying,
    phase,
    isGap: phase === 'gap',
    seek,
    play,
    pause,
    synchronizeProject,
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
