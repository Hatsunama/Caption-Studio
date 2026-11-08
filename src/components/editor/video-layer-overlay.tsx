import { useCallback, useEffect, useRef } from 'react';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import { View } from 'react-native';
import { resolveLayerGeometry, type LayerGeometryInput } from '@/lib/layer-geometry';
import { overlayPlaybackState } from '@/lib/video-overlay-playback';
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
};

export function VideoLayerOverlay(props: VideoLayerOverlayProps) {
  // Unmount the child so expo-video releases its decoder before translation loads.
  return props.suspended ? null : <MountedVideoLayerOverlay {...props} />;
}

function MountedVideoLayerOverlay(props: VideoLayerOverlayProps) {
  const { layer, timelineMs, isPlaying } = props;
  const player = useVideoPlayer(layer.uri, (created) => configureOverlayPlayer(created, layer.includeAudio, layer.playbackRate));
  const state = overlayPlaybackState(layer, timelineMs, isPlaying, props.clips);
  const geometry = resolveLayerGeometry(props.geometry ?? layer);
  // PRIVATE numeric-only observation; never merge or publish this diagnostic branch.
  // CSOverlayEvent CSV: event,row,monotonic,targetSeconds,desiredPlaying,extra1,extra2.
  // monotonic is performance.now() in ms; targetSeconds/desiredPlaying are desired state,
  // not a native clock or proof of presented pixels. Nonfinite/nonnumeric cells become -1.
  // 1/9 = subscription setup/cleanup (may repeat; not component mount/unmount markers).
  // 2/3 = before/after existing seek call; 4 = delivered status index in extra1
  // (idle=0, loading=1, readyToPlay=2, error=3, unknown=-1); 5 = delivered duration in extra1.
  // 6 = first-frame callback notification; 7 = nativeEvent.layout width/height in extras
  // (React Native box, not SDK surface dimensions). Unused extras are 0.
  // Neither READY, first-frame notification nor layout proves pixels survived a resume.
  const probeRows = useRef(0);
  const probe = useCallback((event: number, extra1 = 0, extra2 = 0) => {
    try {
      if (probeRows.current >= 120) return;
      const values = [event, ++probeRows.current, performance.now(), state.seconds,
        Number(state.playing), extra1, extra2];
      console.info('CSOverlayEvent', values.map(value => Number.isFinite(value) ? value : -1).join(','));
    } catch { /* Observation must not affect resource ownership. */ }
  }, [state.playing, state.seconds]);

  useEffect(() => {
    probe(1);
    const status = player.addListener('statusChange', ({ status }) => probe(4, ['idle', 'loading', 'readyToPlay', 'error'].indexOf(status)));
    const source = player.addListener('sourceLoad', ({ duration }) => probe(5, duration));
    return () => { probe(9); status.remove(); source.remove(); };
  }, [player, probe]);

  useEffect(() => {
    configureOverlayPlayer(player, layer.includeAudio, layer.playbackRate);
  }, [layer.includeAudio, layer.playbackRate, player]);

  useEffect(() => {
    probe(2);
    seekOverlayPlayer(player, state.seconds, state.playing);
    probe(3);
  }, [player, state.playing, state.seconds, probe]);

  useEffect(() => {
    if (state.playing) player.play();
    else player.pause();
  }, [player, state.playing]);

  return <View pointerEvents="none" collapsable={false} style={{ position: 'absolute', inset: 0 }}>
    <View pointerEvents="none" style={{ position: 'absolute',
      left: `${(geometry.position.x - geometry.box.width / 2) * 100}%`, top: `${(geometry.position.y - geometry.box.height / 2) * 100}%`,
      width: `${geometry.box.width * 100}%`, height: `${geometry.box.height * 100}%`,
      opacity: layer.opacity,
      transform: [{ rotate: `${geometry.rotation}deg` }, { scaleX: geometry.scale * geometry.scaleX }, { scaleY: geometry.scale * geometry.scaleY }],
    }}>
      <VideoView player={player} nativeControls={false} contentFit="contain" surfaceType="textureView" onFirstFrameRender={() => probe(6)} onLayout={({ nativeEvent: { layout } }) => probe(7, layout.width, layout.height)} style={{ width: '100%', height: '100%' }} />
    </View>
  </View>;
}
