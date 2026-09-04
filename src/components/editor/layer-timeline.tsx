import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, ScrollView, Text, View } from 'react-native';

import { chrome } from '@/lib/ui-theme';
import { packTimelineLanes } from '@/lib/timeline-layout';
import { previewVideoClipLeadingGap, previewVideoClipTrim } from '@/lib/project-editor';
import {
  clampTimelineScale,
  minimumTimelineScale,
  timelineScrollOffset,
  timelineTickInterval,
  timelineTimeAtScroll,
  timelineWidth,
  timelineZoomPercent,
} from '@/lib/timeline-scale';
import { buildClipTimeline, remapCaptionsToTimeline } from '@/lib/video-timeline';
import { audioClipEnd } from '@/lib/audio-timeline';
import type { CaptionPair } from '@/lib/caption-tracks';
import type { AudioClip, CaptionBlock, ProjectAudioSource, VideoClip, VisualLayer } from '@/types/project';

const LABEL_WIDTH = 82;
const RULER_HEIGHT = 28;
const LANE_HEIGHT = 32;
const NEON_CAPTION_COLORS = ['#FF2FA9', '#00B8FF', '#19D98B', '#A855F7', '#FF4D6D', '#00D9C8'];

export function LayerTimeline(props: {
  durationMs: number;
  clips: VideoClip[];
  layers: VisualLayer[];
  captions: CaptionBlock[];
  translationTracks: { id: string; name: string; visible: boolean; pairs: CaptionPair[] }[];
  currentMs: number;
  selectedLayerId: string;
  selectedCaptionId?: string;
  selectedClipId?: string;
  audioSources: ProjectAudioSource[];
  audioClips: AudioClip[];
  selectedAudioClipId?: string;
  onSeek: (timeMs: number) => void;
  onScrubStart: () => void;
  onSelectLayer: (id: string) => void;
  onSelectCaption: (caption: CaptionBlock) => void;
  onSelectTranslationCaption: (trackId: string, pair: CaptionPair) => void;
  onTranslationCaptionTimingChange: (trackId: string, sourceCaptionId: string, edge: 'start' | 'end' | 'move', startMs: number, endMs: number) => void;
  onSelectClip: (clipId: string) => void;
  onTrimClip: (clipId: string, edge: 'start' | 'end', targetSourceMs: number) => void;
  onSetClipGap: (clipId: string, gapMs: number, edge?: 'before' | 'after') => void;
  onSetClipLeadingGap: (clipId: string, gapMs: number) => void;
  onLayerTimingChange: (layerId: string, startMs: number, endMs: number) => void;
  onCaptionTimingChange: (captionId: string, edge: 'start' | 'end' | 'move', startMs: number, endMs: number) => void;
  onTimingChangeStart: () => void;
  onTimingChangeEnd: () => void;
  onMoveLayer: (layerId: string, direction: -1 | 1) => void;
  onDeleteLayer: (layerId: string) => void;
  onAddVideos: () => void;
  onSelectAudioClip: (clipId: string) => void;
  onAudioTimingChange: (clipId: string, edge: 'start' | 'end', startMs: number, endMs: number) => void;
}) {
  const horizontalRef = useRef<ScrollView>(null);
  const [viewportWidth, setViewportWidth] = useState(360);
  const [clipPreview, setClipPreview] = useState<VideoClip[]>();
  const [gestureLock, setGestureLock] = useState(false);
  const gestureLockRef = useRef(false);
  const previewClips = useMemo(
    () => clipPreview ?? props.clips,
    [clipPreview, props.clips],
  );
  const clipPositions = useMemo(() => buildClipTimeline(previewClips), [previewClips]);
  const displayCaptions = useMemo(
    () => clipPreview ? remapCaptionsToTimeline(props.captions, previewClips, []) : props.captions,
    [clipPreview, previewClips, props.captions],
  );
  const displayTranslationTracks = useMemo(() => {
    if (!clipPreview) return props.translationTracks;
    const byId = new Map(displayCaptions.map((caption) => [caption.id, caption]));
    return props.translationTracks.map((track) => ({
      ...track,
      pairs: track.pairs.map((pair) => {
        const caption = byId.get(pair.source.id);
        return caption ? { ...pair, startMs: caption.startMs, endMs: caption.endMs } : pair;
      }),
    }));
  }, [clipPreview, displayCaptions, props.translationTracks]);
  const duration = Math.max(1, props.durationMs, clipPositions.at(-1)?.afterGapEndMs ?? 0);
  const minimumScale = minimumTimelineScale(duration, Math.max(1, viewportWidth - LABEL_WIDTH));
  const [pixelsPerSecond, setPixelsPerSecond] = useState(() => Math.max(16, minimumScale));
  const effectiveScale = clampTimelineScale(pixelsPerSecond, minimumScale);
  const trackWidth = timelineWidth(duration, effectiveScale, Math.max(1, viewportWidth - LABEL_WIDTH));
  const zoomPercent = timelineZoomPercent(effectiveScale, minimumScale);
  const [zoomNotice, setZoomNotice] = useState<number>();
  const zoomTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrubEndTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrubbingRef = useRef(false);
  const scrollXRef = useRef(0);
  const [visibleCenterX, setVisibleCenterX] = useState(0);
  const lastScrubMsRef = useRef(-1);
  const pinch = useRef({ distance: 0, scale: effectiveScale });
  const captionLayout = useMemo(() => packTimelineLanes(displayCaptions), [displayCaptions]);
  const captionRowHeight = captionLayout.laneCount * LANE_HEIGHT + 10;
  const audioLayout = useMemo(() => packTimelineLanes(props.audioClips.map((clip) => ({ id: clip.id, startMs: clip.startMs, endMs: audioClipEnd(clip) }))), [props.audioClips]);
  const audioRowHeight = Math.max(1, audioLayout.laneCount) * LANE_HEIGHT + 10;
  const totalRowsHeight = 46 + audioRowHeight + props.layers.reduce(
    (sum, layer) => sum + (layer.kind === 'captions' ? captionRowHeight : 46),
    0,
  ) + props.translationTracks.length * captionRowHeight;
  const leadingPadding = Math.max(0, viewportWidth / 2 - LABEL_WIDTH);
  const trailingPadding = viewportWidth / 2;
  const scrollContentWidth = leadingPadding + LABEL_WIDTH + trackWidth + trailingPadding;
  const visibleRange = useMemo(() => {
    const buffer = Math.max(viewportWidth, 320);
    return {
      startMs: clamp((visibleCenterX - buffer) / trackWidth * duration, 0, duration),
      endMs: clamp((visibleCenterX + buffer) / trackWidth * duration, 0, duration),
    };
  }, [duration, trackWidth, viewportWidth, visibleCenterX]);
  const isVisible = (startMs: number, endMs: number) => endMs >= visibleRange.startMs && startMs <= visibleRange.endMs;

  useEffect(() => () => {
    if (zoomTimer.current) clearTimeout(zoomTimer.current);
    if (scrubEndTimer.current) clearTimeout(scrubEndTimer.current);
  }, []);

  useEffect(() => {
    if (scrubbingRef.current || gestureLock) return;
    const x = timelineScrollOffset(props.currentMs, duration, trackWidth);
    scrollXRef.current = x;
    setVisibleCenterX(x);
    horizontalRef.current?.scrollTo({ x, animated: false });
  }, [duration, gestureLock, props.currentMs, trackWidth, viewportWidth]);

  const seekFromScroll = (offset: number, force = false) => {
    const timeMs = timelineTimeAtScroll(offset, duration, trackWidth);
    if (!force && Math.abs(timeMs - lastScrubMsRef.current) < 32) return;
    lastScrubMsRef.current = timeMs;
    props.onSeek(timeMs);
  };

  const finishScrub = () => {
    if (scrubEndTimer.current) clearTimeout(scrubEndTimer.current);
    scrubbingRef.current = false;
    if (!gestureLockRef.current) seekFromScroll(scrollXRef.current, true);
  };

  const setItemGestureLock = (locked: boolean) => {
    gestureLockRef.current = locked;
    setGestureLock(locked);
  };

  const beginBlockGesture = () => {
    if (scrubEndTimer.current) clearTimeout(scrubEndTimer.current);
    scrubEndTimer.current = null;
    scrubbingRef.current = false;
    setItemGestureLock(true);
    props.onTimingChangeStart();
  };

  const endBlockGesture = () => {
    setItemGestureLock(false);
    props.onTimingChangeEnd();
  };

  const updateZoom = (next: number) => {
    const clamped = clampTimelineScale(next, minimumScale);
    setPixelsPerSecond(clamped);
    setZoomNotice(timelineZoomPercent(clamped, minimumScale));
    if (zoomTimer.current) clearTimeout(zoomTimer.current);
    zoomTimer.current = setTimeout(() => setZoomNotice(undefined), 1_100);
  };

  return (
    <View
      onLayout={(event) => setViewportWidth(Math.max(1, event.nativeEvent.layout.width))}
      onStartShouldSetResponderCapture={(event) => event.nativeEvent.touches.length === 2}
      onMoveShouldSetResponderCapture={(event) => event.nativeEvent.touches.length === 2}
      onResponderGrant={(event) => {
        const [first, second] = event.nativeEvent.touches;
        pinch.current = { distance: touchDistance(first, second), scale: effectiveScale };
      }}
      onResponderMove={(event) => {
        const [first, second] = event.nativeEvent.touches;
        if (!first || !second || pinch.current.distance <= 0) return;
        updateZoom(pinch.current.scale * touchDistance(first, second) / pinch.current.distance);
      }}
      style={{ height: Math.min(330, totalRowsHeight + RULER_HEIGHT + 38), overflow: 'hidden', borderRadius: 22, backgroundColor: '#1C1C1E' }}>
      <View style={{ height: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: '#1D242C' }}>
        <ZoomButton label="−" onPress={() => updateZoom(effectiveScale / 1.5)} />
        <Text style={{ minWidth: 118, color: '#D7DDE5', textAlign: 'center', fontSize: 11, fontWeight: '800' }}>TIMELINE {zoomPercent}%</Text>
        <ZoomButton label="+" onPress={() => updateZoom(effectiveScale * 1.5)} />
      </View>
      <ScrollView
        ref={horizontalRef}
        horizontal
        nestedScrollEnabled
        scrollEnabled={!gestureLock}
        decelerationRate="fast"
        scrollEventThrottle={32}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ width: scrollContentWidth }}
        onScrollBeginDrag={() => {
          if (gestureLockRef.current) return;
          if (scrubEndTimer.current) clearTimeout(scrubEndTimer.current);
          scrubbingRef.current = true;
          props.onScrubStart();
        }}
        onScroll={(event) => {
          const x = clamp(event.nativeEvent.contentOffset.x, 0, trackWidth);
          scrollXRef.current = x;
          if (Math.abs(x - visibleCenterX) >= Math.max(120, viewportWidth / 3)) setVisibleCenterX(x);
          if (scrubbingRef.current && !gestureLockRef.current) seekFromScroll(x);
        }}
        onScrollEndDrag={() => {
          if (scrubEndTimer.current) clearTimeout(scrubEndTimer.current);
          scrubEndTimer.current = setTimeout(finishScrub, 90);
        }}
        onMomentumScrollBegin={() => {
          if (gestureLockRef.current) return;
          if (scrubEndTimer.current) clearTimeout(scrubEndTimer.current);
          scrubbingRef.current = true;
        }}
        onMomentumScrollEnd={finishScrub}>
        <View style={{ width: LABEL_WIDTH + trackWidth, height: '100%', marginLeft: leadingPadding }}>
          <TimelineRuler durationMs={duration} trackWidth={trackWidth} pixelsPerSecond={effectiveScale} visibleStartMs={visibleRange.startMs} visibleEndMs={visibleRange.endMs} />
          <ScrollView style={{ marginTop: RULER_HEIGHT }} contentContainerStyle={{ paddingVertical: 1 }} nestedScrollEnabled scrollEnabled={!gestureLock}>
            <TimelineRow label="VIDEO" labelColor={chrome.accent} selected={Boolean(props.selectedClipId)} trackWidth={trackWidth} height={46} onPressTrack={(x) => props.onSeek(x / trackWidth * duration)} controls={<Text style={{ color: chrome.muted, fontSize: 8 }}>{props.clips.length} CLIP{props.clips.length === 1 ? '' : 'S'}</Text>}>
              {clipPositions.map((entry, index) => ({ ...entry, index })).filter(({ gapStartMs, afterGapEndMs }) => isVisible(gapStartMs, afterGapEndMs)).map(({ clip, gapStartMs, startMs, endMs, afterGapEndMs, index }) => {
                const previousEndMs = index === 0 ? 0 : clipPositions[index - 1].endMs;
                const leadingGapMs = startMs - previousEndMs;
                return (
                <Fragment key={clip.id}>
                  <VideoClipBlock
                    clip={clip}
                    leadingGapMs={leadingGapMs}
                    label={`CLIP ${index + 1}`}
                    startMs={startMs}
                    endMs={endMs}
                    durationMs={duration}
                    trackWidth={trackWidth}
                    selected={props.selectedClipId === clip.id}
                    color={index % 2 ? '#38404A' : '#46515D'}
                    onPress={() => props.onSelectClip(clip.id)}
                    onGestureLock={setItemGestureLock}
                    onTrimPreview={(edge, targetSourceMs) => {
                      setItemGestureLock(true);
                      const preview = previewVideoClipTrim(clip, edge, targetSourceMs);
                      setClipPreview(previewClips.map((candidate) => candidate.id === clip.id ? preview : candidate));
                    }}
                    onTrimCommit={(edge, targetSourceMs) => {
                      setItemGestureLock(false);
                      setClipPreview(undefined);
                      props.onTrimClip(clip.id, edge, targetSourceMs);
                    }}
                    onGapPreview={(gapBeforeMs) => {
                      setItemGestureLock(true);
                      const preview = previewVideoClipLeadingGap(props.clips, clip.id, gapBeforeMs);
                      if (preview) setClipPreview(preview);
                    }}
                    onGapCommit={(gapBeforeMs) => {
                      setItemGestureLock(false);
                      setClipPreview(undefined);
                      props.onSetClipLeadingGap(clip.id, gapBeforeMs);
                    }}
                  />
                  {startMs > gapStartMs ? (
                    <VideoGapBlock
                      startMs={gapStartMs}
                      endMs={startMs}
                      durationMs={duration}
                      trackWidth={trackWidth}
                      onPress={() => props.onSelectClip(clip.id)}
                      onRemove={() => props.onSetClipGap(clip.id, 0)}
                    />
                  ) : null}
                  {afterGapEndMs > endMs ? (
                    <VideoGapBlock
                      startMs={endMs}
                      endMs={afterGapEndMs}
                      durationMs={duration}
                      trackWidth={trackWidth}
                      accessibilityLabel={`Empty gap after ${formatGap(afterGapEndMs - endMs)}. Tap to select the preceding clip.`}
                      onPress={() => props.onSelectClip(clip.id)}
                      onRemove={() => props.onSetClipGap(clip.id, 0, 'after')}
                    />
                  ) : null}
                </Fragment>
                );
              })}
            </TimelineRow>
            <TimelineRow label="AUDIO" labelColor="#64E8FF" selected={Boolean(props.selectedAudioClipId)} trackWidth={trackWidth} height={audioRowHeight} onPressTrack={(x) => props.onSeek(x / trackWidth * duration)} controls={<Text style={{ color: '#6F7985', fontSize: 8 }}>{props.audioClips.length} TRACK{props.audioClips.length === 1 ? '' : 'S'}</Text>}>
              {props.audioClips.filter((clip) => isVisible(clip.startMs, audioClipEnd(clip))).map((clip) => {
                const source = props.audioSources.find((candidate) => candidate.id === clip.sourceId);
                return <TimedBlock key={clip.id} label={`${clip.muted ? 'MUTED · ' : ''}${source?.displayName ?? 'AUDIO'}`} startMs={clip.startMs} endMs={audioClipEnd(clip)} durationMs={duration} trackWidth={trackWidth} lane={audioLayout.laneById.get(clip.id) ?? 0} color={clip.muted ? '#59636F' : '#00B8C7'} selected={props.selectedAudioClipId === clip.id} onPress={() => props.onSelectAudioClip(clip.id)} onChangeStart={beginBlockGesture} onChange={(edge, startMs, endMs) => { if (edge !== 'move') props.onAudioTimingChange(clip.id, edge, startMs, endMs); }} onEnd={endBlockGesture} />;
              })}
            </TimelineRow>
            {props.layers.map((layer, layerIndex) => {
              const isCaptions = layer.kind === 'captions';
              return (
                <View key={layer.id}>
                <TimelineRow
                  label={layer.name.toUpperCase()}
                  labelColor={isCaptions ? '#FF4FD8' : layer.kind === 'text' ? '#A985F8' : '#64E8FF'}
                  selected={props.selectedLayerId === layer.id && !props.selectedClipId}
                  onPressLabel={() => props.onSelectLayer(layer.id)}
                  onPressTrack={(x) => props.onSeek(x / trackWidth * duration)}
                  trackWidth={trackWidth}
                  height={isCaptions ? captionRowHeight : 46}
                  controls={<View style={{ gap: 2 }}>
                    {isCaptions && captionLayout.laneCount > 1 ? <Text style={{ color: '#19D98B', fontSize: 7, fontWeight: '800' }}>{captionLayout.laneCount} AUTO LANES</Text> : null}
                    <View style={{ flexDirection: 'row', gap: 4 }}>
                      <TinyButton label="↑" disabled={layerIndex === 0} onPress={() => props.onMoveLayer(layer.id, -1)} />
                      <TinyButton label="↓" disabled={layerIndex === props.layers.length - 1} onPress={() => props.onMoveLayer(layer.id, 1)} />
                      {!isCaptions ? <TinyButton label="×" danger onPress={() => props.onDeleteLayer(layer.id)} /> : null}
                    </View>
                  </View>}>
                  {isCaptions ? displayCaptions.map((caption, index) => ({ caption, index })).filter(({ caption }) => isVisible(caption.startMs, caption.endMs)).map(({ caption, index }) => (
                    <TimedBlock key={caption.id} label={caption.text} startMs={caption.startMs} endMs={caption.endMs} durationMs={duration} trackWidth={trackWidth} lane={captionLayout.laneById.get(caption.id) ?? 0} color={NEON_CAPTION_COLORS[index % NEON_CAPTION_COLORS.length]} selected={props.selectedCaptionId === caption.id} movable onPress={() => props.onSelectCaption(caption)} onChangeStart={beginBlockGesture} onChange={(edge, startMs, endMs) => props.onCaptionTimingChange(caption.id, edge, startMs, endMs)} onEnd={endBlockGesture} />
                  )) : (
                    <TimedBlock label={layer.kind === 'text' ? layer.text : 'IMAGE'} startMs={layer.startMs} endMs={layer.endMs} durationMs={duration} trackWidth={trackWidth} lane={0} color={layer.kind === 'text' ? '#A855F7' : '#00B8FF'} selected={props.selectedLayerId === layer.id} onPress={() => props.onSelectLayer(layer.id)} onChangeStart={beginBlockGesture} onChange={(_edge, startMs, endMs) => props.onLayerTimingChange(layer.id, startMs, endMs)} onEnd={endBlockGesture} />
                  )}
                </TimelineRow>
                {isCaptions ? displayTranslationTracks.map((track, trackIndex) => (
                  <TimelineRow
                    key={track.id}
                    label={`↳ ${track.name.toUpperCase()}`}
                    labelColor={track.visible ? '#64E8FF' : '#6E7884'}
                    selected={props.selectedLayerId === track.id && !props.selectedClipId}
                    onPressLabel={() => {
                      const first = track.pairs.find((pair) => pair.timelineVisible);
                      if (first) props.onSelectTranslationCaption(track.id, first);
                    }}
                    onPressTrack={(x) => props.onSeek(x / trackWidth * duration)}
                    trackWidth={trackWidth}
                    height={captionRowHeight}
                    controls={<Text style={{ color: track.visible ? '#19D98B' : '#7B8591', fontSize: 7, fontWeight: '900' }}>{track.visible ? 'VISIBLE · INDEPENDENT' : 'HIDDEN · INDEPENDENT'}</Text>}>
                    {track.pairs.filter((pair) => pair.timelineVisible && isVisible(pair.startMs, pair.endMs)).map((pair, pairIndex) => (
                      <TimedBlock
                        key={pair.translation.id}
                        label={pair.translation.text || 'Translation pending'}
                        startMs={pair.startMs}
                        endMs={pair.endMs}
                        durationMs={duration}
                        trackWidth={trackWidth}
                        lane={0}
                        color={pair.translation.status === 'stale' || pair.translation.status === 'pending' || pair.translation.status === 'failed'
                          ? '#A66220'
                          : NEON_CAPTION_COLORS[(pairIndex + trackIndex + 1) % NEON_CAPTION_COLORS.length]}
                        selected={props.selectedLayerId === track.id && props.selectedCaptionId === pair.source.id}
                        movable
                        onPress={() => props.onSelectTranslationCaption(track.id, pair)}
                        onChangeStart={beginBlockGesture}
                        onChange={(edge, startMs, endMs) => props.onTranslationCaptionTimingChange(track.id, pair.source.id, edge, startMs, endMs)}
                        onEnd={endBlockGesture}
                      />
                    ))}
                  </TimelineRow>
                )) : null}
                </View>
              );
            })}
          </ScrollView>
        </View>
      </ScrollView>
      <View pointerEvents="none" style={{ position: 'absolute', left: '50%', top: 36, bottom: 0, width: 2, marginLeft: -1, backgroundColor: '#FF5267' }}>
        <View style={{ position: 'absolute', left: -7, top: 0, width: 0, height: 0, borderLeftWidth: 8, borderRightWidth: 8, borderTopWidth: 11, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: '#FF5267' }} />
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Add videos to the end of the timeline" onPress={props.onAddVideos} style={{ position: 'absolute', right: 8, top: 2, width: 34, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 17, backgroundColor: '#64D2FF' }}>
        <Text style={{ color: '#11140C', fontSize: 22, fontWeight: '700', lineHeight: 25 }}>+</Text>
      </Pressable>
      {zoomNotice == null ? null : <View pointerEvents="none" style={{ position: 'absolute', alignSelf: 'center', top: 72, paddingHorizontal: 16, paddingVertical: 9, borderRadius: 14, backgroundColor: 'rgba(5,7,9,0.92)' }}><Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '900' }}>{zoomNotice}%</Text></View>}
    </View>
  );
}

