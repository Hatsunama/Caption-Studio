import { VideoView, type VideoPlayer } from 'expo-video';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';

import {
  buildVideoTransitionPreviewWindows,
  videoTransitionPreviewFrameAt,
  type VideoTransitionPreviewFrame,
} from '@/lib/video-transition-preview';
import type { TimelineVideoSlot } from '@/hooks/use-timeline-video-controller';
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
  visible: boolean;
  players: readonly [VideoPlayer, VideoPlayer];
  slots: readonly [TimelineVideoSlot, TimelineVideoSlot];
  activeSlot: 0 | 1;
  currentTransform: VideoTransform;
  currentClipId?: string;
  onFirstFrameRender: (slot: 0 | 1, token: number) => void;
};

const fill: ViewStyle = { position: 'absolute', inset: 0 };

export function VideoTransitionOverlay(props: Props) {
  const [failedPreviewKey, setFailedPreviewKey] = useState<string>();
  const windows = useMemo(
    () => buildVideoTransitionPreviewWindows(props.entries, props.sources),
    [props.entries, props.sources],
  );
  const sourceFrame = useMemo(
    () => videoTransitionPreviewFrameAt(windows, props.timelineMs),
    [props.timelineMs, windows],
  );
  const frame = sourceFrame && props.currentClipId ? {
    ...sourceFrame,
    outgoing: sourceFrame.outgoing?.clipId === props.currentClipId
      ? { ...sourceFrame.outgoing, transform: props.currentTransform } : sourceFrame.outgoing,
    incoming: sourceFrame.incoming?.clipId === props.currentClipId
      ? { ...sourceFrame.incoming, transform: props.currentTransform } : sourceFrame.incoming,
  } : sourceFrame;
  if (!props.admitted) return null;
  const transitionReady = props.visible && props.transportReady && frame?.key !== failedPreviewKey;
  return (
    <View pointerEvents="none" style={fill}>
      <TimelineVideoPair {...props} />
      {!props.visible ? <View style={[fill, { backgroundColor: props.backgroundColor }]} /> : null}
      {transitionReady && frame?.mode === 'cover'
        ? <CoverTransition frame={frame} width={props.width} height={props.height} /> : null}
      {transitionReady && frame?.unavailableReason
        ? <PreviewNotice label="TRANSITION PREVIEW UNAVAILABLE" detail={frame.unavailableReason} /> : null}
      {transitionReady && frame?.mode === 'composite' && frame.outgoing && frame.incoming && !frame.unavailableReason
        ? <CompositeVideoTransitionOverlay {...props} frame={frame} onUnavailable={() => setFailedPreviewKey(frame.key)} /> : null}
    </View>
  );
}

function TimelineVideoPair(props: Props) {
  return (
    <View pointerEvents="none" style={[fill, { overflow: 'hidden' }]}>
      {props.players.map((player, index) => {
        const slot = index as 0 | 1;
        return (
          <VideoLayer
            key={`${slot}:${props.slots[slot].prepareToken}`}
            player={player}
            transform={props.currentTransform}
            width={props.width}
            height={props.height}
            effectStyle={{ zIndex: slot === props.activeSlot ? 1 : 0, backgroundColor: props.backgroundColor }}
            onFirstFrameRender={() => props.onFirstFrameRender(slot, props.slots[slot].prepareToken)}
          />
        );
      })}
    </View>
  );
}

function CompositeVideoTransitionOverlay(props: Props & {
  frame: VideoTransitionPreviewFrame;
  onUnavailable: () => void;
}) {
  const outgoingSlot = props.slots.findIndex((slot) => slot.preparedClipId === props.frame.outgoing?.clipId);
  const incomingSlot = props.slots.findIndex((slot) => slot.preparedClipId === props.frame.incoming?.clipId);
  if (
    outgoingSlot < 0
    || incomingSlot < 0
    || outgoingSlot === incomingSlot
    || !props.slots[outgoingSlot].firstFrameReady
    || !props.slots[incomingSlot].firstFrameReady
    || props.slots[outgoingSlot].readiness !== 'ready'
    || props.slots[incomingSlot].readiness !== 'ready'
  ) {
    return null;
  }
  return (
    <SynchronizedComposite
      key={`${props.frame.key}:${props.slots[outgoingSlot].prepareToken}:${props.slots[incomingSlot].prepareToken}`}
      {...props}
      outgoingSlot={outgoingSlot as 0 | 1}
      incomingSlot={incomingSlot as 0 | 1}
    />
  );
}

