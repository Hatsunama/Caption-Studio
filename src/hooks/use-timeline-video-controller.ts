import { projectTimelineDuration, projectTimelineSegmentAt } from '@/lib/project-timeline';
import { buildVideoTransitionPreviewWindows, transitionTimelineTimeAt } from '@/lib/video-transition-preview';
import { transitionClipPlaybackVolume } from '@/lib/video-transition-audio';
import { loadPlayableVideoSource, videoSourceFailure, type VideoSourceFailure } from '@/lib/video-source-recovery';
import { desiredVideoPlaybackWindowEnd } from '@/lib/video-playback-window';
import { acquireVideoMaskLease, configureVideoPlaybackWindow, disposeVideoMaskLease } from '@/services/video-playback-window';
import { videoPlaybackUri } from '@/lib/video-playback-source';
import { acknowledgesPlaybackPosition, effectiveNativeSeekTarget } from '@/lib/video-playback-position';
import { useEventListener } from 'expo';
import { useVideoPlayer, type VideoPlayer } from 'expo-video';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';

import {
  buildClipTimeline,
  sourceTimeAt,
  timelineTimeAt,
  type ClipTimelineEntry,
} from '@/lib/video-timeline';
import { canContinuePreparedTimelineClip, canContinueTimelineClip, CLIP_HANDOFF_BOUNDARY_TOLERANCE_MS, shouldApplyTimelineSeek, shouldJoinTimelinePreparation } from '@/lib/video-playback-policy';
import { configureTimelinePlayer } from '@/services/video-player-runtime';
import type { CaptionProject, ProjectVideoSource } from '@/types/project';

type Target = { generation: number; timelineMs: number };
type TransportPhase = 'loading' | 'buffering' | 'ready' | 'gap' | 'ended' | 'error' | 'suspended';
type SlotIndex = 0 | 1;
type CompositeClock = { key: string; slot: SlotIndex; prepareToken: number };
const FIRST_FRAME_TIMEOUT_MS = 5_000;

export type TimelineVideoSlot = {
  sourceId?: string;
  playbackUri?: string;
  preparedClipId?: string;
  firstFrameReady: boolean;
  prepareToken: number;
  nativeViewEpoch: number;
  readiness: 'idle' | 'preparing' | 'ready' | 'error' | 'cancelled';
  // Published from the installed item, not inferred from the preview recipe.
  appliedWindowEndMs?: number | null;
};

type SlotRuntime = TimelineVideoSlot & {
  prepareToken: number;
  renderGate: 'disarmed' | 'loading' | 'awaitingPosition' | 'awaitingFrame' | 'ready';
  preparation?: AbortController;
  preparationTask?: Promise<SlotIndex>;
  sourceMutation?: Promise<void>;
  preparingTimelineMs?: number;
  preparingWindowEndMs?: number;
  // null is unknown; undefined is a confirmed full-source item.
  appliedWindowEndMs: number | null | undefined;
  preparationError?: Error;
  frameWaiters: Set<() => void>;
};

function createSlotRuntime(prepareToken: number, nativeViewEpoch: number): SlotRuntime {
  return {
    firstFrameReady: false,
    prepareToken,
    nativeViewEpoch,
    renderGate: 'disarmed',
    readiness: 'idle',
    appliedWindowEndMs: null,
    frameWaiters: new Set(),
  };
}