function TimelineRuler(props: { durationMs: number; trackWidth: number; pixelsPerSecond: number; visibleStartMs: number; visibleEndMs: number }) {
  const interval = timelineTickInterval(props.pixelsPerSecond);
  const firstTick = Math.max(0, Math.floor(props.visibleStartMs / interval) - 1);
  const lastTick = Math.min(Math.ceil(props.durationMs / interval), Math.ceil(props.visibleEndMs / interval) + 1);
  return <View style={{ position: 'absolute', left: 0, top: 0, width: LABEL_WIDTH + props.trackWidth, height: RULER_HEIGHT, borderBottomWidth: 1, borderBottomColor: '#2B333D' }}><Text style={{ position: 'absolute', left: 8, top: 8, color: '#7D8794', fontSize: 8, fontWeight: '800' }}>TIME</Text>{Array.from({ length: lastTick - firstTick + 1 }, (_, offset) => { const timeMs = (firstTick + offset) * interval; const left = LABEL_WIDTH + timeMs / props.durationMs * props.trackWidth; return <View key={timeMs} style={{ position: 'absolute', left, top: 0, height: RULER_HEIGHT, borderLeftWidth: 1, borderLeftColor: '#64707D' }}><Text style={{ marginLeft: 4, marginTop: 5, color: '#AEB7C2', fontSize: 8, fontVariant: ['tabular-nums'] }}>{formatRulerTime(timeMs, interval)}</Text></View>; })}</View>;
}

