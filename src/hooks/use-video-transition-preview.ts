import { useVideoPlayer } from 'expo-video';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  buildVideoTransitionPreviewWindows,
  videoTransitionPreloadWindow,
  videoTransitionPreviewFrameAt,
} from '@/lib/video-transition-preview';
import type { ClipTimelineEntry } from '@/lib/video-timeline';
import { configureTransitionPlayer } from '@/lib/video-playback-policy';
import type { ProjectVideoSource } from '@/types/project';

type PreviewPlayerLoad = {
  key?: string;
  state: 'idle' | 'ready' | 'error';
  error?: string;
};

export function useVideoTransitionPreview(options: {
  entries: readonly ClipTimelineEntry[];
  sources: readonly ProjectVideoSource[];
  timelineMs: number;
  isPlaying: boolean;
}) {
  const windows = useMemo(
    () => buildVideoTransitionPreviewWindows(options.entries, options.sources),
    [options.entries, options.sources],
  );
  const frame = useMemo(
    () => videoTransitionPreviewFrameAt(windows, options.timelineMs),
    [options.timelineMs, windows],
  );
  const preload = useMemo(
    () => {
      const candidate = videoTransitionPreloadWindow(windows, options.timelineMs);
      return candidate?.mode === 'composite' ? candidate : undefined;
    },
    [options.timelineMs, windows],
  );
  const outgoingPlayer = useVideoPlayer(null, configureTransitionPlayer);
  const incomingPlayer = useVideoPlayer(null, configureTransitionPlayer);
  const [load, setLoad] = useState<PreviewPlayerLoad>({ state: 'idle' });
  const loadedUrisRef = useRef<{ outgoing?: string; incoming?: string }>({});
  const loadingKeyRef = useRef<string | undefined>(undefined);
  const generationRef = useRef(0);

  useEffect(() => {
    if (!preload?.outgoing || !preload.incoming) {
      outgoingPlayer.pause();
      incomingPlayer.pause();
      return;
    }
    if (load.key === preload.key || loadingKeyRef.current === preload.key) return;
    const generation = ++generationRef.current;
    let cancelled = false;
    loadingKeyRef.current = preload.key;
    outgoingPlayer.pause();
    incomingPlayer.pause();
    void loadPreviewPair({
      outgoingPlayer,
      incomingPlayer,
      outgoingUri: preload.outgoing.uri,
      incomingUri: preload.incoming.uri,
      loadedUris: loadedUrisRef.current,
      shouldContinue: () => !cancelled && generation === generationRef.current,
    }).then(() => {
      if (cancelled || generation !== generationRef.current) return;
      loadingKeyRef.current = undefined;
      setLoad({ key: preload.key, state: 'ready' });
    }).catch((caught) => {
      if (cancelled || generation !== generationRef.current) return;
      loadingKeyRef.current = undefined;
      setLoad({
        key: preload.key,
        state: 'error',
        error: caught instanceof Error ? caught.message : 'The transition preview videos could not be decoded.',
      });
    });
    return () => {
      cancelled = true;
    };
  }, [incomingPlayer, load.key, outgoingPlayer, preload]);

  const loadedKey = load.state === 'ready' ? load.key : undefined;
  const state = !preload ? 'idle' : load.key === preload.key ? load.state : 'loading';
  const error = state === 'error' ? load.error : undefined;

  useEffect(() => {
    if (
      !frame
      || !frame.outgoing
      || !frame.incoming
      || frame.outgoingSourceTimeMs == null
      || frame.incomingSourceTimeMs == null
      || state !== 'ready'
      || loadedKey !== frame.key
    ) {
      outgoingPlayer.pause();
      incomingPlayer.pause();
      return;
    }
    synchronizePreviewPlayer(
      outgoingPlayer,
      frame.outgoingSourceTimeMs,
      frame.outgoing.playbackRate,
      options.isPlaying,
    );
    synchronizePreviewPlayer(
      incomingPlayer,
      frame.incomingSourceTimeMs,
      frame.incoming.playbackRate,
      options.isPlaying,
    );
  }, [frame, incomingPlayer, loadedKey, options.isPlaying, outgoingPlayer, state]);

  useEffect(() => () => {
    generationRef.current += 1;
    loadingKeyRef.current = undefined;
    loadedUrisRef.current = {};
  }, []);

  return {
    frame,
    outgoingPlayer,
    incomingPlayer,
    ready: Boolean(frame && state === 'ready' && loadedKey === frame.key),
    state,
    error,
  };
}

async function loadPreviewPair(options: {
  outgoingPlayer: ReturnType<typeof useVideoPlayer>;
  incomingPlayer: ReturnType<typeof useVideoPlayer>;
  outgoingUri: string;
  incomingUri: string;
  loadedUris: { outgoing?: string; incoming?: string };
  shouldContinue: () => boolean;
}) {
  if (options.loadedUris.outgoing !== options.outgoingUri) {
    await options.outgoingPlayer.replaceAsync(options.outgoingUri);
    if (!options.shouldContinue()) return;
    options.loadedUris.outgoing = options.outgoingUri;
  }
  if (!options.shouldContinue()) return;
  if (options.loadedUris.incoming !== options.incomingUri) {
    await options.incomingPlayer.replaceAsync(options.incomingUri);
    if (!options.shouldContinue()) return;
    options.loadedUris.incoming = options.incomingUri;
  }
}

function synchronizePreviewPlayer(
  player: ReturnType<typeof useVideoPlayer>,
  targetMs: number,
  playbackRate: number,
  playing: boolean,
) {
  player.muted = true;
  player.volume = 0;
  player.playbackRate = playbackRate;
  const targetSeconds = targetMs / 1_000;
  const driftMs = Math.abs(player.currentTime - targetSeconds) * 1_000;
  if (!playing || driftMs > 90) player.currentTime = targetSeconds;
  if (playing) {
    if (!player.playing) player.play();
  } else {
    player.pause();
  }
}
