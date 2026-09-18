import { projectTimelineDuration, projectTimelineSegmentAt } from '@/lib/project-timeline';
import { loadPlayableVideoSource, videoSourceFailure, type VideoSourceFailure } from '@/lib/video-source-recovery';
import { useEventListener } from 'expo';
import { useVideoPlayer } from 'expo-video';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  buildClipTimeline,
  clipPlaybackVolume,
  sourceTimeAt,
  timelineTimeAt,
  type ClipTimelineEntry,
} from '@/lib/video-timeline';
import {
  CLIP_HANDOFF_BOUNDARY_TOLERANCE_MS,
  canContinueTimelineClip,
  shouldApplyTimelineSeek,
} from '@/lib/video-playback-policy';
import { configureTimelinePlayer } from '@/services/video-player-runtime';
import type { CaptionProject, ProjectVideoSource } from '@/types/project';

type Target = { generation: number; timelineMs: number };
type TransportPhase = 'loading' | 'ready' | 'gap' | 'ended' | 'error';

export function useTimelineVideoController(project: CaptionProject, _onError: (message: string) => void) {
  const entries = useMemo(() => buildClipTimeline(project.clips), [project.clips]);
  const initialEntry = entries[0];
  const initialSource = project.sources.find((source) => source.id === initialEntry?.clip.sourceId);
  const player = useVideoPlayer(initialSource?.uri ?? null, (instance) => {
    configureTimelinePlayer(instance);
    if (initialEntry) instance.currentTime = initialEntry.clip.sourceStartMs / 1_000;
  });
  const activePlayer = useCallback(() => player, [player]);

  const [currentMs, setCurrentMsState] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [sourceFailure, setSourceFailure] = useState<VideoSourceFailure>();
  const [phase, setPhaseState] = useState<TransportPhase>(initialEntry ? 'loading' : 'ended');
  const projectRef = useRef(project);
  const entriesRef = useRef(entries);
  const currentMsRef = useRef(0);
  const playIntentRef = useRef(false);
  const phaseRef = useRef<TransportPhase>(initialEntry ? 'loading' : 'ended');
  const loadedSourceRef = useRef<ProjectVideoSource | undefined>(undefined);
  const confirmedSourceRef = useRef<ProjectVideoSource | undefined>(undefined);
  const activeClipIdRef = useRef<string | undefined>(undefined);
  const desiredRef = useRef<Target | undefined>(undefined);
  const processingRef = useRef<Promise<void> | undefined>(undefined);
  const drainTargetsRef = useRef<() => Promise<void>>(async () => {});
  const generationRef = useRef(0);
  const boundaryClipIdRef = useRef<string | undefined>(undefined);
  const gapFrameRef = useRef<number | undefined>(undefined);
  const internalPauseGenerationRef = useRef<number | undefined>(undefined);
  const reloadRequestedRef = useRef(false);
  const mountedRef = useRef(true);

  useLayoutEffect(() => {
    projectRef.current = project;
    entriesRef.current = entries;
  }, [entries, project]);

  const setPhase = (next: TransportPhase) => {
    phaseRef.current = next;
    if (mountedRef.current) setPhaseState(next);
  };
  const setCurrentMs = (value: number) => {
    const next = clamp(value, 0, projectTimelineDuration(projectRef.current));
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
    activePlayer().pause();
    if (mountedRef.current) setIsPlaying(false);
  }, [activePlayer]);
  const sourceForEntry = (entry: ClipTimelineEntry) => {
    const source = projectRef.current.sources.find((candidate) => candidate.id === entry.clip.sourceId);
    if (!source) throw new Error('This clip has lost its source video.');
    return source;
  };
  const failSource = (source: Pick<ProjectVideoSource, 'id' | 'uri' | 'displayName'>, error: unknown) => {
    if (!mountedRef.current) return;
    generationRef.current += 1;
    desiredRef.current = undefined;
    confirmedSourceRef.current = undefined;
    stopTransport();
    setPhase('error');
    setSourceFailure(videoSourceFailure(source, error));
  };
  const applyClipToPlayer = (entry: ClipTimelineEntry, timelineMs: number) => {
    const media = activePlayer();
    media.playbackRate = entry.clip.playbackRate;
    media.muted = entry.clip.muted;
    media.volume = clipPlaybackVolume(entry.clip, timelineMs - entry.startMs);
    const timeSeconds = sourceTimeAt(entry, timelineMs) / 1_000;
    if (shouldApplyTimelineSeek(media.currentTime, timeSeconds)) media.currentTime = timeSeconds;
  };
  const runGap = (startMs: number, endMs: number, next: ClipTimelineEntry | undefined, generation: number) => {
    cancelGapClock();
    internalPauseGenerationRef.current = generation;
    activePlayer().pause();
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
    const loaded = loadedSourceRef.current;
    const confirmed = confirmedSourceRef.current;
    const sourceChanged = reloadRequestedRef.current
      || loaded?.id !== source.id
      || loaded?.uri !== source.uri
      || (confirmed?.id !== source.id && activePlayer().status !== 'readyToPlay');
    internalPauseGenerationRef.current = generation;
    activePlayer().pause();
    if (sourceChanged) {
      setPhase('loading');
      loadedSourceRef.current = source;
      try {
        await loadPlayableVideoSource(activePlayer(), source.uri);
      } catch (error) {
        if (generation === generationRef.current) failSource(source, error);
        return;
      }
      if (!mountedRef.current || generation !== generationRef.current) return;
      reloadRequestedRef.current = false;
    }
    if (generation !== generationRef.current) return;
    confirmedSourceRef.current = source;
    activeClipIdRef.current = entry.clip.id;
    boundaryClipIdRef.current = undefined;
    applyClipToPlayer(entry, timelineMs);
    setCurrentMs(timelineMs);
    setPhase('ready');
    setSourceFailure(undefined);
    if (playIntentRef.current) activePlayer().play();
  };
  async function drainTargets() {
    if (processingRef.current) return processingRef.current;
    const operation = (async () => {
      while (desiredRef.current && mountedRef.current) {
        const target = desiredRef.current;
        desiredRef.current = undefined;
        const segment = projectTimelineSegmentAt(projectRef.current, target.timelineMs, entriesRef.current);
        if (!segment) {
          stopTransport();
          setCurrentMs(projectTimelineDuration(projectRef.current));
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
      const segment = projectTimelineSegmentAt(projectRef.current, currentMsRef.current, entriesRef.current);
      const sourceId = segment?.kind === 'clip' ? segment.entry.clip.sourceId : 'unknown';
      const source = projectRef.current.sources.find((candidate) => candidate.id === sourceId);
      failSource(source ?? { id: sourceId, uri: '', displayName: 'Source video' }, error);
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
    const targetMs = clamp(timelineMs, 0, projectTimelineDuration(projectRef.current));
    setCurrentMs(targetMs);
    desiredRef.current = { generation: ++generationRef.current, timelineMs: targetMs };
    void drainTargetsRef.current();
  }, []);
  const play = useCallback(() => {
    const duration = projectTimelineDuration(projectRef.current);
    const targetMs = currentMsRef.current >= duration - 1 ? 0 : currentMsRef.current;
    playIntentRef.current = true;
    if (mountedRef.current) setIsPlaying(true);
    desiredRef.current = { generation: ++generationRef.current, timelineMs: targetMs };
    void drainTargetsRef.current();
  }, []);
  const pause = useCallback(() => {
    stopTransport();
    const segment = projectTimelineSegmentAt(projectRef.current, currentMsRef.current, entriesRef.current);
    if (segment?.kind === 'gap') setPhase('gap');
  }, [stopTransport]);
  const synchronizeProject = useCallback((nextProject: CaptionProject) => {
    projectRef.current = nextProject;
    entriesRef.current = buildClipTimeline(nextProject.clips);
    const timelineMs = clamp(currentMsRef.current, 0, projectTimelineDuration(nextProject));
    setCurrentMs(timelineMs);
    desiredRef.current = { generation: ++generationRef.current, timelineMs };
    void drainTargetsRef.current();
  }, []);
  const advanceFrom = (entry: ClipTimelineEntry) => {
    if (!playIntentRef.current || boundaryClipIdRef.current === entry.clip.id) return;
    boundaryClipIdRef.current = entry.clip.id;
    const index = entriesRef.current.findIndex((candidate) => candidate.clip.id === entry.clip.id);
    const next = entriesRef.current[index + 1];
    const gapEndMs = next?.startMs ?? projectTimelineDuration(projectRef.current);
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
      activeClipIdRef.current = next.clip.id;
      confirmedSourceRef.current = sourceForEntry(next);
      boundaryClipIdRef.current = undefined;
      const media = activePlayer();
      media.playbackRate = next.clip.playbackRate;
      media.muted = next.clip.muted;
      media.volume = clipPlaybackVolume(next.clip, 0);
      setCurrentMs(next.startMs);
      setPhase('ready');
      return;
    }
    setCurrentMs(next.startMs);
    desiredRef.current = { generation: ++generationRef.current, timelineMs: next.startMs };
    void drainTargetsRef.current();
  };
  const onTimeUpdate = (currentTime: number) => {
    if (!playIntentRef.current || processingRef.current) return;
    const entry = entriesRef.current.find((candidate) => candidate.clip.id === activeClipIdRef.current);
    if (!entry) return;
    const sourceMs = currentTime * 1_000;
    const tolerance = Math.max(4, entry.clip.playbackRate * 12);
    const timelineMs = clamp(timelineTimeAt(entry, sourceMs), entry.startMs, entry.endMs);
    setCurrentMs(timelineMs);
    activePlayer().volume = clipPlaybackVolume(entry.clip, timelineMs - entry.startMs);
    if (sourceMs >= entry.clip.sourceEndMs - tolerance) advanceFrom(entry);
  };
  const onPlayToEnd = () => {
    const entry = entriesRef.current.find((candidate) => candidate.clip.id === activeClipIdRef.current);
    if (entry) advanceFrom(entry);
  };
  const onActivePlayingChange = (nativePlaying: boolean) => {
    if (nativePlaying) {
      internalPauseGenerationRef.current = undefined;
      return;
    }
    if (!playIntentRef.current || processingRef.current || phaseRef.current !== 'ready') return;
    if (internalPauseGenerationRef.current === generationRef.current) return;
    const entry = entriesRef.current.find((candidate) => candidate.clip.id === activeClipIdRef.current);
    if (entry && activePlayer().currentTime * 1_000 >= entry.clip.sourceEndMs - 200) {
      advanceFrom(entry);
      return;
    }
    activePlayer().play();
  };
  const onStatusChange = (status: string, error: unknown) => {
    if (status === 'error' && loadedSourceRef.current) failSource(loadedSourceRef.current, error);
  };

  useEventListener(player, 'timeUpdate', ({ currentTime }) => onTimeUpdate(currentTime));
  useEventListener(player, 'playToEnd', onPlayToEnd);
  useEventListener(player, 'playingChange', ({ isPlaying: nativePlaying }) => onActivePlayingChange(nativePlaying));
  useEventListener(player, 'statusChange', ({ status, error }) => onStatusChange(status, error));

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
  }, [activePlayer]);

  return {
    player,
    currentMs,
    isPlaying,
    phase,
    sourceFailure,
    retrySource: () => {
      stopTransport();
      reloadRequestedRef.current = true;
      confirmedSourceRef.current = undefined;
      seek(currentMsRef.current);
    },
    isGap: phase === 'gap' || entries.length === 0 || projectTimelineSegmentAt(project, currentMs, entries)?.kind === 'gap',
    seek,
    play,
    pause,
    synchronizeProject,
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