function VideoClipBlock(props: {
  clip: VideoClip;
  leadingGapMs: number;
  label: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  trackWidth: number;
  selected: boolean;
  color: string;
  onPress: () => void;
  onGestureLock: (locked: boolean) => void;
  onTrimPreview: (edge: 'start' | 'end', targetSourceMs: number) => void;
  onTrimCommit: (edge: 'start' | 'end', targetSourceMs: number) => void;
  onGapPreview: (gapBeforeMs: number) => void;
  onGapCommit: (gapBeforeMs: number) => void;
}) {
  const clipDuration = Math.max(120, props.endMs - props.startMs);
  return (
    <View
      style={{
        position: 'absolute',
        left: props.startMs / props.durationMs * props.trackWidth,
        width: Math.max(2, clipDuration / props.durationMs * props.trackWidth - 2),
        top: 3,
        bottom: 3,
        justifyContent: 'center',
        paddingHorizontal: 16,
        borderRadius: chrome.radius.sm,
        borderWidth: props.selected ? 2 : 0,
        borderColor: chrome.accent,
        backgroundColor: props.color,
      }}>
      <Text pointerEvents="none" numberOfLines={1} style={{ color: '#F7F8FA', fontSize: 8, fontWeight: '800' }}>{props.label}</Text>
      <VideoMoveGrip {...props} />
      {props.selected ? (
        <>
          <VideoTrimGrip side="start" {...props} />
          <VideoTrimGrip side="end" {...props} />
        </>
      ) : null}
    </View>
  );
}

