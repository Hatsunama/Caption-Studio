import { useVideoPlayer } from 'expo-video';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  buildVideoTransitionPreviewWindows,
  videoTransitionPreloadWindow,
  videoTransitionPreviewFrameAt,
} from '@/lib/video-transition-preview';
import type { ClipTimelineEntry } from '@/lib/video-timeline';
import type { ProjectVideoSource } from '@/types/project';

type PreviewPlayerLoad = {
  key?: string;
  state: 'ready' | 'error';
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
  const outgoingPlayer = useVideoPlayer(null, configurePreviewPlayer);
  const incomingPlayer = useVideoPlayer(null, configurePreviewPlayer);
  const [load, setLoad] = useState<PreviewPlayerLoad>({ state: 'error' });
  const loadedUrisRef = useRef<{ outgoing?: string; incoming?: string }>({});
  const generationRef = useRef(0);

  useEffect(() => {
    if (!preload?.outgoing || !preload.incoming) {
      outgoingPlayer.pause();
      incomingPlayer.pause();
      return;
    }
    if (load.key === preload.key) return;
    const generation = ++generationRef.current;
    let cancelled = false;
    outgoingPlayer.pause();
    incomingPlayer.pause();
    const loadOutgoing = loadedUrisRef.current.outgoing === preload.outgoing.uri
      ? Promise.resolve()
      : outgoingPlayer.replaceAsync(preload.outgoing.uri).then(() => {
        loadedUrisRef.current.outgoing = preload.outgoing?.uri;
      });
    const loadIncoming = loadedUrisRef.current.incoming === preload.incoming.uri
      ? Promise.resolve()
      : incomingPlayer.replaceAsync(preload.incoming.uri).then(() => {
        loadedUrisRef.current.incoming = preload.incoming?.uri;
      });
    void Promise.all([loadOutgoing, loadIncoming]).then(() => {
      if (cancelled || generation !== generationRef.current) return;
      setLoad({ key: preload.key, state: 'ready' });
    }).catch((caught) => {
      if (cancelled || generation !== generationRef.current) return;
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
    outgoingPlayer.pause();
    incomingPlayer.pause();
  }, [incomingPlayer, outgoingPlayer]);

  return {
    frame,
    outgoingPlayer,
    incomingPlayer,
    ready: Boolean(frame && state === 'ready' && loadedKey === frame.key),
    state,
    error,
  };
}

function configurePreviewPlayer(player: ReturnType<typeof useVideoPlayer>) {
  player.loop = false;
  player.muted = true;
  player.volume = 0;
  player.timeUpdateEventInterval = 0.05;
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
