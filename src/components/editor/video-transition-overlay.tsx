import { VideoView, type VideoPlayer } from 'expo-video';
import { useMemo } from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { useVideoTransitionPreview } from '@/hooks/use-video-transition-preview';
import {
  buildVideoTransitionPreviewWindows,
  transitionPreviewKind,
  videoTransitionPreloadWindow,
  videoTransitionPreviewFrameAt,
  type VideoTransitionPreviewFrame,
} from '@/lib/video-transition-preview';
import type { ClipTimelineEntry } from '@/lib/video-timeline';
import type { ProjectVideoSource, VideoTransform } from '@/types/project';

type Props = {
  entries: readonly ClipTimelineEntry[];
  sources: readonly ProjectVideoSource[];
  timelineMs: number;
  isPlaying: boolean;
  transportReady: boolean;
  width: number;
  height: number;
  backgroundColor: string;
  backgroundProcessingActive: boolean;
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
  if (props.backgroundProcessingActive) {
    return frame ? <PreviewNotice label="BACKGROUND PREVIEW APPROXIMATION" detail="Export blends both processed clips." /> : null;
  }
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
  if (!frame) return null;

  if (preview.error) return <PreviewNotice label="TRANSITION PREVIEW UNAVAILABLE" detail={preview.error} />;
  if (!preview.ready || !frame.outgoing || !frame.incoming) {
    return <PreviewNotice label="LOADING TRANSITION PREVIEW" />;
  }

  return (
    <View pointerEvents="none" style={[fill, { overflow: 'hidden', backgroundColor: props.backgroundColor }]}>
      <CompositeTransition
        frame={frame}
        outgoingPlayer={preview.outgoingPlayer}
        incomingPlayer={preview.incomingPlayer}
        width={props.width}
        height={props.height}
      />
      {frame.fidelity === 'approximate' && frame.approximationLabel
        ? <PreviewNotice label={frame.approximationLabel} compact />
        : null}
    </View>
  );
}

function CompositeTransition(props: {
  frame: VideoTransitionPreviewFrame;
  outgoingPlayer: VideoPlayer;
  incomingPlayer: VideoPlayer;
  width: number;
  height: number;
}) {
  const { frame, outgoingPlayer, incomingPlayer, width, height } = props;
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
        <VideoLayer player={outgoingPlayer} transform={outgoing.transform} width={width} height={height} effectStyle={{ transform: horizontal ? [{ translateX: sign * distance * phase }] : [{ translateY: sign * distance * phase }] }} />
        <VideoLayer player={incomingPlayer} transform={incoming.transform} width={width} height={height} effectStyle={{ transform: horizontal ? [{ translateX: -sign * distance * (1 - phase) }] : [{ translateY: -sign * distance * (1 - phase) }] }} />
      </>
    );
  }

  if (type.startsWith('slide-')) {
    const horizontal = type.endsWith('left') || type.endsWith('right');
    const sign = type.endsWith('left') || type.endsWith('up') ? 1 : -1;
    const distance = horizontal ? width : height;
    return (
      <>
        <VideoLayer player={outgoingPlayer} transform={outgoing.transform} width={width} height={height} />
        <VideoLayer player={incomingPlayer} transform={incoming.transform} width={width} height={height} effectStyle={{ transform: horizontal ? [{ translateX: sign * distance * (1 - phase) }] : [{ translateY: sign * distance * (1 - phase) }] }} />
      </>
    );
  }

  if (type.startsWith('wipe-') && !type.startsWith('wipe-diagonal-')) {
    const rect = directionalRevealRect(type, phase, width, height);
    return (
      <>
        <VideoLayer player={outgoingPlayer} transform={outgoing.transform} width={width} height={height} />
        <ClippedVideoLayer player={incomingPlayer} transform={incoming.transform} rect={rect} width={width} height={height} />
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
        <VideoLayer player={outgoingPlayer} transform={outgoing.transform} width={width} height={height} />
        <ClippedVideoLayer player={incomingPlayer} transform={incoming.transform} rect={rect} width={width} height={height} />
      </>
    );
  }

  if (type === 'zoom-in' || type === 'zoom-out' || type === 'spin') {
    const scale = type === 'zoom-out' ? 1.8 - phase * 0.8 : 0.35 + phase * 0.65;
    const rotate = type === 'spin' ? `${(1 - phase) * 280}deg` : '0deg';
    return (
      <>
        <VideoLayer player={outgoingPlayer} transform={outgoing.transform} width={width} height={height} />
        <VideoLayer player={incomingPlayer} transform={incoming.transform} width={width} height={height} opacity={phase} effectStyle={{ transform: [{ scale }, { rotate }] }} />
      </>
    );
  }

  if (type === 'fold-horizontal' || type === 'fold-vertical') {
    return (
      <>
        <VideoLayer player={outgoingPlayer} transform={outgoing.transform} width={width} height={height} />
        <VideoLayer
          player={incomingPlayer}
          transform={incoming.transform}
          width={width}
          height={height}
          opacity={phase}
          effectStyle={{ transform: type === 'fold-horizontal' ? [{ scaleY: Math.max(0.015, phase) }] : [{ scaleX: Math.max(0.015, phase) }] }}
        />
      </>
    );
  }

  return (
    <>
      <VideoLayer player={outgoingPlayer} transform={outgoing.transform} width={width} height={height} />
      <VideoLayer player={incomingPlayer} transform={incoming.transform} width={width} height={height} opacity={phase} />
      {type === 'fade-dark' ? <View style={[fill, { backgroundColor: '#000000', opacity: frame.peak * 140 / 255 }]} /> : null}
      {type === 'glitch' ? <GlitchOverlay phase={phase} peak={frame.peak} height={height} /> : null}
      {frame.fidelity === 'approximate' ? <ApproximateMaskOverlay frame={frame} /> : null}
    </>
  );
}