function VideoTrimGrip(props: Parameters<typeof VideoClipBlock>[0] & { side: 'start' | 'end' }) {
  const propsRef = useRef(props);
  propsRef.current = props;
  const targetRef = useRef(props.side === 'start' ? props.clip.sourceStartMs : props.clip.sourceEndMs);
  const initialClipRef = useRef(props.clip);
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
    onPanResponderGrant: () => {
      propsRef.current.onPress();
      propsRef.current.onGestureLock(true);
      initialClipRef.current = propsRef.current.clip;
      targetRef.current = propsRef.current.side === 'start'
        ? initialClipRef.current.sourceStartMs
        : initialClipRef.current.sourceEndMs;
    },
    onPanResponderMove: (_event, gesture) => {
      const timelineDelta = gesture.dx / Math.max(1, propsRef.current.trackWidth) * propsRef.current.durationMs;
      const sourceDelta = timelineDelta * initialClipRef.current.playbackRate;
      const target = propsRef.current.side === 'start'
        ? clamp(
            initialClipRef.current.sourceStartMs + sourceDelta,
            initialClipRef.current.availableSourceStartMs,
            initialClipRef.current.sourceEndMs - 120 * initialClipRef.current.playbackRate,
          )
        : clamp(
            initialClipRef.current.sourceEndMs + sourceDelta,
            initialClipRef.current.sourceStartMs + 120 * initialClipRef.current.playbackRate,
            initialClipRef.current.availableSourceEndMs,
          );
      targetRef.current = target;
      propsRef.current.onTrimPreview(propsRef.current.side, target);
    },
    onPanResponderRelease: () => propsRef.current.onTrimCommit(propsRef.current.side, targetRef.current),
    onPanResponderTerminate: () => propsRef.current.onTrimCommit(propsRef.current.side, targetRef.current),
  }), []);
  return (
    <View
      {...responder.panHandlers}
      accessibilityRole="adjustable"
      accessibilityLabel={`${props.side === 'start' ? 'Start' : 'End'} trim handle`}
      style={{ position: 'absolute', [props.side === 'start' ? 'left' : 'right']: 0, top: -3, bottom: -3, width: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#64D2FF' }}>
      <View pointerEvents="none" style={{ width: 3, height: 18, borderRadius: 2, backgroundColor: '#172007' }} />
    </View>
  );
}

function VideoMoveGrip(props: Parameters<typeof VideoClipBlock>[0]) {
  const propsRef = useRef(props);
  propsRef.current = props;
  const gapRef = useRef(props.leadingGapMs);
  const initialGapRef = useRef(props.leadingGapMs);
  const draggedRef = useRef(false);
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
    onPanResponderGrant: () => {
      propsRef.current.onPress();
      propsRef.current.onGestureLock(true);
      initialGapRef.current = propsRef.current.leadingGapMs;
      gapRef.current = initialGapRef.current;
      draggedRef.current = false;
    },
    onPanResponderMove: (_event, gesture) => {
      if (Math.abs(gesture.dx) <= 6 || Math.abs(gesture.dx) <= Math.abs(gesture.dy)) return;
      draggedRef.current = true;
      const delta = gesture.dx / Math.max(1, propsRef.current.trackWidth) * propsRef.current.durationMs;
      const gap = clamp(initialGapRef.current + delta, 0, 60 * 60_000);
      gapRef.current = gap;
      propsRef.current.onGapPreview(gap);
    },
    onPanResponderRelease: () => {
      if (draggedRef.current) propsRef.current.onGapCommit(gapRef.current);
      else propsRef.current.onGestureLock(false);
    },
    onPanResponderTerminate: () => {
      if (draggedRef.current) propsRef.current.onGapCommit(gapRef.current);
      else propsRef.current.onGestureLock(false);
    },
  }), []);
  return (
    <View
      {...responder.panHandlers}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={`${props.label}. Tap to select. Drag horizontally to add or remove empty space before this clip.`}
      style={{ position: 'absolute', left: props.selected ? 16 : 0, right: props.selected ? 16 : 0, top: 0, bottom: 0 }}
    />
  );
}

