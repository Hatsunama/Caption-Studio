import { VideoView, type VideoPlayer } from 'expo-video';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import {
  buildVideoTransitionPreviewWindows,
  videoTransitionCompositeState,
  videoTransitionPlaybackTargets,
  videoTransitionPreviewFrameAt,
  type VideoTransitionPreviewFrame,
} from '@/lib/video-transition-preview';
import type { TimelineVideoSlot } from '@/hooks/use-timeline-video-controller';
import type { ClipTimelineEntry } from '@/lib/video-timeline';
import type { ProjectVideoSource, VideoTransform } from '@/types/project';
import { chrome } from '@/lib/ui-theme';
import { effectiveNativeSeekTarget } from '@/lib/video-playback-position';
import { resolveCanvasColor } from '@/lib/canvas-color';

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
  onFirstFrameRender: (slot: 0 | 1, nativeViewEpoch: number) => void;
  setCompositeClock: (clock?: { key: string; slot: 0 | 1; prepareToken: number }) => void;
  retireComposite: (allowOrdinaryPlayback?: boolean) => void;
};

const fill: ViewStyle = { position: 'absolute', inset: 0 };

export function VideoTransitionOverlay(props: Props) {
  const backgroundColor = resolveCanvasColor(props.backgroundColor);
  const [failedPreview, setFailedPreview] = useState<{ key: string; preparation: string }>();
  const preparation = props.slots.map(slot => slot.prepareToken).join(':');
  const failedPreviewKey = failedPreview?.preparation === preparation ? failedPreview.key : undefined;
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
  const compositeState = frame?.mode === 'composite'
    ? videoTransitionCompositeState(frame, props.slots, failedPreviewKey) : undefined;
  const frameKey = frame?.key;
  const onUnavailable = useCallback(() => {
    if (frameKey) setFailedPreview({ key: frameKey, preparation });
  }, [frameKey, preparation]);
  const transitionReady = props.visible && props.transportReady;
  const composite = props.admitted && transitionReady && frame?.mode === 'composite' && compositeState?.status === 'ready'
    ? { frame, outgoingSlot: compositeState.outgoingSlot as 0 | 1, incomingSlot: compositeState.incomingSlot as 0 | 1 }
    : undefined;
  const compositeUnavailable = frame?.mode === 'composite' && !composite;
  const { admitted, isPlaying, players, retireComposite, activeSlot, slots, timelineMs } = props;
  useEffect(() => {
    if (compositeUnavailable) {
      // The notice conceals the unavailable pair, but the admitted ordinary
      // owner must still deliver its real decoder clock through this window.
      players.forEach(player => { player.muted = true; player.volume = 0; });
      retireComposite(admitted && transitionReady && isPlaying);
    }
  }, [compositeUnavailable, admitted, isPlaying, players, retireComposite,
    activeSlot, slots, timelineMs, transitionReady]);
  if (!props.admitted) return null;
  return (
    <View collapsable={false} pointerEvents="none" style={[fill, transitionReady && compositeState ? { backgroundColor } : undefined]}>
      <TimelineVideoPair {...props} composite={composite} concealed={Boolean(transitionReady && compositeState && !composite)} />
      {!props.visible ? <View style={[fill, { backgroundColor }]} /> : null}
      {transitionReady && frame?.mode === 'cover'
        ? <CoverTransition frame={frame} width={props.width} height={props.height} /> : null}
      {composite?.frame.type === 'spin'
        ? <CoverTransition frame={{ ...composite.frame, type: 'flash' }} width={props.width} height={props.height} /> : null}
      {transitionReady && frame?.mode === 'cover' && frame.unavailableReason
        ? <PreviewNotice label="TRANSITION PREVIEW UNAVAILABLE" detail={frame.unavailableReason} /> : null}
      {transitionReady && compositeState?.status !== 'ready' && compositeState
        ? <PreviewNotice label="TRANSITION PREVIEW UNAVAILABLE" detail={frame?.unavailableReason ?? (compositeState.status === 'waiting' ? 'Waiting for video frames.' : 'A transition frame could not be rendered.')} /> : null}
      {composite
        ? <SynchronizedComposite
            key={`${composite.frame.key}:${props.slots[composite.outgoingSlot].prepareToken}:${props.slots[composite.incomingSlot].prepareToken}`}
            {...props}
            {...composite}
            onUnavailable={onUnavailable}
          /> : null}
    </View>
  );
}

type Composite = { frame: VideoTransitionPreviewFrame; outgoingSlot: 0 | 1; incomingSlot: 0 | 1 };