export function useTimelineVideoController(project: CaptionProject, _onError: (message: string) => void, surfacesAdmitted = true) {
  const entries = useMemo(() => buildClipTimeline(project.clips), [project.clips]);
  const transitionWindows = useMemo(() => buildVideoTransitionPreviewWindows(entries, project.sources), [entries, project.sources]);
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
    { firstFrameReady: false, prepareToken: 0, nativeViewEpoch: 0, readiness: 'idle' },
    { firstFrameReady: false, prepareToken: 0, nativeViewEpoch: 0, readiness: 'idle' },
  ]);
  const [hasPresentedFrame, setHasPresentedFrameState] = useState(false);

  const projectRef = useRef(project);
  const entriesRef = useRef(entries);
  const transitionWindowsRef = useRef(transitionWindows);
  const currentMsRef = useRef(0);
  const playIntentRef = useRef(false);
  const phaseRef = useRef<TransportPhase>(initialPhase);
  const activeSlotRef = useRef<SlotIndex>(0);
  const compositeClockRef = useRef<CompositeClock | undefined>(undefined);
  const pendingOrdinaryRestoreRef = useRef(false);
  const activeClipIdRef = useRef<string | undefined>(undefined);
  const slotRuntimeRef = useRef<[SlotRuntime, SlotRuntime]>([createSlotRuntime(0, 0), createSlotRuntime(0, 0)]);
  const desiredRef = useRef<Target | undefined>(undefined);
  const processingRef = useRef<Promise<void> | undefined>(undefined);
  const drainTargetsRef = useRef<() => Promise<void>>(async () => {});
  const requestTargetRef = useRef<(timelineMs: number) => void>(() => {});
  const generationRef = useRef(0);
  const boundaryClipIdRef = useRef<string | undefined>(undefined);
  const gapFrameRef = useRef<number | undefined>(undefined);
  const preloadTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingPreloadRef = useRef<(() => void) | undefined>(undefined);
  const committedPreviewRef = useRef({ activeSlot, timelineMs: currentMs });
  const maskRequestIdsRef = useRef<[number, number]>([0, 0]);
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
    transitionWindowsRef.current = transitionWindows;
    surfacesAdmittedRef.current = surfacesAdmitted;
  }, [entries, project, surfacesAdmitted, transitionWindows]);

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
        nativeViewEpoch: first.nativeViewEpoch,
        readiness: first.readiness,
        appliedWindowEndMs: first.appliedWindowEndMs,
      },
      {
        sourceId: second.sourceId,
        playbackUri: second.playbackUri,
        preparedClipId: second.preparedClipId,
        firstFrameReady: second.firstFrameReady,
        prepareToken: second.prepareToken,
        nativeViewEpoch: second.nativeViewEpoch,
        readiness: second.readiness,
        appliedWindowEndMs: second.appliedWindowEndMs,
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

  const playbackVolume = (entry: ClipTimelineEntry, timelineMs: number) => {
    const window = transitionWindowsRef.current.find(candidate => timelineMs >= candidate.startMs && timelineMs <= candidate.endMs
      && (candidate.outgoing?.clipId === entry.clip.id || candidate.incoming?.clipId === entry.clip.id));
    // Ordinary activation has no authority to reveal composite audio before the
    // retained pair is ready. SynchronizedComposite installs both gains together.
    if (window?.mode === 'composite' && timelineMs < window.endMs) return 0;
    return transitionClipPlaybackVolume(entry, timelineMs, window);
  };

  const retireComposite = (allowOrdinaryPlayback = true) => {
    const clock = compositeClockRef.current;
    compositeClockRef.current = undefined;
    const restoreAfterProcessing = pendingOrdinaryRestoreRef.current && !processingRef.current;
    pendingOrdinaryRestoreRef.current = allowOrdinaryPlayback && Boolean(processingRef.current);
    const active = activeSlotRef.current;
    const runtime = slotRuntimeRef.current[active];
    const entry = entriesRef.current.find(candidate => candidate.clip.id === activeClipIdRef.current);
    const ordinaryReady = allowOrdinaryPlayback && mountedRef.current && surfacesAdmittedRef.current
      && !translationSuspensionRef.current && phaseRef.current === 'ready'
      && !processingRef.current && !runtime.preparation && runtime.readiness === 'ready' && runtime.firstFrameReady
      && entry && runtime.preparedClipId === entry.clip.id;
    const canRestore = ordinaryReady && playIntentRef.current;
    const ownsClock = clock?.slot === active && clock.prepareToken === runtime.prepareToken;
    const insideComposite = transitionWindowsRef.current.some(window => window.mode === 'composite'
      && currentMsRef.current >= window.startMs && currentMsRef.current < window.endMs);
    // Ordinary activation may have installed a new owner before the old keyed
    // component unmounts. Preserve that owner's existing paused/audio state.
    const preserveOrdinaryOwner = ordinaryReady && !insideComposite && !ownsClock && !restoreAfterProcessing;
    // Retire against current ownership, not the outgoing composite's last props.
    // Only the retiring clock's current preparation may rebase source time.
    // New target processing/ownership must retain its own position and rate.
    players.forEach((player, slot) => {
      if (slot !== active || (!canRestore && !preserveOrdinaryOwner)) {
        player.muted = true;
        player.volume = 0;
        player.pause();
      }
    });
    if (canRestore && !preserveOrdinaryOwner) {
      const player = players[active];
      if (ownsClock) {
        applyClipToSlot(active, entry, currentMsRef.current);
      }
      player.volume = playbackVolume(entry, currentMsRef.current);
      player.muted = entry.clip.muted || player.volume <= 0;
      if (!player.playing) player.play();
    }
  };

  const cancelGapClock = () => {
    if (gapFrameRef.current != null) cancelAnimationFrame(gapFrameRef.current);
    gapFrameRef.current = undefined;
  };

  const cancelScheduledPreload = () => {
    if (preloadTimeoutRef.current != null) clearTimeout(preloadTimeoutRef.current);
    preloadTimeoutRef.current = undefined;
    pendingPreloadRef.current = undefined;
  };

  const abortPreparationsExcept = (clipId?: string) => {
    slotRuntimeRef.current.forEach((runtime) => {
      if (!clipId || runtime.preparedClipId !== clipId) runtime.preparation?.abort();
    });
  };

  const stopTransport = useCallback(() => {
    playIntentRef.current = false;
    compositeClockRef.current = undefined;
    boundaryClipIdRef.current = undefined;
    cancelGapClock();
    cancelScheduledPreload();
    players.forEach((player) => { player.muted = true; player.volume = 0; player.pause(); });
    if (mountedRef.current) setIsPlaying(false);
  }, [players]);

  const retireSurfaceFrames = useCallback(() => {
    players.forEach(player => { player.muted = true; player.volume = 0; player.pause(); });
    slotRuntimeRef.current.forEach((runtime) => {
      runtime.preparation?.abort();
      // Retire callbacks and async continuations before publishing new surfaces.
      runtime.prepareToken = nextPrepareToken(runtime.prepareToken);
      runtime.nativeViewEpoch += 1;
      runtime.renderGate = 'disarmed';
      runtime.preparation = undefined;
      runtime.preparationTask = undefined;
      runtime.firstFrameReady = false;
      runtime.readiness = 'idle';
      // Retire this controller's URI cache with its surface ownership so the
      // next preparation replaces the item before accepting a fresh frame.
      runtime.playbackUri = undefined;
      runtime.appliedWindowEndMs = null;
      runtime.preparingWindowEndMs = undefined;
    });
    hasPresentedFrameRef.current = false;
    if (mountedRef.current) setHasPresentedFrameState(false);
    publishSlots();
  }, [players, publishSlots]);

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
    retireSurfaceFrames();
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
  }, [retireSurfaceFrames, stopTransport]);

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
        slotRuntimeRef.current = slotRuntimeRef.current.map((runtime) =>
          createSlotRuntime(nextPrepareToken(runtime.prepareToken), runtime.nativeViewEpoch + 1),
        ) as [SlotRuntime, SlotRuntime];
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

  const windowEndForEntry = (entry: ClipTimelineEntry) => {
    const source = sourceForEntry(entry);
    return desiredVideoPlaybackWindowEnd(entry, entriesRef.current, source, videoPlaybackUri(source),
      transitionWindowsRef.current, Platform.OS);
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

  const markFirstFrame = useCallback((slot: SlotIndex, nativeViewEpoch: number) => {
    const runtime = slotRuntimeRef.current[slot];
    if (!mountedRef.current || !surfacesAdmittedRef.current || translationSuspensionRef.current
      || nativeViewEpoch !== runtime.nativeViewEpoch
      || (runtime.renderGate !== 'awaitingFrame' && runtime.renderGate !== 'ready')
      || (runtime.readiness === 'preparing' && runtime.preparation?.signal.aborted)
      || (runtime.readiness !== 'preparing' && runtime.readiness !== 'ready')) return;
    runtime.firstFrameReady = true;
    for (const resolve of runtime.frameWaiters) resolve();
    runtime.frameWaiters.clear();
    publishSlots();
  }, [publishSlots]);

  const waitForFirstFrame = (slot: SlotIndex, signal: AbortSignal, deadline: number) => {
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
      const timeout = setTimeout(() => finish(new Error('The video did not render a frame in time. Try loading it again.')),
        Math.max(0, deadline - performance.now()));
      runtime.frameWaiters.add(ready);
      signal.addEventListener('abort', abort, { once: true });
    });
  };

  const waitForPlaybackPosition = (
    player: VideoPlayer,
    targetSeconds: number,
    signal: AbortSignal,
    deadline: number,
    assignTarget = true,
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
      if (acknowledgesPlaybackPosition(currentTime, targetSeconds, Platform.OS)) finish();
    });
    timeout = setTimeout(() => finish(new Error('The video did not reach the requested frame in time. Try loading it again.')), Math.max(0, deadline - performance.now()));
    signal.addEventListener('abort', abort, { once: true });
    // Subscribe before assigning: even a synchronous native ACK must be retained.
    try { if (assignTarget) player.currentTime = targetSeconds; }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });

  const prepareSlotOperation = async (
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
    const windowEndMs = windowEndForEntry(entry);

    runtime.preparation?.abort();
    const preparation = new AbortController();
    runtime.preparation = preparation;
    runtime.preparationError = undefined;
    const token = nextPrepareToken(runtime.prepareToken);
    runtime.prepareToken = token;
    const sourceChanged = forceReload || runtime.playbackUri !== uri
      || runtime.sourceId !== source.id || runtime.appliedWindowEndMs !== windowEndMs
      || runtime.sourceMutation != null;

    runtime.sourceId = source.id;
    runtime.playbackUri = uri;
    runtime.preparedClipId = entry.clip.id;
    runtime.preparingTimelineMs = timelineMs;
    runtime.preparingWindowEndMs = windowEndMs;
    runtime.firstFrameReady = false;
    runtime.renderGate = 'loading';
    runtime.readiness = 'preparing';
    publishSlots();

    let mask: Awaited<ReturnType<typeof acquireVideoMaskLease>> | undefined;
    const invalidateCancelledCache = () => {
      if (runtime.prepareToken !== token) return;
      runtime.firstFrameReady = false;
      runtime.playbackUri = undefined;
      runtime.appliedWindowEndMs = null;
    };
    preparation.signal.addEventListener('abort', invalidateCancelledCache, { once: true });
    try {
      if (Platform.OS === 'android') {
        maskRequestIdsRef.current[slot] = token;
        mask = await acquireVideoMaskLease(player, playerForSlot(slot === 0 ? 1 : 0), token,
          generationRef.current + 1, hasPresentedFrameRef.current && slot !== activeSlotRef.current, preparation.signal);
        if (preparation.signal.aborted || token !== runtime.prepareToken) throw abortError();
        // An aborted loader does not cancel Expo's queued mainQueue replacement.
        // Keep this native lease while draining that mutation before starting another.
        if (runtime.sourceMutation) await waitForSourceMutation(runtime.sourceMutation, preparation.signal);
        if (preparation.signal.aborted || token !== runtime.prepareToken) throw abortError();
      }
      player.pause();
      player.muted = true;
      if (sourceChanged) {
        runtime.firstFrameReady = false;
        publishSlots();
        await loadPlayableVideoSource(Platform.OS === 'android' ? {
          get status() { return player.status; },
          addListener: (event, listener) => player.addListener(event, listener),
          replaceAsync: (replacementUri) => {
            const task = player.replaceAsync(replacementUri);
            runtime.sourceMutation = task;
            const clear = () => { if (runtime.sourceMutation === task) runtime.sourceMutation = undefined; };
            void task.then(clear, clear);
            return task;
          },
        } : player, uri, 15_000, preparation.signal);
        if (preparation.signal.aborted || token !== runtime.prepareToken) throw abortError();
        // Android's installed contract stays unknown until owned native presentation.
        runtime.appliedWindowEndMs = Platform.OS === 'android' ? null : undefined;
      }
      if (preparation.signal.aborted || token !== runtime.prepareToken) throw abortError();

      // One post-SDK budget covers native presentation and the position ACK,
      // or the legacy seek/ACK/fresh-view sequence for iOS/web.
      const frameDeadline = performance.now() + FIRST_FRAME_TIMEOUT_MS;
      const nativePresentation = Platform.OS === 'android';
      const expectedNativeDuration = nativePresentation && windowEndMs !== undefined
        ? Math.min(player.duration, Math.fround(Math.fround(windowEndMs) / 1000))
        : player.duration;
      const targetSeconds = effectiveNativeSeekTarget(
        Math.min(sourceTimeAt(entry, timelineMs), windowEndMs ?? Infinity) / 1_000,
        (windowEndMs ?? source.durationMs) / 1_000, expectedNativeDuration, Platform.OS,
      );
      player.playbackRate = 1;
      let nativeFramePresented = false;
      if (nativePresentation) {
        const remainingMs = Math.floor(frameDeadline - performance.now());
        if (remainingMs < 1) throw new Error('The video playback window timed out.');
        // Full sources also reprepare after authoritative SDK
        // initialization. Every installation needs its own presentation receipt;
        // cancellation cannot undo the installed item.
        runtime.appliedWindowEndMs = null;
        await configureVideoPlaybackWindow(player, uri, token, windowEndMs, targetSeconds * 1000, remainingMs, preparation.signal);
        if (!mountedRef.current || !surfacesAdmittedRef.current || translationSuspensionRef.current
          || preparation.signal.aborted || token !== runtime.prepareToken || runtime.preparation !== preparation) throw abortError();
        runtime.appliedWindowEndMs = windowEndMs;
        nativeFramePresented = true;
      }
      if (performance.now() >= frameDeadline) throw new Error('The video did not render a frame in time. Try loading it again.');
      player.pause();
      player.muted = true;
      player.playbackRate = 1;
      runtime.renderGate = 'awaitingPosition';
      await waitForPlaybackPosition(player, targetSeconds, preparation.signal, frameDeadline, !nativeFramePresented);
      if (!mountedRef.current || !surfacesAdmittedRef.current || translationSuspensionRef.current
        || preparation.signal.aborted || token !== runtime.prepareToken
        || runtime.preparation !== preparation) throw abortError();
      if (performance.now() >= frameDeadline) throw new Error('The video did not render a frame in time. Try loading it again.');
      if (nativeFramePresented) {
        // Native proved a real frame on this retained SDK view. Re-seeking or
        // rebinding now would discard the sole presentation receipt at EOF.
        runtime.firstFrameReady = true;
      } else {
        // Legacy public frame receipts need a fresh view after the seek ACK.
        runtime.nativeViewEpoch += 1;
        runtime.renderGate = 'awaitingFrame';
        publishSlots();
        await waitForFirstFrame(slot, preparation.signal, frameDeadline);
      }
      if (preparation.signal.aborted || token !== runtime.prepareToken) throw abortError();
      if (performance.now() >= frameDeadline) throw new Error('The video did not render a frame in time. Try loading it again.');
      player.pause();
      if (mask) await mask.commit();
      if (preparation.signal.aborted || token !== runtime.prepareToken) throw abortError();
      runtime.readiness = 'ready';
      runtime.renderGate = 'ready';
      publishSlots();
      return slot;
    } catch (caught) {
      const error = token === runtime.prepareToken ? runtime.preparationError ?? caught : abortError();
      if (token === runtime.prepareToken) {
        runtime.firstFrameReady = false;
        runtime.renderGate = 'disarmed';
        runtime.readiness = isAbortError(error) ? 'cancelled' : 'error';
        // A failed or cancelled replacement must not be reused by URI alone.
        runtime.playbackUri = undefined;
        runtime.appliedWindowEndMs = null;
        runtime.preparingWindowEndMs = undefined;
        player.pause();
        player.muted = true;
        publishSlots();
      }
      throw error;
    } finally {
      preparation.signal.removeEventListener('abort', invalidateCancelledCache);
      mask?.cancel();
      preparation.abort();
      if (runtime.preparation === preparation) runtime.preparation = undefined;
    }
  };

  const prepareSlot = (
    slot: SlotIndex,
    entry: ClipTimelineEntry,
    timelineMs: number,
    forceReload = false,
  ): Promise<SlotIndex> => {
    const runtime = slotRuntimeRef.current[slot];
    const uri = videoPlaybackUri(sourceForEntry(entry));
    if (shouldJoinTimelinePreparation(runtime, entry.clip.id, uri, timelineMs, forceReload, windowEndForEntry(entry))) {
      return runtime.preparationTask!;
    }
    const task = prepareSlotOperation(slot, entry, timelineMs, forceReload);
    runtime.preparationTask = task;
    const clearTask = () => {
      if (runtime.preparationTask === task) runtime.preparationTask = undefined;
    };
    void task.then(clearTask, clearTask);
    return task;
  };

  const applyClipToSlot = (slot: SlotIndex, entry: ClipTimelineEntry, timelineMs: number) => {
    const media = playerForSlot(slot);
    media.playbackRate = entry.clip.playbackRate;
    media.volume = playbackVolume(entry, timelineMs);
    media.muted = entry.clip.muted || media.volume <= 0;
    const windowEndMs = slotRuntimeRef.current[slot].appliedWindowEndMs;
    const timeSeconds = effectiveNativeSeekTarget(
      Math.min(sourceTimeAt(entry, timelineMs), windowEndMs ?? Infinity) / 1_000, (windowEndMs ?? sourceForEntry(entry).durationMs) / 1_000, media.duration, Platform.OS,
    );
    if (shouldApplyTimelineSeek(media.currentTime, timeSeconds)) media.currentTime = timeSeconds;
  };

  const findPreparedSlot = (entry: ClipTimelineEntry): SlotIndex | undefined => {
    const match = slotRuntimeRef.current.findIndex(
      (runtime) => runtime.preparedClipId === entry.clip.id && runtime.firstFrameReady
        && runtime.readiness === 'ready' && !runtime.preparation
        && runtime.playbackUri === videoPlaybackUri(sourceForEntry(entry))
        && runtime.appliedWindowEndMs === windowEndForEntry(entry),
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
    if (canContinueTimelineClip(entry, next) && windowEndForEntry(entry) === windowEndForEntry(next)
      && slotRuntimeRef.current[occupiedSlot].appliedWindowEndMs === windowEndForEntry(next)) return;
    const standby = (occupiedSlot === 0 ? 1 : 0) as SlotIndex;
    const generation = generationRef.current;
    const entryIndex = entriesRef.current.findIndex((candidate) => candidate.clip.id === entry.clip.id);
    const previous = entryIndex > 0 ? entriesRef.current[entryIndex - 1] : undefined;
    const visibleTransitionEndMs = previous
      ? transitionWindowsRef.current.find(window => window.outgoing?.clipId === previous.clip.id
        && window.incoming?.clipId === entry.clip.id)?.endMs
        ?? entry.startMs + previous.clip.transitionAfter.durationMs / 2
      : entry.startMs;
    const timelineDelayMs = Math.max(0, visibleTransitionEndMs - timelineMs);
    if (timelineDelayMs > 0 && !playIntentRef.current) return;
    const prepare = () => {
      preloadTimeoutRef.current = undefined;
      pendingPreloadRef.current = undefined;
      if (!mountedRef.current || !surfacesAdmittedRef.current || generation !== generationRef.current
        || activeSlotRef.current !== occupiedSlot || activeClipIdRef.current !== entry.clip.id) return;
      // The mutable transport ref advances before React commits the retained
      // pair's z-order. Keep the outgoing decoder intact through that commit,
      // including any still-rendered transition tail. The timer above only
      // schedules timeline work; it is not a presentation acknowledgement.
      const committed = committedPreviewRef.current;
      if (committed.activeSlot !== occupiedSlot || committed.timelineMs < visibleTransitionEndMs) {
        pendingPreloadRef.current = prepare;
        return;
      }
      const runtime = slotRuntimeRef.current[standby];
      if (runtime.preparedClipId === next.clip.id
        && runtime.playbackUri === videoPlaybackUri(sourceForEntry(next))
        && (runtime.readiness === 'preparing' ? runtime.preparingWindowEndMs : runtime.appliedWindowEndMs) === windowEndForEntry(next)
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
      previous, entry, runtime, videoPlaybackUri(source), player, timelineMs, windowEndForEntry(entry),
    )) return false;
    runtime.preparedClipId = entry.clip.id;
    activeClipIdRef.current = entry.clip.id;
    boundaryClipIdRef.current = undefined;
    player.playbackRate = entry.clip.playbackRate;
    player.volume = playbackVolume(entry, entry.startMs);
    player.muted = entry.clip.muted || player.volume <= 0;
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
    compositeClockRef.current = undefined;
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
      else if (pendingOrdinaryRestoreRef.current && !compositeClockRef.current) retireComposite();
    });
    processingRef.current = operation;
    return operation;
  }

  useLayoutEffect(() => {
    drainTargetsRef.current = drainTargets;
  });

  const requestTarget = (timelineMs: number) => {
    compositeClockRef.current = undefined;
    players.forEach(player => { player.muted = true; player.volume = 0; });
    cancelScheduledPreload();
    const targetMs = clamp(timelineMs, 0, projectTimelineDuration(projectRef.current));
    const segment = projectTimelineSegmentAt(projectRef.current, targetMs, entriesRef.current);
    const clipId = segment?.kind === 'clip' ? segment.entry.clip.id : undefined;
    abortPreparationsExcept(clipId);
    if (segment?.kind === 'clip') {
      try {
        for (const runtime of slotRuntimeRef.current) {
          if (runtime.preparation && runtime.preparedClipId === clipId
            && (runtime.playbackUri !== videoPlaybackUri(sourceForEntry(segment.entry))
              || runtime.preparingWindowEndMs !== windowEndForEntry(segment.entry))) runtime.preparation.abort();
        }
      } catch {
        // Retire unsafe in-flight work now. The target drain reports invalid
        // source/window data through the existing actionable failure path.
        abortPreparationsExcept();
      }
    }
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
    transitionWindowsRef.current = buildVideoTransitionPreviewWindows(entriesRef.current, nextProject.sources);
    requestTargetRef.current(clamp(currentMsRef.current, 0, projectTimelineDuration(nextProject)));
  }, []);

  const advanceFrom = (entry: ClipTimelineEntry) => {
    if (!playIntentRef.current || boundaryClipIdRef.current === entry.clip.id) return;
    boundaryClipIdRef.current = entry.clip.id;
    const next = nextEntryAfter(entry);
    const gapEndMs = next?.startMs ?? (entry.afterGapEndMs > entry.endMs
      ? projectTimelineDuration(projectRef.current) : entry.endMs);
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
    const compositeClock = compositeClockRef.current;
    const runtime = slotRuntimeRef.current[slot];
    const synchronizedWindowKey = compositeClock?.slot === slot
      && compositeClock.prepareToken === runtime.prepareToken
      && runtime.readiness === 'ready' && runtime.preparedClipId === entry.clip.id
      ? compositeClock.key : undefined;
    const transitionMs = transitionTimelineTimeAt(
      transitionWindowsRef.current, entry.clip.id, currentMsRef.current, sourceMs, synchronizedWindowKey,
    );
    const window = synchronizedWindowKey
      ? transitionWindowsRef.current.find(candidate => candidate.key === synchronizedWindowKey) : undefined;
    if (transitionMs != null && window) {
      let ownerSlot = slot;
      let ownerEntry = entry;
      if (window.outgoing?.clipId === entry.clip.id && transitionMs >= window.boundaryMs) {
        const next = nextEntryAfter(entry);
        const incomingSlot = next && window.incoming?.clipId === next.clip.id ? findPreparedSlot(next) : undefined;
        if (!next || incomingSlot == null || incomingSlot === slot) {
          // Lost readiness retires composite authority; normal activation keeps
          // its existing preparation, generation and cancellation checks.
          compositeClockRef.current = undefined;
          advanceFrom(entry);
          return;
        }
        // Both decoders already follow this composite. Transfer transport
        // ownership without ordinary activation pausing or re-seeking either leg.
        setActiveSlot(incomingSlot);
        activeClipIdRef.current = next.clip.id;
        boundaryClipIdRef.current = undefined;
        compositeClockRef.current = { key: window.key, slot: incomingSlot,
          prepareToken: slotRuntimeRef.current[incomingSlot].prepareToken };
        ownerSlot = incomingSlot;
        ownerEntry = next;
        preloadNext(next, incomingSlot, transitionMs);
      }
      setCurrentMs(transitionMs);
      // Update both gains on the authoritative source clock before React's next
      // commit. The active slot owns transport only, never exclusive audio.
      slotRuntimeRef.current.forEach((leg, index) => {
        const legEntry = entriesRef.current.find(candidate => candidate.clip.id === leg.preparedClipId);
        const player = playerForSlot(index as SlotIndex);
        const audible = legEntry && leg.readiness === 'ready' && leg.firstFrameReady
          && surfacesAdmittedRef.current && playIntentRef.current
          && (window.outgoing?.clipId === legEntry.clip.id || window.incoming?.clipId === legEntry.clip.id);
        player.volume = audible ? transitionClipPlaybackVolume(legEntry, transitionMs, window) : 0;
        player.muted = !audible || player.volume <= 0;
      });
      if (transitionMs >= window.endMs) {
        compositeClockRef.current = undefined;
        // A no-handle leg may have a different rate/source clock. Restore the
        // ordinary clip clock once, after its last visible composite sample.
        applyClipToSlot(ownerSlot, ownerEntry, transitionMs);
      }
      return;
    }
    const timelineMs = clamp(timelineTimeAt(entry, sourceMs), entry.startMs, entry.endMs);
    // A sample queued before a source-clock rebase must not rewind playback.
    // Explicit backward seeks establish their new position through requestTarget.
    if (timelineMs < currentMsRef.current) return;
    setCurrentMs(timelineMs);
    playerForSlot(slot).volume = playbackVolume(entry, timelineMs);
    playerForSlot(slot).muted = entry.clip.muted || playerForSlot(slot).volume <= 0;
    if (timelineMs >= entry.endMs - tolerance) advanceFrom(entry);
  };

  const onPlayToEnd = (slot: SlotIndex) => {
    if (slot !== activeSlotRef.current || processingRef.current || phaseRef.current !== 'ready') return;
    const entry = entriesRef.current.find((candidate) => candidate.clip.id === activeClipIdRef.current);
    if (entry) advanceFrom(entry);
  };

  const onPlayingChange = (slot: SlotIndex, nativePlaying: boolean) => {
    if (slot !== activeSlotRef.current || nativePlaying || !playIntentRef.current) return;
    if (processingRef.current || phaseRef.current !== 'ready') return;
    const clock = compositeClockRef.current;
    if (clock?.slot === slot && clock.prepareToken === slotRuntimeRef.current[slot].prepareToken) {
      // A temporary decoder stop is not an ordinary trim-end acknowledgement
      // while this player is running the composite's source clock.
      playerForSlot(slot).play();
      return;
    }
    const entry = entriesRef.current.find((candidate) => candidate.clip.id === activeClipIdRef.current);
    if (entry && playerForSlot(slot).currentTime * 1_000 >= entry.clip.sourceEndMs - 200) advanceFrom(entry);
    else playerForSlot(slot).play();
  };

  const onStatusChange = (slot: SlotIndex, status: string, error: unknown) => {
    if (status !== 'error') return;
    if (compositeClockRef.current) {
      players.forEach(player => { player.muted = true; player.volume = 0; player.pause(); });
    }
    const runtime = slotRuntimeRef.current[slot];
    if (runtime.preparation) {
      runtime.preparationError = error instanceof Error ? error : new Error(
        typeof error === 'object' && error && 'message' in error ? String(error.message) : 'The video could not be loaded.',
      );
      runtime.preparation.abort();
      return;
    }
    if (runtime.readiness !== 'ready') return;
    compositeClockRef.current = undefined;
    const ownsPlayback = slot === activeSlotRef.current && runtime.preparedClipId === activeClipIdRef.current;
    runtime.readiness = 'error';
    runtime.renderGate = 'disarmed';
    runtime.firstFrameReady = false;
    runtime.playbackUri = undefined;
    runtime.appliedWindowEndMs = null;
    runtime.preparingWindowEndMs = undefined;
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
    const maskRequestIds = maskRequestIdsRef.current;
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
      retireSurfaceFrames();
      if (Platform.OS === 'android') players.forEach((player, slot) =>
        disposeVideoMaskLease(player, maskRequestIds[slot]));
      cancelGapClock();
      cancelScheduledPreload();
    };
  }, [players, retireSurfaceFrames]);

  useLayoutEffect(() => {
    if (!surfacesAdmitted || translationSuspensionRef.current) {
      generationRef.current += 1;
      desiredRef.current = undefined;
      retireSurfaceFrames();
      stopTransport();
      setPhase('suspended');
    } else if (phaseRef.current === 'suspended') {
      requestTargetRef.current(currentMsRef.current);
    }
  }, [retireSurfaceFrames, surfacesAdmitted, stopTransport]);

  useEffect(() => {
    // This hook and VideoTransitionOverlay consume the same editor render.
    // Passive effects establish JS commit ordering only: Fabric may not yet
    // have presented the native z-order on Android's main looper. Device proof
    // is still required before claiming native presentation retirement.
    committedPreviewRef.current = { activeSlot, timelineMs: currentMs };
    pendingPreloadRef.current?.();
  });

  return {
    player: players[activeSlot],
    players,
    slots,
    activeSlot,
    markFirstFrame,
    retireComposite,
    setCompositeClock: (clock?: CompositeClock) => {
      compositeClockRef.current = clock;
      if (clock) pendingOrdinaryRestoreRef.current = false;
    },
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

function waitForSourceMutation(task: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(abortError());
    const timeout = setTimeout(() => finish(new Error('The previous SDK replacement has not finished.')), 15000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void task.then(() => finish(), () => finish());
  });
}

function nextPrepareToken(previous: number) {
  if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER) {
    throw new Error('The video preparation request identity was exhausted.');
  }
  return previous + 1;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