function VideoGapBlock(props: { startMs: number; endMs: number; durationMs: number; trackWidth: number; accessibilityLabel?: string; onPress: () => void; onRemove: () => void }) {
  const gapMs = props.endMs - props.startMs;
  const width = Math.max(4, gapMs / props.durationMs * props.trackWidth - 1);
  const closeLeft = width >= 40 ? 4 : Math.max(0, (width - 32) / 2);
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? `Empty gap ${formatGap(gapMs)}. Tap to select the following clip.`}
      style={{ position: 'absolute', left: props.startMs / props.durationMs * props.trackWidth, width, top: 3, bottom: 3, zIndex: 4, alignItems: 'center', justifyContent: 'center', overflow: 'visible', borderWidth: 1, borderStyle: 'dashed', borderColor: '#8994A1', backgroundColor: '#20252B' }}>
      <Text pointerEvents="none" numberOfLines={1} style={{ color: '#C5CDD6', fontSize: 7, fontWeight: '900' }}>GAP {formatGap(gapMs)}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Remove this gap"
        hitSlop={12}
        onPress={props.onRemove}
        style={{ position: 'absolute', left: closeLeft, top: '50%', marginTop: -16, width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: '#4A1822', zIndex: 5 }}>
        <Text style={{ color: '#FF7C8D', fontSize: 22, fontWeight: '900', lineHeight: 24 }}>×</Text>
      </Pressable>
    </Pressable>
  );
}

