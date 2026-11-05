import { useEffect } from 'react';
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

  useEffect(() => {
    configureOverlayPlayer(player, layer.includeAudio, layer.playbackRate);
  }, [layer.includeAudio, layer.playbackRate, player]);

  useEffect(() => {
    seekOverlayPlayer(player, state.seconds, state.playing);
  }, [player, state.playing, state.seconds]);

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
      <VideoView player={player} nativeControls={false} contentFit="contain" surfaceType="textureView" style={{ width: '100%', height: '100%' }} />
    </View>
  </View>;
}