function TimelineVideoPair(props: Props & { composite?: Composite; concealed: boolean }) {
  const { composite } = props;
  // These are the frames of the retained surfaces, not new transition surfaces
  // that would need another native frame event just to reveal a paused image.
  const rendered = composite ? {
    outgoing: props.slots[composite.outgoingSlot].firstFrameReady,
    incoming: props.slots[composite.incomingSlot].firstFrameReady,
  } : { outgoing: true, incoming: true };
  const ready = rendered.outgoing && rendered.incoming && !props.concealed;
  return (
    <View collapsable={false} pointerEvents="none" style={[fill, { overflow: 'hidden', opacity: ready ? 1 : 0 }]}>
      {props.players.map((player, index) => {
        const slot = index as 0 | 1;
        const incoming = composite?.incomingSlot === slot;
        const source = composite ? (incoming ? composite.frame.incoming : composite.frame.outgoing) : undefined;
        const effect = composite ? compositeLayerStyle(composite.frame, incoming, props.width, props.height) : undefined;
        const front = composite ? incoming : slot === props.activeSlot;
        // Fabric sorts concrete children by zIndex and removes/reinserts them
        // when it changes. Keep the TextureView ancestry attached on Android;
        // elevation changes RenderNode drawing order without a mount mutation.
        // The elevated wrapper never gets a background drawable (including
        // ordinary playback), so its native outline has zero alpha on API 24+.
        const order: ViewStyle = Platform.OS === 'android'
          ? { zIndex: 0, elevation: front ? 1 : 0, shadowColor: 'transparent' }
          : { zIndex: front ? 1 : 0 };
        return (
          <VideoLayer
            key={`${slot}:${props.slots[slot].nativeViewEpoch}`}
            player={player}
            transform={source?.transform ?? props.currentTransform}
            width={props.width}
            height={props.height}
            opacity={composite ? effect?.opacity : Platform.OS === 'android' && slot !== props.activeSlot ? 0 : undefined}
            effectStyle={[order, effect?.style]}
            backgroundColor={resolveCanvasColor(props.backgroundColor)}
            clip={effect?.clip}
            onFirstFrameRender={() => props.onFirstFrameRender(slot, props.slots[slot].nativeViewEpoch)}
          />
        );
      })}
    </View>
  );
}

function SynchronizedComposite(props: Props & {
  frame: VideoTransitionPreviewFrame;
  outgoingSlot: 0 | 1;
  incomingSlot: 0 | 1;
  onUnavailable: () => void;
}) {
  const { activeSlot, admitted, visible, frame, isPlaying, onUnavailable, outgoingSlot, incomingSlot,
    transportReady, players, slots, setCompositeClock, retireComposite } = props;
  const latestRetireCompositeRef = useRef(props.retireComposite);

  useEffect(() => {
    latestRetireCompositeRef.current = props.retireComposite;
  }, [props.retireComposite]);

  useEffect(() => () => {
    latestRetireCompositeRef.current();
    // Parent callbacks can change every clock render. Only retiring this keyed
    // composite may pause its standby player; otherwise every tick forces a seek.
  }, []);

  useEffect(() => {
    try {
      const targets = videoTransitionPlaybackTargets(frame, outgoingSlot, incomingSlot, activeSlot);
      if (targets.length !== 2) {
        throw new Error('Both transition sources must be available.');
      }
      // Claim this preparation before either leg can be retimed. A partial
      // synchronization failure must retire the same authority as a full pair.
      setCompositeClock({ key: frame.key, slot: activeSlot, prepareToken: slots[activeSlot].prepareToken });
      targets.forEach((target) => {
        const outgoing = target.slot === outgoingSlot;
        const source = outgoing ? frame.outgoing! : frame.incoming!;
        const logicalMs = outgoing ? frame.outgoingSourceTimeMs! : frame.incomingSourceTimeMs!;
        const installedEndSeconds = (slots[target.slot].appliedWindowEndMs ?? source.sourceDurationMs) / 1_000;
        const nativeEndSeconds = effectiveNativeSeekTarget(
          installedEndSeconds, installedEndSeconds,
          players[target.slot].duration, Platform.OS,
        );
        // Bound the whole near-EOF tail, not only exact declared EOF. Keep the
        // helper's seconds/ULP intact through Expo's Double -> Long conversion.
        // If it declines adjustment, retain the sidecar's full-source bound.
        const nativeSeconds = nativeEndSeconds < installedEndSeconds
          ? Math.min(logicalMs / 1_000, nativeEndSeconds)
          : target.sourceTimeMs! / 1_000;
        synchronizeTransitionPlayer(
          players[target.slot], nativeSeconds, target.playbackRate,
          isPlaying && transportReady, target.muted, target.volume,
        );
      });
    } catch {
      players.forEach(player => { player.muted = true; player.volume = 0; });
      retireComposite(admitted && visible && transportReady && isPlaying);
      onUnavailable();
    }
  }, [activeSlot, admitted, visible, frame, incomingSlot, isPlaying, onUnavailable, outgoingSlot,
    players, retireComposite, setCompositeClock, slots, transportReady]);

  return null;
}