function VideoLayer(props: {
  player: VideoPlayer;
  transform: VideoTransform;
  width: number;
  height: number;
  opacity?: number;
  effectStyle?: StyleProp<ViewStyle>;
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
          useExoShutter
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
}) {
  if (props.rect.width <= 0 || props.rect.height <= 0) return null;
  return (
    <View style={{ position: 'absolute', overflow: 'hidden', ...props.rect }}>
      <View style={{ position: 'absolute', left: -props.rect.left, top: -props.rect.top, width: props.width, height: props.height }}>
        <VideoLayer player={props.player} transform={props.transform} width={props.width} height={props.height} />
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
        <View style={[fill, { backgroundColor: cyan ? '#00D9FF' : '#FF168F', opacity: peak * 212 / 255 }]} />
        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: edge, backgroundColor: cyan ? '#651FFF' : '#FFEA00', opacity: peak * 92 / 255 }} />
      </View>
    );
  }
  if (frame.type === 'ripple-rings') {
    return (
      <View pointerEvents="none" style={[fill, { alignItems: 'center', justifyContent: 'center' }]}>
        {[0, 1, 2, 3].map((index) => {
          const ringPhase = (frame.phase + index * 0.19) % 1;
          const radius = Math.hypot(width / 2, height / 2) * ringPhase;
          return <View key={index} style={{ position: 'absolute', width: radius * 2, height: radius * 2, borderRadius: radius, borderWidth: Math.max(4, Math.min(width, height) * 0.012), borderColor: index % 2 === 0 ? '#00E5FF' : '#FF3CAC', opacity: peak * (1 - ringPhase) * 210 / 255 }} />;
        })}
      </View>
    );
  }
  const color = frame.type === 'dip-white' || frame.type === 'flash' ? '#FFFFFF' : '#000000';
  const opacity = frame.type === 'flash' ? peak * peak : peak;
  return <View pointerEvents="none" style={[fill, { backgroundColor: color, opacity }]} />;
}

