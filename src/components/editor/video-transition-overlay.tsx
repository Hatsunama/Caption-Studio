import { VideoView, type VideoPlayer } from 'expo-video';
import { useMemo, useState } from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { useVideoTransitionPreview } from '@/hooks/use-video-transition-preview';
import {
  buildVideoTransitionPreviewWindows,
  videoTransitionPreloadWindow,
  videoTransitionPreviewFrameAt,
  type VideoTransitionPreviewFrame,
} from '@/lib/video-transition-preview';
import type { ClipTimelineEntry } from '@/lib/video-timeline';
import type { ProjectVideoSource, VideoTransform } from '@/types/project';
import { chrome } from '@/lib/ui-theme';

type Props = {
  entries: readonly ClipTimelineEntry[];
  sources: readonly ProjectVideoSource[];
  timelineMs: number;
  isPlaying: boolean;
  transportReady: boolean;
  width: number;
  height: number;
  backgroundColor: string;
  admitted: boolean;
};

const fill: ViewStyle = { position: 'absolute', inset: 0 };

export function VideoTransitionOverlay(props: Props) {
  const windows = useMemo(
    () => buildVideoTransitionPreviewWindows(props.entries, props.sources),
    [props.entries, props.sources],
  );
  const frame = useMemo(
    () => videoTransitionPreviewFrameAt(windows, props.timelineMs),
    [props.timelineMs, windows],
  );
  const preload = videoTransitionPreloadWindow(windows, props.timelineMs);

  if (!props.admitted) return null;
  if (frame?.mode === 'cover') return <CoverTransition frame={frame} width={props.width} height={props.height} />;
  if (frame?.unavailableReason) return <PreviewNotice label="TRANSITION PREVIEW UNAVAILABLE" detail={frame.unavailableReason} />;
  if (preload?.mode !== 'composite') return null;

  return <CompositeVideoTransitionOverlay {...props} windows={windows} />;
}

function CompositeVideoTransitionOverlay(props: Props & { windows: ReturnType<typeof buildVideoTransitionPreviewWindows> }) {
  const preview = useVideoTransitionPreview({
    windows: props.windows,
    timelineMs: props.timelineMs,
    isPlaying: props.isPlaying && props.transportReady,
  });
  const frame = preview.frame;
  const renderFrame = preview.renderFrame;
  if (!renderFrame) return null;

  if (preview.error && frame) return <PreviewNotice label="TRANSITION PREVIEW UNAVAILABLE" detail={preview.error} />;

  return <FirstFrameGatedTransition key={renderFrame.key} {...props} active={Boolean(frame)} frame={renderFrame} preview={preview} />;
}

function FirstFrameGatedTransition(props: Props & {
  active: boolean;
  frame: VideoTransitionPreviewFrame;
  preview: ReturnType<typeof useVideoTransitionPreview>;
}) {
  const [rendered, setRendered] = useState({ outgoing: false, incoming: false });
  const ready = rendered.outgoing && rendered.incoming;
  return (
    <View pointerEvents="none" style={[fill, { overflow: 'hidden' }]}>
      <View key={props.frame.key} style={[fill, { opacity: props.active && ready ? 1 : 0 }]}>
        <CompositeTransition
          frame={props.frame}
          outgoingPlayer={props.preview.outgoingPlayer}
          incomingPlayer={props.preview.incomingPlayer}
          width={props.width}
          height={props.height}
          onOutgoingFirstFrame={() => setRendered((current) => ({ ...current, outgoing: true }))}
          onIncomingFirstFrame={() => setRendered((current) => ({ ...current, incoming: true }))}
        />
      </View>
    </View>
  );
}