function synchronizeTransitionPlayer(
  player: VideoPlayer,
  targetSeconds: number | undefined,
  playbackRate: number | undefined,
  playing: boolean,
  muted: boolean,
  volume: number,
) {
  if (targetSeconds == null || playbackRate == null) return;
  player.muted = true;
  player.volume = volume;
  player.playbackRate = playbackRate;
  const driftMs = Math.abs(player.currentTime - targetSeconds) * 1_000;
  if (!playing || !player.playing || driftMs > 160) player.currentTime = targetSeconds;
  if (playing) {
    player.muted = muted;
    if (!player.playing) player.play();
  } else {
    player.pause();
  }
}

type LayerClip = { outer: ViewStyle; inner: ViewStyle };
type LayerEffect = { opacity?: number; style?: ViewStyle; clip?: LayerClip };

// Each recipe changes only the styles of the same persistent layer hierarchy.
function compositeLayerStyle(
  frame: VideoTransitionPreviewFrame,
  incoming: boolean,
  width: number,
  height: number,
): LayerEffect {
  const { phase, type } = frame;
  if (type.startsWith('push-')) {
    const horizontal = type.endsWith('left') || type.endsWith('right');
    const sign = type.endsWith('left') || type.endsWith('up') ? -1 : 1;
    const distance = horizontal ? width : height;
    const offset = incoming ? -sign * distance * (1 - phase) : sign * distance * phase;
    return { style: { transform: horizontal ? [{ translateX: offset }] : [{ translateY: offset }] } };
  }
  if (!incoming) return {};
  if (type === 'split-horizontal' || type === 'split-vertical') {
    const rect = type === 'split-horizontal'
      ? { left: 0, top: height * (1 - phase) / 2, width, height: height * phase }
      : { left: width * (1 - phase) / 2, top: 0, width: width * phase, height };
    return { clip: {
      outer: { position: 'absolute', overflow: 'hidden', ...rect },
      inner: { position: 'absolute', left: -rect.left, top: -rect.top, width, height },
    } };
  }
  if (type === 'iris-circle' || type === 'iris-diamond') {
    const circle = type === 'iris-circle';
    const size = Math.max(1, (circle ? Math.hypot(width, height) : (width + height) / Math.SQRT2) * phase);
    return {
      // Zero-phase clips stay mounted for readiness, but reveal no image.
      opacity: phase <= 0 ? 0 : 1,
      clip: {
        outer: {
          position: 'absolute', left: (width - size) / 2, top: (height - size) / 2,
          width: size, height: size, overflow: 'hidden', borderRadius: circle ? size / 2 : 0,
          transform: [{ rotate: circle ? '0deg' : '45deg' }],
        },
        inner: {
          position: 'absolute', left: (size - width) / 2, top: (size - height) / 2,
          width, height, transform: [{ rotate: circle ? '0deg' : '-45deg' }],
        },
      },
    };
  }
  if (type === 'zoom-in' || type === 'zoom-out' || type === 'spin') {
    const scale = type === 'zoom-out' ? 1.8 - phase * 0.8 : 0.35 + phase * 0.65;
    const rotate = type === 'spin' ? `${(1 - phase) * 280}deg` as `${number}deg` : '0deg';
    return { opacity: phase, style: { transform: [{ scale }, { rotate }] } };
  }
  if (type === 'fold-horizontal' || type === 'fold-vertical') {
    return { opacity: phase, style: { transform: type === 'fold-horizontal'
      ? [{ scaleY: Math.max(0.015, phase) }] : [{ scaleX: Math.max(0.015, phase) }] } };
  }
  return { opacity: phase };
}

function VideoLayer(props: {
  player: VideoPlayer;
  transform: VideoTransform;
  width: number;
  height: number;
  opacity?: number;
  effectStyle?: StyleProp<ViewStyle>;
  backgroundColor?: string;
  clip?: LayerClip;
  onFirstFrameRender: () => void;
}) {
  const opacity = props.opacity ?? 1;
  return (
    <View
      collapsable={false}
      needsOffscreenAlphaCompositing={Platform.OS === 'android' && opacity > 0 && opacity < 1}
      style={[fill, props.effectStyle, { opacity }]}
    >
      {/* Keep native ancestry stable as clipping starts/stops, including RN view flattening. */}
      <View collapsable={false} style={props.clip?.outer ?? fill}>
        <View collapsable={false} style={[props.clip?.inner ?? fill, { backgroundColor: props.backgroundColor }]}>
          <View collapsable={false} style={[fill, { transform: transformStyle(props.transform, props.width, props.height) }]}>
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
