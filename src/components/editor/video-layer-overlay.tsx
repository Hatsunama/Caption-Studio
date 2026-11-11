import { useLayoutEffect, useRef } from 'react';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import { Platform, View } from 'react-native';
import { resolveLayerGeometry, type LayerGeometryInput } from '@/lib/layer-geometry';
import { overlayPlaybackState } from '@/lib/video-overlay-playback';
import { effectiveNativeSeekTarget } from '@/lib/video-playback-position';
import { configureVideoPlaybackWindow } from '@/services/video-playback-window';
import type { VideoClip, VideoVisualLayer } from '@/types/project';

function configureOverlayPlayer(player: VideoPlayer, includeAudio: boolean, playbackRate: number) {
  player.muted = !includeAudio;
  player.playbackRate = playbackRate;
}

function seekOverlayPlayer(player: VideoPlayer, seconds: number, playing: boolean) {
  if (Math.abs(player.currentTime - seconds) > (playing ? 0.25 : 0.04)) player.currentTime = seconds;
}

type VideoLayerOverlayProps = {
  layer: VideoVisualLayer;
  clips: VideoClip[];
  geometry?: LayerGeometryInput;
  timelineMs: number;
  isPlaying: boolean;
  suspended: boolean;
  onError?: (message: string) => void;
};

export function VideoLayerOverlay(props: VideoLayerOverlayProps) {
  // Unmount the child so expo-video releases its decoder before translation loads.
  return props.suspended ? null : <MountedVideoLayerOverlay {...props} />;
}

function MountedVideoLayerOverlay(props: VideoLayerOverlayProps) {
  const { layer, timelineMs, isPlaying } = props;
  const player = useVideoPlayer(layer.uri, (created) => {
    // Source preparation must never acquire playback/audio intent.
    created.muted = true;
    created.pause();
  });
  const state = overlayPlaybackState(layer, timelineMs, isPlaying, props.clips);
  const geometry = resolveLayerGeometry(props.geometry ?? layer);
  const desired = useRef({ state, layer, onError: props.onError });
  const synchronize = useRef(() => {});
  const requestId = useRef(0);

  // Async completions read committed props, never a captured clock/play intent
  // or a render that React might abandon.
  useLayoutEffect(() => { desired.current = { state, layer, onError: props.onError }; });

  useLayoutEffect(() => {
    let retired = false, failed = false, sourceReady = false;
    let presented = Platform.OS !== 'android', pending = false;
    let preparation: AbortController | undefined;
    const quiet = () => { player.pause(); player.muted = true; };
    const fail = () => {
      if (retired || failed) return;
      failed = true;
      preparation?.abort();
      quiet();
      console.warn('Video overlay preparation failed');
      desired.current.onError?.('A picture-in-picture video preview could not be prepared.');
    };
    const targetSeconds = () => effectiveNativeSeekTarget(
      desired.current.state.seconds,
      desired.current.layer.sourceDurationMs == null ? player.duration : desired.current.layer.sourceDurationMs / 1000,
      player.duration, Platform.OS,
    );
    const sync = () => {
      try {
        if (retired || failed || !sourceReady || pending) return;
        if (presented) {
          const latest = desired.current;
          if (!latest.state.playing) player.pause();
          configureOverlayPlayer(player, latest.layer.includeAudio, latest.layer.playbackRate);
          seekOverlayPlayer(player, targetSeconds(), latest.state.playing);
          if (latest.state.playing) player.play();
          return;
        }
        // Expo's queued constructor prepare/seek and READY do not prove a frame
        // on this view, including target zero. Reuse the main preview's paused,
        // source/view-owned Android presentation contract with an unclipped item.
        quiet();
        const target = targetSeconds();
        const operation = new AbortController();
        preparation = operation;
        pending = true;
        void configureVideoPlaybackWindow(player, layer.uri, ++requestId.current, undefined,
          target * 1000, 5000, operation.signal).then(() => {
          if (retired || failed || operation.signal.aborted) return;
          pending = false;
          // A paused timeline can change while native decoding is pending. Its
          // old receipt must not authorize the new target; prepare that target.
          presented = desired.current.state.playing || targetSeconds() === target;
          sync();
        }).catch(fail);
      } catch {
        fail();
      }
    };
    synchronize.current = sync;
    const subscription = player.addListener('statusChange', ({ status }) => {
      if (retired || failed) return;
      if (status === 'error') fail();
      else if (status === 'readyToPlay') { sourceReady = true; sync(); }
    });
    // Subscribe before reading: a fast constructor load may have completed
    // before the component committed. Native reprepare can emit READY again.
    if (player.status === 'error') fail();
    else if (player.status === 'readyToPlay') { sourceReady = true; sync(); }
    return () => {
      retired = true;
      synchronize.current = () => {};
      preparation?.abort();
      subscription.remove();
      quiet();
    };
  }, [player, layer.uri]);

  useLayoutEffect(() => {
    synchronize.current();
  }, [layer.includeAudio, layer.playbackRate, layer.sourceDurationMs, player, state.playing, state.seconds]);

  return <View pointerEvents="none" collapsable={false} style={{ position: 'absolute', inset: 0 }}>
    <View pointerEvents="none" style={{ position: 'absolute',
      left: `${(geometry.position.x - geometry.box.width / 2) * 100}%`, top: `${(geometry.position.y - geometry.box.height / 2) * 100}%`,
      width: `${geometry.box.width * 100}%`, height: `${geometry.box.height * 100}%`,
      opacity: layer.opacity,
      transform: [{ rotate: `${geometry.rotation}deg` }, { scaleX: geometry.scale * geometry.scaleX }, { scaleY: geometry.scale * geometry.scaleY }],
    }}>
      <VideoView player={player} nativeControls={false} contentFit="contain" surfaceType="textureView" style={{ width: '100%', height: '100%' }} />
    </View>
  </View>;
}