function CompositeTransition(props: {
  frame: VideoTransitionPreviewFrame;
  outgoingPlayer: VideoPlayer;
  incomingPlayer: VideoPlayer;
  width: number;
  height: number;
  onOutgoingFirstFrame: () => void;
  onIncomingFirstFrame: () => void;
}) {
  const { frame, outgoingPlayer, incomingPlayer, width, height, onOutgoingFirstFrame, onIncomingFirstFrame } = props;
  const outgoing = frame.outgoing!;
  const incoming = frame.incoming!;
  const phase = frame.phase;
  const type = frame.type;

  if (type.startsWith('push-')) {
    const horizontal = type.endsWith('left') || type.endsWith('right');
    const sign = type.endsWith('left') || type.endsWith('up') ? -1 : 1;
    const distance = horizontal ? width : height;
    return (
      <>
        <VideoLayer player={outgoingPlayer} transform={outgoing.transform} width={width} height={height} onFirstFrameRender={onOutgoingFirstFrame} effectStyle={{ transform: horizontal ? [{ translateX: sign * distance * phase }] : [{ translateY: sign * distance * phase }] }} />
        <VideoLayer player={incomingPlayer} transform={incoming.transform} width={width} height={height} onFirstFrameRender={onIncomingFirstFrame} effectStyle={{ transform: horizontal ? [{ translateX: -sign * distance * (1 - phase) }] : [{ translateY: -sign * distance * (1 - phase) }] }} />
      </>
    );
  }


  if (type === 'split-horizontal' || type === 'split-vertical') {
    const horizontal = type === 'split-horizontal';
    const rect = horizontal
      ? { left: 0, top: height * (1 - phase) / 2, width, height: height * phase }
      : { left: width * (1 - phase) / 2, top: 0, width: width * phase, height };
    return (
      <>
        <VideoLayer player={outgoingPlayer} transform={outgoing.transform} width={width} height={height} onFirstFrameRender={onOutgoingFirstFrame} />
        <ClippedVideoLayer player={incomingPlayer} transform={incoming.transform} rect={rect} width={width} height={height} onFirstFrameRender={onIncomingFirstFrame} />
      </>
    );
  }

  if (type === 'iris-circle' || type === 'iris-diamond') {
    return (
      <>
        <VideoLayer player={outgoingPlayer} transform={outgoing.transform} width={width} height={height} onFirstFrameRender={onOutgoingFirstFrame} />
        <IrisVideoLayer
          player={incomingPlayer}
          transform={incoming.transform}
          width={width}
          height={height}
          phase={phase}
          shape={type === 'iris-circle' ? 'circle' : 'diamond'}
          onFirstFrameRender={onIncomingFirstFrame}
        />
      </>
    );
  }
  if (type === 'zoom-in' || type === 'zoom-out' || type === 'spin') {
    const scale = type === 'zoom-out' ? 1.8 - phase * 0.8 : 0.35 + phase * 0.65;
    const rotate = type === 'spin' ? `${(1 - phase) * 280}deg` : '0deg';
    return (
      <>
        <VideoLayer player={outgoingPlayer} transform={outgoing.transform} width={width} height={height} onFirstFrameRender={onOutgoingFirstFrame} />
        <VideoLayer player={incomingPlayer} transform={incoming.transform} width={width} height={height} opacity={phase} onFirstFrameRender={onIncomingFirstFrame} effectStyle={{ transform: [{ scale }, { rotate }] }} />
      </>
    );
  }

  if (type === 'fold-horizontal' || type === 'fold-vertical') {
    return (
      <>
        <VideoLayer player={outgoingPlayer} transform={outgoing.transform} width={width} height={height} onFirstFrameRender={onOutgoingFirstFrame} />
        <VideoLayer
          player={incomingPlayer}
          transform={incoming.transform}
          width={width}
          height={height}
          opacity={phase}
          onFirstFrameRender={onIncomingFirstFrame}
          effectStyle={{ transform: type === 'fold-horizontal' ? [{ scaleY: Math.max(0.015, phase) }] : [{ scaleX: Math.max(0.015, phase) }] }}
        />
      </>
    );
  }

  return (
    <>
      <VideoLayer player={outgoingPlayer} transform={outgoing.transform} width={width} height={height} onFirstFrameRender={onOutgoingFirstFrame} />
      <VideoLayer player={incomingPlayer} transform={incoming.transform} width={width} height={height} opacity={phase} onFirstFrameRender={onIncomingFirstFrame} />
      {type === 'fade-dark' ? <View style={[fill, { backgroundColor: '#000000', opacity: frame.peak * 140 / 255 }]} /> : null}
      {type === 'glitch' ? <GlitchOverlay phase={phase} peak={frame.peak} height={height} /> : null}
    </>
  );
}

function IrisVideoLayer(props: {
  player: VideoPlayer;
  transform: VideoTransform;
  width: number;
  height: number;
  phase: number;
  shape: 'circle' | 'diamond';
  onFirstFrameRender: () => void;
}) {
  if (props.phase <= 0) return null;
  const size = Math.max(
    1,
    (props.shape === 'circle'
      ? Math.hypot(props.width, props.height)
      : (props.width + props.height) / Math.SQRT2) * props.phase,
  );
  const rotation = props.shape === 'diamond' ? '45deg' : '0deg';
  const inverseRotation = props.shape === 'diamond' ? '-45deg' : '0deg';
  return (
    <View
      style={{
        position: 'absolute',
        left: (props.width - size) / 2,
        top: (props.height - size) / 2,
        width: size,
        height: size,
        overflow: 'hidden',
        borderRadius: props.shape === 'circle' ? size / 2 : 0,
        transform: [{ rotate: rotation }],
      }}>
      <View
        style={{
          position: 'absolute',
          left: (size - props.width) / 2,
          top: (size - props.height) / 2,
          width: props.width,
          height: props.height,
          transform: [{ rotate: inverseRotation }],
        }}>
        <VideoLayer player={props.player} transform={props.transform} width={props.width} height={props.height} onFirstFrameRender={props.onFirstFrameRender} />
      </View>
    </View>
  );
}
function VideoLayer(props: {
  player: VideoPlayer;
  transform: VideoTransform;
  width: number;
  height: number;
  opacity?: number;
  effectStyle?: StyleProp<ViewStyle>;
  onFirstFrameRender: () => void;
}) {
  return (
    <View style={[fill, props.effectStyle, { opacity: props.opacity ?? 1 }]}>
      <View style={[fill, { transform: transformStyle(props.transform, props.width, props.height) }]}>
        <VideoView
          style={{ flex: 1 }}
          player={props.player}
          nativeControls={false}
          contentFit={props.transform.fit === 'fill' ? 'cover' : 'contain'}
          surfaceType="textureView"
          useExoShutter={false}
          onFirstFrameRender={props.onFirstFrameRender}
        />
      </View>
    </View>
  );
}

