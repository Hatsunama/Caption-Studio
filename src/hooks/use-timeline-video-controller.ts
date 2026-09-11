import { useEventListener } from 'expo';
import { useVideoPlayer, type VideoPlayer } from 'expo-video';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  buildClipTimeline,
  clipPlaybackVolume,
  sourceTimeAt,
  timelineSegmentAt,
  timelineTimeAt,
  type ClipTimelineEntry,
} from '@/lib/video-timeline';
import {
  CLIP_HANDOFF_BOUNDARY_TOLERANCE_MS,
  canContinueTimelineClip,
  canSeamlessSwapToClip,
  clipHandoffPrimeAt,
  oppositeTimelineSlot,
  type TimelinePlayerSlot,
} from '@/lib/video-playback-policy';
import { configureTimelinePlayer } from '@/services/video-player-runtime';
import type { CaptionProject } from '@/types/project';

type Target = {
  generation: number;
  timelineMs: number;
};

type PrimedStandby = {
  clipId: string;
  sourceId: string;
  sourceUri: string;
};

export function useTimelineVideoController(
  project: CaptionProject,
  onError: (message: string) => void,
) {
  const entries = useMemo(() => buildClipTimeline(project.clips), [project.clips]);
  const initialEntry = entries[0];
  const initialSource = project.sources.find((source) => source.id === initialEntry?.clip.sourceId) ?? project.sources[0];
  const playerA = useVideoPlayer(initialSource?.uri ?? null, (instance) => {
    configureTimelinePlayer(instance);
    if (initialEntry) instance.currentTime = initialEntry.clip.sourceStartMs / 1000;
  });
  const playerB = useVideoPlayer(null, configureTimelinePlayer);
  const players = useMemo(() => [playerA, playerB] as const, [playerA, playerB]);

  const [activeSlot, setActiveSlotState] = useState<TimelinePlayerSlot>(0);
  const [currentMs, setCurrentMsState] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [phase, setPhaseState] = useState<'loading' | 'ready' | 'gap' | 'ended'>(initialEntry ? 'loading' : 'ended');

  const projectRef = useRef(project);
  const entriesRef = useRef(entries);
  const currentMsRef = useRef(0);
  const playIntentRef = useRef(false);
  const phaseRef = useRef<'loading' | 'ready' | 'gap' | 'ended'>(initialEntry ? 'loading' : 'ended');
  const activeSlotRef = useRef<TimelinePlayerSlot>(0);
  const confirmedSourceIdRef = useRef<string | undefined>(initialSource?.id);
  const activeClipIdRef = useRef<string | undefined>(initialEntry?.clip.id);
  const primedRef = useRef<PrimedStandby | undefined>(undefined);
  const primingRef = useRef<Promise<void> | undefined>(undefined);
  const desiredRef = useRef<Target | undefined>(undefined);
  const processingRef = useRef<Promise<void> | undefined>(undefined);
  const drainTargetsRef = useRef<() => Promise<void>>(async () => {});
  const generationRef = useRef(0);
  const boundaryClipIdRef = useRef<string | undefined>(undefined);
  const gapFrameRef = useRef<number | undefined>(undefined);
  const internalPauseGenerationRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);
  const onErrorRef = useRef(onError);

  useLayoutEffect(() => {
    projectRef.current = project;
    entriesRef.current = entries;
    onErrorRef.current = onError;
  }, [entries, onError, project]);

  const setPhase = (next: 'loading' | 'ready' | 'gap' | 'ended') => {
    phaseRef.current = next;
    if (mountedRef.current) setPhaseState(next);
  };

  const setActiveSlot = (slot: TimelinePlayerSlot) => {
    activeSlotRef.current = slot;
    if (mountedRef.current) setActiveSlotState(slot);
  };

  const setCurrentMs = (value: number) => {
    const duration = entriesRef.current.at(-1)?.afterGapEndMs ?? 0;
    const next = clamp(value, 0, duration);
    currentMsRef.current = next;
    if (mountedRef.current) setCurrentMsState(next);
  };

  const activePlayer = () => players[activeSlotRef.current];
  const standbyPlayer = () => players[oppositeTimelineSlot(activeSlotRef.current)];

  const cancelGapClock = () => {
    if (gapFrameRef.current != null) cancelAnimationFrame(gapFrameRef.current);
    gapFrameRef.current = undefined;
  };

  const clearStandbyPrime = () => {
    primedRef.current = undefined;
  };

  const invalidateStandbyPrime = useCallback(() => {
    primedRef.current = undefined;
    players[oppositeTimelineSlot(activeSlotRef.current)].pause();
  }, [players]);

  const stopTransport = useCallback(() => {
    playIntentRef.current = false;
    boundaryClipIdRef.current = undefined;
    internalPauseGenerationRef.current = undefined;
    cancelGapClock();
    clearStandbyPrime();
    players[0].pause();
    players[1].pause();
    const standby = players[oppositeTimelineSlot(activeSlotRef.current)];
    standby.pause();
    if (mountedRef.current) setIsPlaying(false);
  }, [players]);

  const sourceForEntry = (entry: ClipTimelineEntry) => {
    const source = projectRef.current.sources.find((candidate) => candidate.id === entry.clip.sourceId);
    if (!source) throw new Error('This clip has lost its source video.');
    return source;
  };

  const applyClipToPlayer = (player: VideoPlayer, entry: ClipTimelineEntry, timelineMs: number) => {
    player.playbackRate = entry.clip.playbackRate;
    player.muted = entry.clip.muted;
    player.volume = clipPlaybackVolume(entry.clip, timelineMs - entry.startMs);
    player.currentTime = sourceTimeAt(entry, timelineMs) / 1000;
  };

  const runGap = (startMs: number, endMs: number, next: ClipTimelineEntry | undefined, generation: number) => {
    cancelGapClock();
    internalPauseGenerationRef.current = generation;
    players[0].pause();
    players[1].pause();
    activeClipIdRef.current = undefined;
    boundaryClipIdRef.current = undefined;
    clearStandbyPrime();
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

  const primeStandby = async (entry: ClipTimelineEntry) => {
    const source = sourceForEntry(entry);
    if (
      primedRef.current?.clipId === entry.clip.id
      && primedRef.current.sourceId === source.id
    ) return;
    const generation = generationRef.current;
    const standby = standbyPlayer();
    standby.pause();
    await standby.replaceAsync(source.uri);
    if (!mountedRef.current || generation !== generationRef.current) return;
    applyClipToPlayer(standby, entry, entry.startMs);
    standby.pause();
    primedRef.current = { clipId: entry.clip.id, sourceId: source.id, sourceUri: source.uri };
  };

  const schedulePrime = (entry: ClipTimelineEntry) => {
    if (primingRef.current) return;
    const operation = primeStandby(entry)
      .catch((error) => {
        if (!mountedRef.current) return;
        clearStandbyPrime();
        onErrorRef.current(error instanceof Error ? error.message : 'The next video clip could not be prepared.');
      })
      .finally(() => {
        primingRef.current = undefined;
      });
    primingRef.current = operation;
  };

  const swapToStandby = (entry: ClipTimelineEntry, timelineMs: number, generation: number) => {
    const standby = standbyPlayer();
    const outgoing = activePlayer();
    applyClipToPlayer(standby, entry, timelineMs);
    internalPauseGenerationRef.current = generation;
    outgoing.pause();
    setActiveSlot(oppositeTimelineSlot(activeSlotRef.current));
    confirmedSourceIdRef.current = sourceForEntry(entry).id;
    activeClipIdRef.current = entry.clip.id;
    boundaryClipIdRef.current = undefined;
    clearStandbyPrime();
    setCurrentMs(timelineMs);
    setPhase('ready');
    if (playIntentRef.current) standby.play();
  };

  const applyClipTarget = async (entry: ClipTimelineEntry, timelineMs: number, generation: number) => {
    cancelGapClock();
    const source = sourceForEntry(entry);
    const seamless = canSeamlessSwapToClip({
      primedClipId: primedRef.current?.clipId,
      primedSourceId: primedRef.current?.sourceId,
      targetClipId: entry.clip.id,
      targetSourceId: source.id,
    });
    if (seamless) {
      swapToStandby(entry, timelineMs, generation);
      return;
    }

    const player = activePlayer();
    const sourceChanged = confirmedSourceIdRef.current !== source.id;
    internalPauseGenerationRef.current = generation;
    player.pause();
    standbyPlayer().pause();
    if (sourceChanged) {
      clearStandbyPrime();
      await player.replaceAsync(source.uri);
      if (!mountedRef.current) return;
      confirmedSourceIdRef.current = source.id;
    }
    if (generation !== generationRef.current) return;
    activeClipIdRef.current = entry.clip.id;
    boundaryClipIdRef.current = undefined;
    applyClipToPlayer(player, entry, timelineMs);
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

  useLayoutEffect(() => {
    drainTargetsRef.current = drainTargets;
  });

  const seek = useCallback((timelineMs: number) => {
    const duration = entriesRef.current.at(-1)?.afterGapEndMs ?? 0;
    const targetMs = clamp(timelineMs, 0, duration);
    setCurrentMs(targetMs);
    invalidateStandbyPrime();
    desiredRef.current = { generation: ++generationRef.current, timelineMs: targetMs };
    void drainTargetsRef.current();
  }, [invalidateStandbyPrime]);

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
    invalidateStandbyPrime();
    desiredRef.current = { generation: ++generationRef.current, timelineMs };
    void drainTargetsRef.current();
  }, [invalidateStandbyPrime]);

  const advanceFrom = (entry: ClipTimelineEntry) => {
    if (!playIntentRef.current || boundaryClipIdRef.current === entry.clip.id) return;
    boundaryClipIdRef.current = entry.clip.id;
    const currentEntries = entriesRef.current;
    const index = currentEntries.findIndex((candidate) => candidate.clip.id === entry.clip.id);
    const next = currentEntries[index + 1];
    const gapEndMs = next?.startMs ?? entry.afterGapEndMs;
    if (gapEndMs > entry.endMs + CLIP_HANDOFF_BOUNDARY_TOLERANCE_MS) {
      runGap(entry.endMs, gapEndMs, next, ++generationRef.current);
      return;
    }
    if (!next) {
      stopTransport();
      setCurrentMs(entry.endMs);
      setPhase('ended');
      return;
    }
    if (canContinueTimelineClip(entry, next)) {
      const player = activePlayer();
      activeClipIdRef.current = next.clip.id;
      confirmedSourceIdRef.current = next.clip.sourceId;
      boundaryClipIdRef.current = undefined;
      clearStandbyPrime();
      player.playbackRate = next.clip.playbackRate;
      player.muted = next.clip.muted;
      player.volume = clipPlaybackVolume(next.clip, 0);
      setCurrentMs(next.startMs);
      setPhase('ready');
      return;
    }
    setCurrentMs(next.startMs);
    desiredRef.current = { generation: ++generationRef.current, timelineMs: next.startMs };
    void drainTargetsRef.current();
  };

  const onActiveTimeUpdate = (player: VideoPlayer, currentTime: number) => {
    if (player !== activePlayer()) return;
    if (!playIntentRef.current || processingRef.current) return;
    const entry = entriesRef.current.find((candidate) => candidate.clip.id === activeClipIdRef.current);
    if (!entry) return;
    const sourceMs = currentTime * 1000;
    const tolerance = Math.max(4, entry.clip.playbackRate * 12);
    const timelineMs = clamp(timelineTimeAt(entry, sourceMs), entry.startMs, entry.endMs);
    setCurrentMs(timelineMs);
    player.volume = clipPlaybackVolume(entry.clip, timelineMs - entry.startMs);

    const prime = clipHandoffPrimeAt(
      entriesRef.current,
      entry.clip.id,
      timelineMs,
      playIntentRef.current,
    );
    if (prime && primedRef.current?.clipId !== prime.next.clip.id) {
      schedulePrime(prime.next);
    }

    if (sourceMs >= entry.clip.sourceEndMs - tolerance) {
      advanceFrom(entry);
    }
  };

  const onActivePlayToEnd = (player: VideoPlayer) => {
    if (player !== activePlayer()) return;
    const entry = entriesRef.current.find((candidate) => candidate.clip.id === activeClipIdRef.current);
    if (entry) advanceFrom(entry);
  };

  const onActivePlayingChange = (player: VideoPlayer, nativePlaying: boolean) => {
    if (player !== activePlayer()) return;
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
    player.play();
  };

  const onStatusChange = (player: VideoPlayer, status: string, error?: { message?: string }) => {
    if (player !== activePlayer()) return;
    if (status === 'error') {
      stopTransport();
      onErrorRef.current(error?.message ?? 'The current video could not be decoded.');
    }
  };

  useEventListener(playerA, 'timeUpdate', ({ currentTime }) => onActiveTimeUpdate(playerA, currentTime));
  useEventListener(playerB, 'timeUpdate', ({ currentTime }) => onActiveTimeUpdate(playerB, currentTime));
  useEventListener(playerA, 'playToEnd', () => onActivePlayToEnd(playerA));
  useEventListener(playerB, 'playToEnd', () => onActivePlayToEnd(playerB));
  useEventListener(playerA, 'playingChange', ({ isPlaying: nativePlaying }) => onActivePlayingChange(playerA, nativePlaying));
  useEventListener(playerB, 'playingChange', ({ isPlaying: nativePlaying }) => onActivePlayingChange(playerB, nativePlaying));
  useEventListener(playerA, 'statusChange', ({ status, error }) => onStatusChange(playerA, status, error));
  useEventListener(playerB, 'statusChange', ({ status, error }) => onStatusChange(playerB, status, error));

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
      clearStandbyPrime();
      cancelGapClock();
    };
  }, [playerA, playerB]);

  return {
    player: players[activeSlot],
    players,
    activeSlot,
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
