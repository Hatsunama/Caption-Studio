import { projectTimelineDuration, projectTimelineSegmentAt } from '@/lib/project-timeline';
import { loadPlayableVideoSource, videoSourceFailure, type VideoSourceFailure } from '@/lib/video-source-recovery';
import { videoPlaybackUri } from '@/lib/video-playback-source';
import { useEventListener } from 'expo';
import { useVideoPlayer, type VideoPlayer } from 'expo-video';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  buildClipTimeline,
  clipPlaybackVolume,
  sourceTimeAt,
  timelineTimeAt,
  type ClipTimelineEntry,
} from '@/lib/video-timeline';
import { canContinuePreparedTimelineClip, canContinueTimelineClip, CLIP_HANDOFF_BOUNDARY_TOLERANCE_MS, shouldApplyTimelineSeek } from '@/lib/video-playback-policy';
import { configureTimelinePlayer } from '@/services/video-player-runtime';
import type { CaptionProject, ProjectVideoSource } from '@/types/project';

type Target = { generation: number; timelineMs: number };
type TransportPhase = 'loading' | 'buffering' | 'ready' | 'gap' | 'ended' | 'error' | 'suspended';
type SlotIndex = 0 | 1;
const FIRST_FRAME_TIMEOUT_MS = 5_000;

export type TimelineVideoSlot = {
  sourceId?: string;
  playbackUri?: string;
  preparedClipId?: string;
  firstFrameReady: boolean;
  prepareToken: number;
  readiness: 'idle' | 'preparing' | 'ready' | 'error' | 'cancelled';
};

type SlotRuntime = TimelineVideoSlot & {
  prepareToken: number;
  preparation?: AbortController;
  preparationError?: Error;
  frameWaiters: Set<() => void>;
};

function createSlotRuntime(): SlotRuntime {
  return {
    firstFrameReady: false,
    prepareToken: 0,
    readiness: 'idle',
    frameWaiters: new Set(),
  };
}

