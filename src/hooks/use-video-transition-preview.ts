import { useVideoPlayer } from 'expo-video';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  videoTransitionPreloadWindow,
  videoTransitionPreviewFrameAt,
  type VideoTransitionPreviewWindow,
} from '@/lib/video-transition-preview';
import { configureTransitionPlayer } from '@/lib/video-playback-policy';

type PreviewPlayerLoad = {
  key?: string;
  state: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
};

export function useVideoTransitionPreview(options: {
  windows: readonly VideoTransitionPreviewWindow[];
  timelineMs: number;
  isPlaying: boolean;
}) {
  const frame = useMemo(
    () => videoTransitionPreviewFrameAt(options.windows, options.timelineMs),
    [options.timelineMs, options.windows],
  );
  const preload = useMemo(
    () => {
      const candidate = videoTransitionPreloadWindow(options.windows, options.timelineMs);
      return candidate?.mode === 'composite' ? candidate : undefined;
    },
    [options.timelineMs, options.windows],
  );
  const outgoingPlayer = useVideoPlayer(null, configureTransitionPlayer);
  const incomingPlayer = useVideoPlayer(null, configureTransitionPlayer);
  const [load, setLoad] = useState<PreviewPlayerLoad>({ state: 'idle' });
  const loadedUrisRef = useRef<{ outgoing?: string; incoming?: string }>({});
  const desiredRef = useRef<typeof preload>(undefined);
  const drainingRef = useRef(false);
  const mountedRef = useRef(true);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    desiredRef.current = preload;
    if (!preload?.outgoing || !preload.incoming) {
      outgoingPlayer.pause();
      incomingPlayer.pause();
      return;
    }
    if (loadRef.current.key === preload.key && loadRef.current.state === 'ready') return;
    if (drainingRef.current) return;
    drainingRef.current = true;
    void (async () => {
      try {
        while (mountedRef.current) {
          const desired = desiredRef.current;
          if (!desired?.outgoing || !desired.incoming) return;
          if (loadRef.current.key === desired.key && loadRef.current.state === 'ready') return;
          outgoingPlayer.pause();
          incomingPlayer.pause();
          setLoad({ key: desired.key, state: 'loading' });
          try {
            await loadPreviewPair({
              outgoingPlayer,
              incomingPlayer,
              outgoingUri: desired.outgoing.uri,
              incomingUri: desired.incoming.uri,
              loadedUris: loadedUrisRef.current,
            });
          } catch (caught) {
            if (desiredRef.current?.key !== desired.key) continue;
            setLoad({
              key: desired.key,
              state: 'error',
              error: caught instanceof Error ? caught.message : 'The transition preview videos could not be decoded.',
            });
            return;
          }
          if (desiredRef.current?.key !== desired.key) continue;
          setLoad({ key: desired.key, state: 'ready' });
          return;
        }
      } finally {
        drainingRef.current = false;
      }
    })();
  }, [incomingPlayer, outgoingPlayer, preload]);

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
    mountedRef.current = false;
    desiredRef.current = undefined;
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
}) {
  if (options.loadedUris.outgoing !== options.outgoingUri) {
    await options.outgoingPlayer.replaceAsync(options.outgoingUri);
    options.loadedUris.outgoing = options.outgoingUri;
  }
  if (options.loadedUris.incoming !== options.incomingUri) {
    await options.incomingPlayer.replaceAsync(options.incomingUri);
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