function ClippedVideoLayer(props: {
  player: VideoPlayer;
  transform: VideoTransform;
  rect: { left: number; top: number; width: number; height: number };
  width: number;
  height: number;
  onFirstFrameRender: () => void;
}) {
  if (props.rect.width <= 0 || props.rect.height <= 0) return null;
  return (
    <View style={{ position: 'absolute', overflow: 'hidden', ...props.rect }}>
      <View style={{ position: 'absolute', left: -props.rect.left, top: -props.rect.top, width: props.width, height: props.height }}>
        <VideoLayer player={props.player} transform={props.transform} width={props.width} height={props.height} onFirstFrameRender={props.onFirstFrameRender} />
      </View>
    </View>
  );
}

function CoverTransition(props: { frame: VideoTransitionPreviewFrame; width: number; height: number }) {
  const { frame, width, height } = props;
  const peak = frame.peak;
  if (frame.type === 'shutter') {
    const blade = height * peak / 2;
    return (
      <View pointerEvents="none" style={fill}>
        <View style={{ position: 'absolute', left: 0, right: 0, top: 0, height: blade, backgroundColor: '#000000' }} />
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: blade, backgroundColor: '#000000' }} />
      </View>
    );
  }
  if (frame.type === 'color-wash-cyan' || frame.type === 'color-wash-magenta') {
    const cyan = frame.type === 'color-wash-cyan';
    const edge = frame.phase < 0.5 ? width * frame.phase * 2 : width * (2 - frame.phase * 2);
    return (
      <View pointerEvents="none" style={fill}>
        <View style={[fill, { backgroundColor: cyan ? '#00D9FF' : '#FF168F', opacity: peak }]} />
        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: edge, backgroundColor: cyan ? '#651FFF' : '#FFEA00', opacity: peak * 92 / 255 }} />
      </View>
    );
  }
  const color = frame.type === 'dip-white' || frame.type === 'flash' ? '#FFFFFF' : '#000000';
  const opacity = frame.type === 'flash' ? peak * peak : peak;
  return <View pointerEvents="none" style={[fill, { backgroundColor: color, opacity }]} />;
}

function GlitchOverlay(props: { phase: number; peak: number; height: number }) {
  return <View style={fill}>{Array.from({ length: 9 }, (_, row) => <View key={row} style={{ position: 'absolute', left: Math.sin(row * 2 + props.phase * 20) * 24 * props.peak, right: 0, top: row * props.height / 9, height: props.height / 18, backgroundColor: row % 2 === 0 ? '#FF00FF' : '#00FFFF', opacity: props.peak * 100 / 255 }} />)}</View>;
}

function PreviewNotice(props: { label: string; detail?: string; compact?: boolean }) {
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 7, right: 7, top: 7, alignItems: 'center' }}>
      <View style={{ maxWidth: '94%', paddingHorizontal: 9, paddingVertical: props.compact ? 4 : 6, borderRadius: chrome.radius.sm, backgroundColor: chrome.overlay, borderWidth: 1, borderColor: chrome.hairline }}>
        <Text style={{ color: chrome.text, fontSize: props.compact ? 8 : 9, fontWeight: '900', textAlign: 'center' }}>{props.label}</Text>
        {props.detail ? <Text style={{ color: chrome.muted, fontSize: 8, fontWeight: '700', textAlign: 'center', marginTop: 2 }}>{props.detail}</Text> : null}
      </View>
    </View>
  );
}

function transformStyle(transform: VideoTransform, width: number, height: number) {
  return [
    { translateX: (transform.position.x - 0.5) * width },
    { translateY: (transform.position.y - 0.5) * height },
    { scale: transform.scale },
    { rotate: `${transform.rotation}deg` as `${number}deg` },
  ];
}