function TimelineRow(props: { label: string; labelColor: string; selected?: boolean; controls: React.ReactNode; children: React.ReactNode; onPressLabel?: () => void; onPressTrack?: (x: number) => void; trackWidth: number; height: number }) {
  return (
    <View style={{ width: LABEL_WIDTH + props.trackWidth, height: props.height, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#1D242C' }}>
      <Pressable onPress={props.onPressLabel} style={{ width: LABEL_WIDTH, height: '100%', paddingHorizontal: 6, justifyContent: 'center', gap: 2, backgroundColor: props.selected ? '#252D22' : 'transparent' }}>
        <Text numberOfLines={1} style={{ color: props.labelColor, fontSize: 8, fontWeight: '900' }}>{props.label}</Text>
        {props.controls}
      </Pressable>
      <View style={{ width: props.trackWidth, height: props.height - 8, borderRadius: 7, backgroundColor: '#171D23', overflow: 'visible' }}>
        <Pressable onPress={(event) => props.onPressTrack?.(event.nativeEvent.locationX)} style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }} />
        <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}>
          {props.children}
        </View>
      </View>
    </View>
  );
}

function TimedBlock(props: { label: string; startMs: number; endMs: number; durationMs: number; trackWidth: number; lane: number; color: string; selected: boolean; movable?: boolean; onPress: () => void; onChangeStart: () => void; onChange: (edge: 'start' | 'end' | 'move', startMs: number, endMs: number) => void; onEnd: () => void }) {
  const width = Math.max(2, (props.endMs - props.startMs) / props.durationMs * props.trackWidth - 2);
  return (
    <View style={{ position: 'absolute', left: props.startMs / props.durationMs * props.trackWidth, width, top: props.lane * LANE_HEIGHT + 3, height: LANE_HEIGHT - 6, zIndex: props.selected ? 6 : 1, justifyContent: 'center', paddingHorizontal: 9, borderRadius: 7, borderWidth: props.selected ? 2 : 1, borderColor: props.selected ? '#FFFFFF' : `${props.color}CC`, backgroundColor: `${props.color}B8`, shadowColor: props.color, shadowOpacity: props.selected ? 0.8 : 0.35, shadowRadius: 5 }}>
      <Text pointerEvents="none" numberOfLines={1} style={{ color: '#FFFFFF', fontSize: 8, fontWeight: '900' }}>{props.label}</Text>
      {props.movable ? <CaptionMoveGrip {...props} /> : (
        <Pressable onPress={props.onPress} style={{ position: 'absolute', left: props.selected ? 24 : 0, right: props.selected ? 24 : 0, top: 0, bottom: 0 }} />
      )}
      {props.selected ? (
        <>
          <TimingGrip side="start" {...props} />
          <TimingGrip side="end" {...props} />
        </>
      ) : null}
    </View>
  );
}