function ApproximateMaskOverlay({ frame }: { frame: VideoTransitionPreviewFrame }) {
  const kind = transitionPreviewKind(frame.type);
  const phase = frame.phase;
  const peak = frame.peak;
  if (kind === 'diagonal') {
    const fromRight = frame.type.endsWith('tr') || frame.type.endsWith('br');
    const fromBottom = frame.type.endsWith('bl') || frame.type.endsWith('br');
    return <View style={{ position: 'absolute', left: percent((fromRight ? 1 - phase : phase) * 130 - 30), top: percent((fromBottom ? 1 - phase : phase) * 130 - 30), width: '80%', aspectRatio: 1, borderWidth: 7, borderColor: '#DFFF35', opacity: 0.3 + peak * 0.5, transform: [{ rotate: '45deg' }] }} />;
  }
  if (kind === 'iris') {
    const size = 12 + phase * 135;
    return <View style={{ position: 'absolute', alignSelf: 'center', top: percent((100 - size) / 2), width: percent(size), aspectRatio: 1, borderRadius: frame.type === 'iris-circle' ? 999 : 4, borderWidth: 7, borderColor: '#DFFF35', opacity: 0.35 + peak * 0.5, transform: frame.type === 'iris-diamond' ? [{ rotate: '45deg' }] : undefined }} />;
  }
  if (kind === 'blinds') {
    const horizontal = frame.type === 'blinds-horizontal';
    return <View style={[fill, { flexDirection: horizontal ? 'column' : 'row' }]}>{Array.from({ length: 10 }, (_, index) => <View key={index} style={{ flex: 1, borderColor: index % 2 ? '#00E5FF' : '#651FFF', borderBottomWidth: horizontal ? 2 : 0, borderRightWidth: horizontal ? 0 : 2, opacity: 0.25 + peak * 0.45 }} />)}</View>;
  }
  if (kind === 'tiles') {
    const columns = frame.type === 'checkerboard' ? 8 : 12;
    const rows = frame.type === 'checkerboard' ? 12 : 18;
    return <View style={[fill, { flexDirection: 'row', flexWrap: 'wrap' }]}>{Array.from({ length: columns * rows }, (_, index) => <View key={index} style={{ width: percent(100 / columns), height: percent(100 / rows), borderWidth: 0.35, borderColor: (index + Math.floor(index / columns)) % 2 ? '#FF3CAC' : '#00E5FF', opacity: peak * 0.42 }} />)}</View>;
  }
  if (kind === 'radial') {
    return <View style={[fill, { alignItems: 'center', justifyContent: 'center' }]}><View style={{ width: '78%', aspectRatio: 1, borderRadius: 999, borderWidth: 4, borderColor: '#00E5FF', opacity: 0.35 + peak * 0.5 }} /><View style={{ position: 'absolute', width: 4, height: '46%', top: '4%', backgroundColor: '#DFFF35', transformOrigin: '50% 100%', transform: [{ rotate: `${phase * 360}deg` }] }} /></View>;
  }
  if (kind === 'stripes') {
    return <View style={fill}>{Array.from({ length: 12 }, (_, index) => <View key={index} style={{ position: 'absolute', left: percent(index * 11 - 18), top: '-25%', width: '5%', height: '150%', backgroundColor: index % 2 ? '#00E5FF' : '#DFFF35', opacity: peak * 0.36, transform: [{ rotate: '24deg' }] }} />)}</View>;
  }
  if (kind === 'slices') {
    return <View style={fill}>{Array.from({ length: 12 }, (_, index) => <View key={index} style={{ position: 'absolute', left: index % 2 ? undefined : 0, right: index % 2 ? 0 : undefined, top: percent(index * 100 / 12), width: percent(Math.max(1, phase * 100)), height: percent(100 / 12 + 0.5), borderBottomWidth: 1, borderBottomColor: index % 3 ? '#651FFF' : '#FF3CAC', opacity: peak * 0.55 }} />)}</View>;
  }
  return null;
}

function GlitchOverlay(props: { phase: number; peak: number; height: number }) {
  return <View style={fill}>{Array.from({ length: 9 }, (_, row) => <View key={row} style={{ position: 'absolute', left: Math.sin(row * 2 + props.phase * 20) * 24 * props.peak, right: 0, top: row * props.height / 9, height: props.height / 18, backgroundColor: row % 2 === 0 ? '#FF00FF' : '#00FFFF', opacity: props.peak * 100 / 255 }} />)}</View>;
}

function PreviewNotice(props: { label: string; detail?: string; compact?: boolean }) {
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 7, right: 7, top: 7, alignItems: 'center' }}>
      <View style={{ maxWidth: '94%', paddingHorizontal: 9, paddingVertical: props.compact ? 4 : 6, borderRadius: 8, backgroundColor: '#090B0ED9', borderWidth: 1, borderColor: '#596473' }}>
        <Text style={{ color: '#F3F6FA', fontSize: props.compact ? 8 : 9, fontWeight: '900', textAlign: 'center' }}>{props.label}</Text>
        {props.detail ? <Text style={{ color: '#B7C0CA', fontSize: 8, fontWeight: '700', textAlign: 'center', marginTop: 2 }}>{props.detail}</Text> : null}
      </View>
    </View>
  );
}

function directionalRevealRect(type: string, phase: number, width: number, height: number) {
  if (type === 'wipe-left') return { left: width * (1 - phase), top: 0, width: width * phase, height };
  if (type === 'wipe-right') return { left: 0, top: 0, width: width * phase, height };
  if (type === 'wipe-up') return { left: 0, top: height * (1 - phase), width, height: height * phase };
  return { left: 0, top: 0, width, height: height * phase };
}

function transformStyle(transform: VideoTransform, width: number, height: number) {
  return [
    { translateX: (transform.position.x - 0.5) * width },
    { translateY: (transform.position.y - 0.5) * height },
    { scale: transform.scale },
    { rotate: `${transform.rotation}deg` as `${number}deg` },
  ];
}

function percent(value: number) {
  return `${Math.round(value * 100) / 100}%` as `${number}%`;
}