export function useTimelineVideoController(project: CaptionProject, _onError: (message: string) => void, surfacesAdmitted = true) {
  const entries = useMemo(() => buildClipTimeline(project.clips), [project.clips]);
  const playerA = useVideoPlayer(null, configureTimelinePlayer);
  const playerB = useVideoPlayer(null, configureTimelinePlayer);
  const players = useMemo(() => [playerA, playerB] as const, [playerA, playerB]);

  const initialPhase: TransportPhase = entries.length ? 'loading' : 'ended';
  const [currentMs, setCurrentMsState] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [sourceFailure, setSourceFailure] = useState<VideoSourceFailure>();
  const [phase, setPhaseState] = useState<TransportPhase>(initialPhase);
  const [previewResourcesSuspended, setPreviewResourcesSuspended] = useState(false);
  const [activeSlot, setActiveSlotState] = useState<SlotIndex>(0);
  const [slots, setSlots] = useState<readonly [TimelineVideoSlot, TimelineVideoSlot]>([
    { firstFrameReady: false, prepareToken: 0, readiness: 'idle' },
    { firstFrameReady: false, prepareToken: 0, readiness: 'idle' },
  ]);
  const [hasPresentedFrame, setHasPresentedFrameState] = useState(false);

  const projectRef = useRef(project);
  const entriesRef = useRef(entries);
  const currentMsRef = useRef(0);
  const playIntentRef = useRef(false);
  const phaseRef = useRef<TransportPhase>(initialPhase);
  const activeSlotRef = useRef<SlotIndex>(0);
  const activeClipIdRef = useRef<string | undefined>(undefined);
  const slotRuntimeRef = useRef<[SlotRuntime, SlotRuntime]>([createSlotRuntime(), createSlotRuntime()]);
  const desiredRef = useRef<Target | undefined>(undefined);
  const processingRef = useRef<Promise<void> | undefined>(undefined);
  const drainTargetsRef = useRef<() => Promise<void>>(async () => {});
  const requestTargetRef = useRef<(timelineMs: number) => void>(() => {});
  const generationRef = useRef(0);
  const boundaryClipIdRef = useRef<string | undefined>(undefined);
  const gapFrameRef = useRef<number | undefined>(undefined);
  const preloadTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reloadRequestedRef = useRef(false);
  const hasPresentedFrameRef = useRef(false);
  const mountedRef = useRef(true);
  const surfacesAdmittedRef = useRef(surfacesAdmitted);
  const translationSuspensionRef = useRef<{
    generation: number;
    savedMs: number;
    restored: boolean;
    unloadStarted: boolean;
    ready: Promise<void>;
    resolveReady: () => void;
    rejectReady: (error: unknown) => void;
  } | null>(null);
  const translationSuspensionGenerationRef = useRef(0);

  useLayoutEffect(() => {
    projectRef.current = project;
    entriesRef.current = entries;
    surfacesAdmittedRef.current = surfacesAdmitted;
  }, [entries, project, surfacesAdmitted]);

  const publishSlots = useCallback(() => {
    if (!mountedRef.current) return;
    const [first, second] = slotRuntimeRef.current;
    setSlots([
      {
        sourceId: first.sourceId,
        playbackUri: first.playbackUri,
        preparedClipId: first.preparedClipId,
        firstFrameReady: first.firstFrameReady,
        prepareToken: first.prepareToken,
        readiness: first.readiness,
      },
      {
        sourceId: second.sourceId,
        playbackUri: second.playbackUri,
        preparedClipId: second.preparedClipId,
        firstFrameReady: second.firstFrameReady,
        prepareToken: second.prepareToken,
        readiness: second.readiness,
      },
    ]);
  }, []);

  const setPhase = (next: TransportPhase) => {
    phaseRef.current = next;
    if (mountedRef.current) setPhaseState(next);
  };

  const setCurrentMs = (value: number) => {
    const next = clamp(value, 0, projectTimelineDuration(projectRef.current));
    currentMsRef.current = next;
    if (mountedRef.current) setCurrentMsState(next);
  };

  const setActiveSlot = (next: SlotIndex) => {
    activeSlotRef.current = next;
    if (mountedRef.current) setActiveSlotState(next);
  };

  const markPresentedFrame = () => {
    if (hasPresentedFrameRef.current) return;
    hasPresentedFrameRef.current = true;
    if (mountedRef.current) setHasPresentedFrameState(true);
  };

  const playerForSlot = (slot: SlotIndex) => players[slot];

  const cancelGapClock = () => {
    if (gapFrameRef.current != null) cancelAnimationFrame(gapFrameRef.current);
    gapFrameRef.current = undefined;
  };

  const cancelScheduledPreload = () => {
    if (preloadTimeoutRef.current != null) clearTimeout(preloadTimeoutRef.current);
    preloadTimeoutRef.current = undefined;
  };

  const abortPreparationsExcept = (clipId?: string) => {
    slotRuntimeRef.current.forEach((runtime) => {
      if (!clipId || runtime.preparedClipId !== clipId) runtime.preparation?.abort();
    });
  };

  const stopTransport = useCallback(() => {
    playIntentRef.current = false;
    boundaryClipIdRef.current = undefined;
    cancelGapClock();
    cancelScheduledPreload();
    players.forEach((player) => player.pause());
    if (mountedRef.current) setIsPlaying(false);
  }, [players]);

  const suspendForTranslation = useCallback(() => {
    if (translationSuspensionRef.current && !translationSuspensionRef.current.restored) {
      throw new Error('Preview resources are already suspended for translation.');
    }

    let resolveReady = () => {};
    let rejectReady = (_error: unknown) => {};
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const suspension = {
      generation: ++translationSuspensionGenerationRef.current,
      savedMs: currentMsRef.current,
      restored: false,
      unloadStarted: false,
      ready,
      resolveReady,
      rejectReady,
    };
    translationSuspensionRef.current = suspension;
    generationRef.current += 1;
    desiredRef.current = undefined;
    abortPreparationsExcept();
    stopTransport();
    setPreviewResourcesSuspended(true);
    setPhase('suspended');

    return {
      ready: suspension.ready,
      restore: async () => {
        if (suspension.restored) return;
        suspension.restored = true;
        if (!mountedRef.current || translationSuspensionRef.current !== suspension) return;
        translationSuspensionRef.current = null;
        setCurrentMs(suspension.savedMs);
        setPreviewResourcesSuspended(false);
        setIsPlaying(false);
        if (surfacesAdmittedRef.current) requestTargetRef.current(suspension.savedMs);
        else setPhase('suspended');
      },
    };
  }, [stopTransport]);

  useEffect(() => {
    const suspension = translationSuspensionRef.current;
    if (!previewResourcesSuspended || !suspension || suspension.unloadStarted) return;
    suspension.unloadStarted = true;
    void (async () => {
      try {
        const processing = processingRef.current;
        if (processing) await processing;
        if (!mountedRef.current || translationSuspensionRef.current !== suspension) {
          suspension.resolveReady();
          return;
        }
        await Promise.all(players.map((slotPlayer) => slotPlayer.replaceAsync(null)));
        if (!mountedRef.current || translationSuspensionRef.current !== suspension) {
          suspension.resolveReady();
          return;
        }
        slotRuntimeRef.current = [createSlotRuntime(), createSlotRuntime()];
        activeClipIdRef.current = undefined;
        hasPresentedFrameRef.current = false;
        setHasPresentedFrameState(false);
        publishSlots();
        suspension.resolveReady();
      } catch (error) {
        suspension.rejectReady(error);
      }
    })();
  }, [players, previewResourcesSuspended, publishSlots]);

  const sourceForEntry = (entry: ClipTimelineEntry) => {
    const source = projectRef.current.sources.find((candidate) => candidate.id === entry.clip.sourceId);
    if (!source) throw new Error('This clip has lost its source video.');
    return source;
  };

  const failSource = (source: Pick<ProjectVideoSource, 'id' | 'uri' | 'displayName'>, error: unknown) => {
    if (!mountedRef.current) return;
    generationRef.current += 1;
    desiredRef.current = undefined;
    abortPreparationsExcept();
    stopTransport();
    setPhase('error');
    setSourceFailure(videoSourceFailure(source, error));
  };

  const markFirstFrame = useCallback((slot: SlotIndex, token: number) => {
    const runtime = slotRuntimeRef.current[slot];
    if (!mountedRef.current || token !== runtime.prepareToken
      || (runtime.readiness !== 'preparing' && runtime.readiness !== 'ready')) return;
    runtime.firstFrameReady = true;
    for (const resolve of runtime.frameWaiters) resolve();
    runtime.frameWaiters.clear();
    publishSlots();
  }, [publishSlots]);

  const waitForFirstFrame = (slot: SlotIndex, signal: AbortSignal) => {
    const runtime = slotRuntimeRef.current[slot];
    if (signal.aborted) return Promise.reject(abortError());
    if (runtime.firstFrameReady) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        runtime.frameWaiters.delete(ready);
        if (error) reject(error); else resolve();
      };
      const ready = () => finish();
      const abort = () => finish(abortError());
      const timeout = setTimeout(() => finish(new Error('The video did not render a frame in time. Try loading it again.')), FIRST_FRAME_TIMEOUT_MS);
      runtime.frameWaiters.add(ready);
      signal.addEventListener('abort', abort, { once: true });
    });
  };

  const waitForDecodedPosition = (
    player: VideoPlayer,
    targetSeconds: number,
    signal: AbortSignal,
  ) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    let timeout: ReturnType<typeof setTimeout>;
    let subscription: { remove: () => void } | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      subscription?.remove();
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(abortError());
    subscription = player.addListener('timeUpdate', ({ currentTime }) => {
      if (Math.abs(currentTime - targetSeconds) <= 0.25) finish();
    });
    timeout = setTimeout(() => finish(new Error('The video did not reach the requested frame in time. Try loading it again.')), FIRST_FRAME_TIMEOUT_MS);
    signal.addEventListener('abort', abort, { once: true });
  });

  const prepareSlot = async (
    slot: SlotIndex,
    entry: ClipTimelineEntry,
    timelineMs: number,
    forceReload = false,
  ) => {
    const runtime = slotRuntimeRef.current[slot];
    if (!surfacesAdmittedRef.current) throw abortError();
    const source = sourceForEntry(entry);
    const uri = videoPlaybackUri(source);
    const player = playerForSlot(slot);

    runtime.preparation?.abort();
    const preparation = new AbortController();
    runtime.preparation = preparation;
    runtime.preparationError = undefined;
    const token = ++runtime.prepareToken;
    const sourceChanged = forceReload || runtime.playbackUri !== uri;

    runtime.sourceId = source.id;
    runtime.playbackUri = uri;
    runtime.preparedClipId = entry.clip.id;
    runtime.firstFrameReady = false;
    runtime.readiness = 'preparing';
    publishSlots();

    try {
      if (sourceChanged) {
        runtime.firstFrameReady = false;
        publishSlots();
        await loadPlayableVideoSource(player, uri, 15_000, preparation.signal);
      }
      if (preparation.signal.aborted || token !== runtime.prepareToken) throw abortError();

      const targetSeconds = sourceTimeAt(entry, timelineMs) / 1_000;
      player.pause();
      player.muted = true;
      player.playbackRate = 1;
      player.currentTime = targetSeconds;
      const ready = Promise.all([
        waitForFirstFrame(slot, preparation.signal),
        waitForDecodedPosition(player, targetSeconds, preparation.signal),
      ]);
      try {
        player.play();
      } catch (error) {
        preparation.abort();
        await ready.catch(() => {});
        throw error;
      }
      await ready;
      if (preparation.signal.aborted || token !== runtime.prepareToken) throw abortError();
      player.pause();
      runtime.readiness = 'ready';
      publishSlots();
      return slot;
    } catch (caught) {
      const error = token === runtime.prepareToken ? runtime.preparationError ?? caught : abortError();
      if (token === runtime.prepareToken) {
        runtime.firstFrameReady = false;
        runtime.readiness = isAbortError(error) ? 'cancelled' : 'error';
        // A failed or cancelled replacement must not be reused by URI alone.
        runtime.playbackUri = undefined;
        player.pause();
        player.muted = true;
        publishSlots();
      }
      throw error;
    } finally {
      preparation.abort();
      if (runtime.preparation === preparation) runtime.preparation = undefined;
    }
  };

  const applyClipToSlot = (slot: SlotIndex, entry: ClipTimelineEntry, timelineMs: number) => {
    const media = playerForSlot(slot);
    media.playbackRate = entry.clip.playbackRate;
    media.muted = entry.clip.muted;
    media.volume = clipPlaybackVolume(entry.clip, timelineMs - entry.startMs);
    const timeSeconds = sourceTimeAt(entry, timelineMs) / 1_000;
    if (shouldApplyTimelineSeek(media.currentTime, timeSeconds)) media.currentTime = timeSeconds;
  };

  const findPreparedSlot = (entry: ClipTimelineEntry): SlotIndex | undefined => {
    const match = slotRuntimeRef.current.findIndex(
      (runtime) => runtime.preparedClipId === entry.clip.id && runtime.firstFrameReady
        && runtime.readiness === 'ready' && !runtime.preparation
        && runtime.playbackUri === videoPlaybackUri(sourceForEntry(entry)),
    );
    return match < 0 ? undefined : match as SlotIndex;
  };

  const nextEntryAfter = (entry: ClipTimelineEntry) => {
    const index = entriesRef.current.findIndex((candidate) => candidate.clip.id === entry.clip.id);
    return index < 0 ? undefined : entriesRef.current[index + 1];
  };

  const preloadNext = (entry: ClipTimelineEntry, occupiedSlot: SlotIndex, timelineMs: number) => {
    cancelScheduledPreload();
    const next = nextEntryAfter(entry);
    if (!next || next.startMs > entry.endMs + CLIP_HANDOFF_BOUNDARY_TOLERANCE_MS) return;
    if (canContinueTimelineClip(entry, next)) return;
    const standby = (occupiedSlot === 0 ? 1 : 0) as SlotIndex;
    const generation = generationRef.current;
    const entryIndex = entriesRef.current.findIndex((candidate) => candidate.clip.id === entry.clip.id);
    const previous = entryIndex > 0 ? entriesRef.current[entryIndex - 1] : undefined;
    const visibleTransitionEndMs = previous
      ? entry.startMs + previous.clip.transitionAfter.durationMs / 2
      : entry.startMs;
    const timelineDelayMs = Math.max(0, visibleTransitionEndMs - timelineMs);
    if (timelineDelayMs > 0 && !playIntentRef.current) return;
    const prepare = () => {
      preloadTimeoutRef.current = undefined;
      if (!mountedRef.current || !surfacesAdmittedRef.current || generation !== generationRef.current
        || activeSlotRef.current !== occupiedSlot || activeClipIdRef.current !== entry.clip.id) return;
      const runtime = slotRuntimeRef.current[standby];
      if (runtime.preparedClipId === next.clip.id
        && (runtime.readiness === 'preparing' || runtime.readiness === 'ready' || runtime.readiness === 'error')) return;
      // Preparation records its own failure. Only an explicit activation may
      // promote it to a transport failure; the current clip keeps playing.
      void prepareSlot(standby, next, next.startMs).catch(() => {});
    };
    if (timelineDelayMs > 0) {
      preloadTimeoutRef.current = setTimeout(prepare, timelineDelayMs / Math.max(0.1, entry.clip.playbackRate));
    } else {
      prepare();
    }
  };

  const continuePreparedClip = (entry: ClipTimelineEntry, timelineMs: number) => {
    const previous = entriesRef.current.find((candidate) => candidate.clip.id === activeClipIdRef.current);
    const source = projectRef.current.sources.find((candidate) => candidate.id === entry.clip.sourceId);
    if (!previous || !source || reloadRequestedRef.current) return false;
    const slot = activeSlotRef.current;
    const runtime = slotRuntimeRef.current[slot];
    const player = playerForSlot(slot);
    if (!canContinuePreparedTimelineClip(
      previous, entry, runtime, videoPlaybackUri(source), player, timelineMs,
    )) return false;
    runtime.preparedClipId = entry.clip.id;
    activeClipIdRef.current = entry.clip.id;
    boundaryClipIdRef.current = undefined;
    player.playbackRate = entry.clip.playbackRate;
    player.muted = entry.clip.muted;
    player.volume = clipPlaybackVolume(entry.clip, 0);
    publishSlots();
    setCurrentMs(entry.startMs);
    setSourceFailure(undefined);
    setPhase('ready');
    if (playIntentRef.current) {
      try {
        player.play();
      } catch (error) {
        failSource(source, error);
        return true;
      }
    }
    preloadNext(entry, slot, entry.startMs);
    return true;
  };

  const runGap = (startMs: number, endMs: number, next: ClipTimelineEntry | undefined) => {
    cancelGapClock();
    cancelScheduledPreload();
    players.forEach((player) => player.pause());
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
        if (next) requestTargetRef.current(next.startMs);
        else {
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

  const activateClip = async (entry: ClipTimelineEntry, timelineMs: number, generation: number) => {
    cancelGapClock();
    const source = sourceForEntry(entry);
    if (generation === generationRef.current && continuePreparedClip(entry, timelineMs)) return;
    let slot = reloadRequestedRef.current ? undefined : findPreparedSlot(entry);

    if (slot == null) {
      setPhase(hasPresentedFrameRef.current ? 'buffering' : 'loading');
      const currentSlot = activeSlotRef.current;
      const otherSlot = (currentSlot === 0 ? 1 : 0) as SlotIndex;
      slot = hasPresentedFrameRef.current ? otherSlot : currentSlot;
      if (slotRuntimeRef.current[otherSlot].preparedClipId === entry.clip.id) slot = otherSlot;
      try {
        await prepareSlot(slot, entry, timelineMs, reloadRequestedRef.current);
      } catch (error) {
        if (isAbortError(error) || generation !== generationRef.current) return;
        failSource(source, error);
        return;
      }
    }

    if (!mountedRef.current || generation !== generationRef.current) return;
    reloadRequestedRef.current = false;
    const previousSlot = activeSlotRef.current;
    setActiveSlot(slot);
    if (previousSlot !== slot) {
      playerForSlot(previousSlot).muted = true;
      playerForSlot(previousSlot).pause();
    }
    activeClipIdRef.current = entry.clip.id;
    boundaryClipIdRef.current = undefined;
    applyClipToSlot(slot, entry, timelineMs);
    setCurrentMs(timelineMs);
    setSourceFailure(undefined);
    markPresentedFrame();
    setPhase('ready');
    if (playIntentRef.current) playerForSlot(slot).play();
    preloadNext(entry, slot, timelineMs);
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
        } else if (segment.kind === 'gap') {
          runGap(target.timelineMs, segment.endMs, segment.next);
        } else {
          await activateClip(segment.entry, target.timelineMs, target.generation);
        }
      }
    })().catch((error) => {
      if (!mountedRef.current || isAbortError(error)) return;
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

  const requestTarget = (timelineMs: number) => {
    cancelScheduledPreload();
    const targetMs = clamp(timelineMs, 0, projectTimelineDuration(projectRef.current));
    const segment = projectTimelineSegmentAt(projectRef.current, targetMs, entriesRef.current);
    const clipId = segment?.kind === 'clip' ? segment.entry.clip.id : undefined;
    abortPreparationsExcept(clipId);
    setCurrentMs(targetMs);
    if (!surfacesAdmittedRef.current || translationSuspensionRef.current) {
      generationRef.current += 1;
      desiredRef.current = undefined;
      setPhase('suspended');
      return;
    }
    desiredRef.current = { generation: ++generationRef.current, timelineMs: targetMs };
    void drainTargetsRef.current();
  };

  useLayoutEffect(() => {
    requestTargetRef.current = requestTarget;
  });

  const seek = useCallback((timelineMs: number) => requestTargetRef.current(timelineMs), []);

  const play = useCallback(() => {
    if (!surfacesAdmittedRef.current || translationSuspensionRef.current) return;
    const duration = projectTimelineDuration(projectRef.current);
    const targetMs = currentMsRef.current >= duration - 1 ? 0 : currentMsRef.current;
    playIntentRef.current = true;
    if (mountedRef.current) setIsPlaying(true);
    requestTargetRef.current(targetMs);
  }, []);

  const pause = useCallback(() => {
    stopTransport();
    const segment = projectTimelineSegmentAt(projectRef.current, currentMsRef.current, entriesRef.current);
    if (segment?.kind === 'gap') setPhase('gap');
  }, [stopTransport]);

  const synchronizeProject = useCallback((nextProject: CaptionProject) => {
    projectRef.current = nextProject;
    entriesRef.current = buildClipTimeline(nextProject.clips);
    requestTargetRef.current(clamp(currentMsRef.current, 0, projectTimelineDuration(nextProject)));
  }, []);

  const advanceFrom = (entry: ClipTimelineEntry) => {
    if (!playIntentRef.current || boundaryClipIdRef.current === entry.clip.id) return;
    boundaryClipIdRef.current = entry.clip.id;
    const next = nextEntryAfter(entry);
    const gapEndMs = next?.startMs ?? projectTimelineDuration(projectRef.current);
    if (gapEndMs > entry.endMs) {
      runGap(entry.endMs, gapEndMs, next);
      return;
    }
    if (!next) {
      stopTransport();
      setCurrentMs(entry.endMs);
      setPhase('ended');
      return;
    }
    if (continuePreparedClip(next, next.startMs)) return;
    requestTargetRef.current(next.startMs);
  };

  const onTimeUpdate = (slot: SlotIndex, currentTime: number) => {
    if (slot !== activeSlotRef.current || !playIntentRef.current || processingRef.current) return;
    const entry = entriesRef.current.find((candidate) => candidate.clip.id === activeClipIdRef.current);
    if (!entry) return;
    const sourceMs = currentTime * 1_000;
    const tolerance = Math.max(4, entry.clip.playbackRate * 12);
    const timelineMs = clamp(timelineTimeAt(entry, sourceMs), entry.startMs, entry.endMs);
    setCurrentMs(timelineMs);
    playerForSlot(slot).volume = clipPlaybackVolume(entry.clip, timelineMs - entry.startMs);
    if (sourceMs >= entry.clip.sourceEndMs - tolerance) advanceFrom(entry);
  };

  const onPlayToEnd = (slot: SlotIndex) => {
    if (slot !== activeSlotRef.current || processingRef.current || phaseRef.current !== 'ready') return;
    const entry = entriesRef.current.find((candidate) => candidate.clip.id === activeClipIdRef.current);
    if (entry) advanceFrom(entry);
  };

  const onPlayingChange = (slot: SlotIndex, nativePlaying: boolean) => {
    if (slot !== activeSlotRef.current || nativePlaying || !playIntentRef.current) return;
    if (processingRef.current || phaseRef.current !== 'ready') return;
    const entry = entriesRef.current.find((candidate) => candidate.clip.id === activeClipIdRef.current);
    if (entry && playerForSlot(slot).currentTime * 1_000 >= entry.clip.sourceEndMs - 200) advanceFrom(entry);
    else playerForSlot(slot).play();
  };

  const onStatusChange = (slot: SlotIndex, status: string, error: unknown) => {
    if (status !== 'error') return;
    const runtime = slotRuntimeRef.current[slot];
    if (runtime.preparation) {
      runtime.preparationError = error instanceof Error ? error : new Error(
        typeof error === 'object' && error && 'message' in error ? String(error.message) : 'The video could not be loaded.',
      );
      runtime.preparation.abort();
      return;
    }
    if (runtime.readiness !== 'ready') return;
    const ownsPlayback = slot === activeSlotRef.current && runtime.preparedClipId === activeClipIdRef.current;
    runtime.readiness = 'error';
    runtime.firstFrameReady = false;
    runtime.playbackUri = undefined;
    playerForSlot(slot).pause();
    playerForSlot(slot).muted = true;
    publishSlots();
    if (!ownsPlayback) return;
    const source = projectRef.current.sources.find((candidate) => candidate.id === runtime.sourceId);
    if (source) failSource(source, error);
  };

  useEventListener(playerA, 'timeUpdate', ({ currentTime }) => onTimeUpdate(0, currentTime));
  useEventListener(playerA, 'playToEnd', () => onPlayToEnd(0));
  useEventListener(playerA, 'playingChange', ({ isPlaying: nativePlaying }) => onPlayingChange(0, nativePlaying));
  useEventListener(playerA, 'statusChange', ({ status, error }) => onStatusChange(0, status, error));
  useEventListener(playerB, 'timeUpdate', ({ currentTime }) => onTimeUpdate(1, currentTime));
  useEventListener(playerB, 'playToEnd', () => onPlayToEnd(1));
  useEventListener(playerB, 'playingChange', ({ isPlaying: nativePlaying }) => onPlayingChange(1, nativePlaying));
  useEventListener(playerB, 'statusChange', ({ status, error }) => onStatusChange(1, status, error));

  useEffect(() => {
    mountedRef.current = true;
    requestTargetRef.current(0);
    return () => {
      mountedRef.current = false;
      if (translationSuspensionRef.current) {
        translationSuspensionRef.current.restored = true;
        translationSuspensionRef.current.resolveReady();
      }
      translationSuspensionRef.current = null;
      playIntentRef.current = false;
      desiredRef.current = undefined;
      generationRef.current += 1;
      boundaryClipIdRef.current = undefined;
      abortPreparationsExcept();
      cancelGapClock();
      cancelScheduledPreload();
    };
  }, []);

  useEffect(() => {
    if (!surfacesAdmitted || translationSuspensionRef.current) {
      generationRef.current += 1;
      desiredRef.current = undefined;
      abortPreparationsExcept();
      stopTransport();
      setPhase('suspended');
    } else if (phaseRef.current === 'suspended') {
      requestTargetRef.current(currentMsRef.current);
    }
  }, [surfacesAdmitted, stopTransport]);

  return {
    player: players[activeSlot],
    players,
    slots,
    activeSlot,
    markFirstFrame,
    hasPresentedFrame,
    currentMs,
    isPlaying,
    phase,
    sourceFailure,
    retrySource: () => {
      stopTransport();
      reloadRequestedRef.current = true;
      requestTarget(currentMsRef.current);
    },
    isGap: phase === 'gap' || entries.length === 0 || projectTimelineSegmentAt(project, currentMs, entries)?.kind === 'gap',
    seek,
    play,
    pause,
    synchronizeProject,
    previewResourcesSuspended,
    suspendForTranslation,
  };
}

function abortError() {
  const error = new Error('Video preparation was superseded.');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