function CaptionMoveGrip(props: Parameters<typeof TimedBlock>[0]) {
  const propsRef = useRef(props);
  propsRef.current = props;
  const origin = useRef({ startMs: props.startMs, endMs: props.endMs });
  const draggedRef = useRef(false);
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
    onPanResponderGrant: () => {
      propsRef.current.onPress();
      origin.current = { startMs: propsRef.current.startMs, endMs: propsRef.current.endMs };
      draggedRef.current = false;
      propsRef.current.onChangeStart();
    },
    onPanResponderMove: (_event, gesture) => {
      if (Math.abs(gesture.dx) <= 6 || Math.abs(gesture.dx) <= Math.abs(gesture.dy)) return;
      if (!draggedRef.current) {
        draggedRef.current = true;
      }
      const delta = gesture.dx / Math.max(1, propsRef.current.trackWidth) * propsRef.current.durationMs;
      propsRef.current.onChange('move', origin.current.startMs + delta, origin.current.endMs + delta);
    },
    onPanResponderRelease: () => {
      propsRef.current.onEnd();
    },
    onPanResponderTerminate: () => {
      propsRef.current.onEnd();
    },
  }), []);
  return (
    <View
      {...responder.panHandlers}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={`${props.label}. Tap to select. Drag to move this subtitle without changing the ones next to it.`}
      style={{ position: 'absolute', left: props.selected ? 24 : 0, right: props.selected ? 24 : 0, top: 0, bottom: 0 }}
    />
  );
}