function SynchronizedComposite(props: Props & {
  frame: VideoTransitionPreviewFrame;
  outgoingSlot: 0 | 1;
  incomingSlot: 0 | 1;
  onUnavailable: () => void;
}) {
  const [rendered, setRendered] = useState({ outgoing: false, incoming: false });
  const ready = rendered.outgoing && rendered.incoming;
  const { activeSlot, frame, isPlaying, onUnavailable, outgoingSlot, transportReady } = props;
  const outgoingPlayer = props.players[props.outgoingSlot];
  const incomingPlayer = props.players[props.incomingSlot];
  const latestPlayersRef = useRef(props.players);
  const latestActiveSlotRef = useRef(props.activeSlot);

  useEffect(() => {
    latestPlayersRef.current = props.players;
    latestActiveSlotRef.current = props.activeSlot;
  }, [props.players, props.activeSlot]);

  useEffect(() => {
    if (ready) return;
    const timeout = setTimeout(onUnavailable, 1_500);
    return () => clearTimeout(timeout);
  }, [onUnavailable, ready]);

  useEffect(() => () => {
    latestPlayersRef.current.forEach((player, slot) => {
      if (slot !== latestActiveSlotRef.current) {
        player.muted = true;
        player.pause();
      }
    });
  }, []);

  useEffect(() => {
    // The controller owns the active player's clock and audio. Only the
      // decorative standby follows the transition's source-time mapping.
    try {
      const standbyIsOutgoing = outgoingSlot !== activeSlot;
      const standby = standbyIsOutgoing ? outgoingPlayer : incomingPlayer;
      synchronizeTransitionPlayer(
        standby,
        standbyIsOutgoing ? frame.outgoingSourceTimeMs : frame.incomingSourceTimeMs,
        standbyIsOutgoing ? frame.outgoing?.playbackRate : frame.incoming?.playbackRate,
        isPlaying && transportReady,
      );
    } catch {
      onUnavailable();
    }
  }, [activeSlot, frame, incomingPlayer, isPlaying, onUnavailable, outgoingPlayer, outgoingSlot, transportReady]);

  return (
    <View pointerEvents="none" style={[fill, { overflow: 'hidden', opacity: ready ? 1 : 0 }]}>
      <View style={fill}>
        <CompositeTransition
          frame={props.frame}
          outgoingPlayer={outgoingPlayer}
          incomingPlayer={incomingPlayer}
          width={props.width}
          height={props.height}
          onOutgoingFirstFrame={() => {
            props.onFirstFrameRender(props.outgoingSlot, props.slots[props.outgoingSlot].prepareToken);
            setRendered((current) => ({ ...current, outgoing: true }));
          }}
          onIncomingFirstFrame={() => {
            props.onFirstFrameRender(props.incomingSlot, props.slots[props.incomingSlot].prepareToken);
            setRendered((current) => ({ ...current, incoming: true }));
          }}
        />
      </View>
    </View>
  );
}

function synchronizeTransitionPlayer(
  player: VideoPlayer,
  targetMs: number | undefined,
  playbackRate: number | undefined,
  playing: boolean,
) {
  if (targetMs == null || playbackRate == null) return;
  player.muted = true;
  const targetSeconds = targetMs / 1_000;
  player.playbackRate = playbackRate;
  const driftMs = Math.abs(player.currentTime - targetSeconds) * 1_000;
  if (!playing || !player.playing || driftMs > 160) player.currentTime = targetSeconds;
  if (playing) {
    if (!player.playing) player.play();
  } else {
    player.pause();
  }
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
    { rotate: `${transform.rotation}deg` as `${number}deg` },
    { scaleX: transform.scale * (transform.scaleX ?? 1) },
    { scaleY: transform.scale * (transform.scaleY ?? 1) },
  ];
}