function TimingGrip(props: Parameters<typeof TimedBlock>[0] & { side: 'start' | 'end' }) {
  const propsRef = useRef(props);
  propsRef.current = props;
  const start = useRef({ startMs: props.startMs, endMs: props.endMs });
  const responder = useMemo(() => PanResponder.create({ onStartShouldSetPanResponder: () => true, onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dx) > 2, onPanResponderTerminationRequest: () => false, onShouldBlockNativeResponder: () => true, onPanResponderGrant: () => { propsRef.current.onPress(); propsRef.current.onChangeStart(); start.current = { startMs: propsRef.current.startMs, endMs: propsRef.current.endMs }; }, onPanResponderMove: (_event, gesture) => { const delta = gesture.dx / Math.max(1, propsRef.current.trackWidth) * propsRef.current.durationMs; if (propsRef.current.side === 'start') propsRef.current.onChange('start', clamp(start.current.startMs + delta, 0, start.current.endMs - 80), start.current.endMs); else propsRef.current.onChange('end', start.current.startMs, clamp(start.current.endMs + delta, start.current.startMs + 80, propsRef.current.durationMs)); }, onPanResponderRelease: () => propsRef.current.onEnd(), onPanResponderTerminate: () => propsRef.current.onEnd() }), []);
  return <View {...responder.panHandlers} accessible accessibilityRole="adjustable" accessibilityLabel={`${props.side === 'start' ? 'Start' : 'End'} subtitle boundary. Drag to move this boundary.`} hitSlop={{ top: 6, bottom: 6 }} style={{ position: 'absolute', [props.side === 'start' ? 'left' : 'right']: -20, top: 0, bottom: 0, width: 20, borderRadius: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF' }}><View pointerEvents="none" style={{ width: 3, height: 16, borderRadius: 2, backgroundColor: '#151A20' }} /></View>;
}

function TinyButton(props: { label: string; danger?: boolean; disabled?: boolean; onPress: () => void }) { return <Pressable disabled={props.disabled} onPress={props.onPress} hitSlop={5} style={{ opacity: props.disabled ? 0.25 : 1 }}><Text style={{ color: props.danger ? '#FF7C8D' : '#9FAAB6', fontSize: 11, fontWeight: '900' }}>{props.label}</Text></Pressable>; }
function ZoomButton(props: { label: string; onPress: () => void }) { return <Pressable accessibilityRole="button" accessibilityLabel={props.label === '+' ? 'Zoom timeline in' : 'Zoom timeline out'} onPress={props.onPress} style={{ width: 42, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: '#2C2C2E' }}><Text style={{ color: '#64D2FF', fontSize: 20, fontWeight: '600' }}>{props.label}</Text></Pressable>; }
function formatRulerTime(ms: number, intervalMs: number) { const minutes = Math.floor(ms / 60_000); const seconds = (ms % 60_000) / 1000; return intervalMs < 1000 ? `${minutes}:${seconds.toFixed(intervalMs < 500 ? 2 : 1).padStart(4, '0')}` : `${minutes}:${Math.floor(seconds).toString().padStart(2, '0')}`; }
function formatGap(ms: number) { return `${(Math.max(0, ms) / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`; }
function touchDistance(first?: { pageX: number; pageY: number }, second?: { pageX: number; pageY: number }) { if (!first || !second) return 0; return Math.hypot(first.pageX - second.pageX, first.pageY - second.pageY); }
function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }
