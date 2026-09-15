import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';

import { chrome } from '@/lib/ui-theme';
import { indexTimelineCues, packTimelineLanes, timelineCuePage, TIMELINE_MARKER_HEIGHT } from '@/lib/timeline-layout';
import { previewVideoClipLeadingGap, previewVideoClipReorder, previewVideoClipTrim } from '@/lib/project-editor';
import {
  clampTimelineScale,
  minimumTimelineScale,
  reorderAutoScrollOffset,
  reorderFilmstripWidth,
  reorderScrollOffsetForTile,
  reorderTrackWidth,
  timelineScrollOffset,
  timelineTickInterval,
  timelineTimeAtScroll,
  timelineWidth,
  timelineZoomPercent,
} from '@/lib/timeline-scale';
import { buildClipTimeline, remapCaptionsToTimeline } from '@/lib/video-timeline';
import { audioClipEnd } from '@/lib/audio-timeline';
import { audioWaveformWindow } from '@/lib/audio-waveform';
import { adjustTimelineTiming, TIMELINE_ACCESSIBILITY_ACTIONS, timelineTimingLabel, createTimelineTimingGesture, timelineBlockControls, timelineControlRail, timelineVisibleTrackBounds, type TimelineTrackBounds, TIMELINE_GRIP_WIDTH, TIMELINE_CONTROL_HEIGHT } from '@/lib/timeline-gesture';
import { ensureClipFrameThumbnail } from '@/services/project-media';
import type { CaptionPair } from '@/lib/caption-tracks';
import type { TimelineItemReference, TimelineTimingEdge } from '@/lib/timeline-item-editor';
import type { AudioClip, CaptionBlock, ProjectAudioSource, ProjectVideoSource, VideoClip, VisualLayer } from '@/types/project';

const LABEL_WIDTH = 82;
const RULER_HEIGHT = 28;
const LANE_HEIGHT = 32;
const REORDER_TILE = 72;
const REORDER_GAP = 8;
const NEON_CAPTION_COLORS = ['#FF2FA9', '#00B8FF', '#19D98B', '#A855F7', '#FF4D6D', '#00D9C8'];
const clipThumbCache = new Map<string, string>();

export function LayerTimeline(props: {
  projectId: string;
  durationMs: number;
  clips: VideoClip[];
  sources: ProjectVideoSource[];
  layers: VisualLayer[];
  captions: CaptionBlock[];
  translationTracks: { id: string; name: string; visible: boolean; pairs: CaptionPair[] }[];
  currentMs: number;
  selectedLayerId?: string;
  selectedCaptionId?: string;
  selectedClipId?: string;
  audioSources: ProjectAudioSource[];
  audioClips: AudioClip[];
  selectedAudioClipId?: string;
  onSeek: (timeMs: number) => void;
  onScrubStart: () => void;
  onClearSelection: () => void;
  onSelectLayer: (id: string) => void;
  onSelectCaption: (caption: CaptionBlock) => void;
  onSelectTranslationCaption: (trackId: string, pair: CaptionPair) => void;
  onSelectClip: (clipId: string) => void;
  onTrimClip: (clipId: string, edge: 'start' | 'end', targetSourceMs: number) => void;
  onSetClipGap: (clipId: string, gapMs: number, edge?: 'before' | 'after') => void;
  onSetClipLeadingGap: (clipId: string, gapMs: number) => void;
  onReorderClip: (clipId: string, toIndex: number) => void;
  onItemTimingChange: (item: TimelineItemReference, edge: TimelineTimingEdge, startMs: number, endMs: number) => void;
  onTimingChangeStart: () => void;
  onTimingChangeEnd: () => void;
  onMoveLayer: (layerId: string, direction: -1 | 1) => void;
  onDeleteLayer: (layerId: string) => void;
  onAddVideos: () => void;
  onSelectAudioClip: (clipId: string) => void;
}) {
  const horizontalRef = useRef<ScrollView>(null);
  const verticalRef = useRef<ScrollView>(null);
  const [cueNumber, setCueNumber] = useState('');
  const [viewportWidth, setViewportWidth] = useState(360);
  const [clipPreview, setClipPreview] = useState<VideoClip[]>();
  const [reorderDrag, setReorderDrag] = useState<{ clipId: string; toIndex: number }>();
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
  const viewportContentWidth = Math.max(1, viewportWidth - LABEL_WIDTH);
  const baseTrackWidth = timelineWidth(duration, effectiveScale, viewportContentWidth);
  const reorderMode = Boolean(reorderDrag);
  const filmstripWidth = reorderFilmstripWidth(previewClips.length, REORDER_TILE, REORDER_GAP);
  const trackWidth = reorderMode
    ? reorderTrackWidth(filmstripWidth, viewportContentWidth)
    : baseTrackWidth;
  const zoomPercent = timelineZoomPercent(effectiveScale, minimumScale);
  const [zoomNotice, setZoomNotice] = useState<number>();
  const zoomTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrubEndTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrubbingRef = useRef(false);
  const scrollXRef = useRef(0);
  const [viewportScrollX, setViewportScrollX] = useState(0);
  const [visibleCenterX, setVisibleCenterX] = useState(0);
  const lastScrubMsRef = useRef(-1);
  const pinch = useRef({ distance: 0, scale: effectiveScale });
  const captionIndex = useMemo(() => indexTimelineCues(displayCaptions), [displayCaptions]);
  const translationIndexes = useMemo(() => new Map(displayTranslationTracks.map((track) => [track.id,
    indexTimelineCues(track.pairs.filter((pair) => pair.timelineVisible).map((pair) => ({
      id: pair.source.id, startMs: pair.startMs, endMs: pair.endMs, pair,
    }))),
  ])), [displayTranslationTracks]);
  const leadingPadding = Math.max(0, viewportWidth / 2 - LABEL_WIDTH);
  const visibleTrackBounds = useMemo(() => timelineVisibleTrackBounds(viewportScrollX, viewportWidth, trackWidth, leadingPadding + LABEL_WIDTH),
    [viewportScrollX, viewportWidth, trackWidth, leadingPadding]);
  const captionPage = useMemo(() => timelineCuePage(captionIndex, duration, trackWidth, visibleTrackBounds,
    props.selectedLayerId === 'captions' ? props.selectedCaptionId : undefined),
  [captionIndex, duration, trackWidth, visibleTrackBounds, props.selectedLayerId, props.selectedCaptionId]);
  const translationPages = useMemo(() => new Map([...translationIndexes].map(([id, index]) => [id,
    timelineCuePage(index, duration, trackWidth, visibleTrackBounds, props.selectedLayerId === id ? props.selectedCaptionId : undefined),
  ])), [translationIndexes, duration, trackWidth, visibleTrackBounds, props.selectedLayerId, props.selectedCaptionId]);
  const captionLayout = captionPage.layout;
  const captionRowHeight = captionPage.height;
  const translationRowHeight = (id: string) => translationPages.get(id)!.height;
  const activeIndex = props.selectedLayerId === 'captions' ? captionIndex : translationIndexes.get(props.selectedLayerId ?? '');
  const selectedOrdinal = activeIndex?.byId.get(props.selectedCaptionId ?? '');
  const selectedCue = selectedOrdinal === undefined ? undefined : activeIndex?.ordered[selectedOrdinal];
  const footerHeight = selectedCue ? 44 + TIMELINE_CONTROL_HEIGHT : 0;
  const audioLayout = useMemo(() => packTimelineLanes(props.audioClips.map((clip) => ({ id: clip.id, startMs: clip.startMs, endMs: audioClipEnd(clip) }))), [props.audioClips]);
  const audioRowHeight = Math.max(1, audioLayout.laneCount) * LANE_HEIGHT + 10
    + (props.selectedAudioClipId ? TIMELINE_CONTROL_HEIGHT : 0);
  const visualRowHeight = (id: string) => 46 + (props.selectedLayerId === id ? TIMELINE_CONTROL_HEIGHT : 0);
  const videoRowHeight = reorderMode ? REORDER_TILE + 18 : 46;
  const sourceById = useMemo(() => new Map(props.sources.map((source) => [source.id, source])), [props.sources]);
  const totalRowsHeight = videoRowHeight + audioRowHeight + props.layers.reduce(
    (sum, layer) => sum + (layer.kind === 'captions' ? captionRowHeight : visualRowHeight(layer.id)),
    0,
  ) + props.translationTracks.reduce((sum, track) => sum + translationRowHeight(track.id), 0);

  const trailingPadding = viewportWidth / 2;
  const scrollContentWidth = leadingPadding + LABEL_WIDTH + trackWidth + trailingPadding;
  const visibleRange = useMemo(() => {
    const buffer = Math.max(viewportWidth, 320);
    return {
      startMs: clamp((visibleCenterX - buffer) / trackWidth * duration, 0, duration),
      endMs: clamp((visibleCenterX + buffer) / trackWidth * duration, 0, duration),
    };
  }, [duration, trackWidth, viewportWidth, visibleCenterX]);
  const isVisible = (startMs: number, endMs: number) =>
    reorderMode || (endMs >= visibleRange.startMs && startMs <= visibleRange.endMs);

  // Selection navigation owns only scroll position, never the transport. Row
  // heights are bounded, so the entire selected marker row fits above the dock.
  const selectedRowTop = (() => {
    let top = videoRowHeight + audioRowHeight;
    for (const layer of props.layers) {
      if (layer.id === props.selectedLayerId) return top;
      top += layer.kind === 'captions' ? captionRowHeight : visualRowHeight(layer.id);
      if (layer.kind === 'captions') for (const track of displayTranslationTracks) {
        if (track.id === props.selectedLayerId) return top;
        top += translationRowHeight(track.id);
      }
    }
    return 0;
  })();
  const revealCue = useCallback((startMs: number) => {
    scrubbingRef.current = false;
    const x = timelineScrollOffset(startMs, duration, trackWidth);
    scrollXRef.current = x;
    setViewportScrollX(x);
    setVisibleCenterX(x);
    horizontalRef.current?.scrollTo({ x, animated: false });
    verticalRef.current?.scrollTo({ y: selectedRowTop, animated: false });
  }, [duration, selectedRowTop, trackWidth]);
  const lastRevealRef = useRef<{ id: string; trackWidth: number; viewportWidth: number } | undefined>(undefined);
  const hasSelectedCue = selectedCue !== undefined;
  useEffect(() => {
    if (hasSelectedCue) verticalRef.current?.scrollTo({ y: selectedRowTop, animated: false });
  }, [hasSelectedCue, selectedRowTop]);

  useEffect(() => () => {
    if (zoomTimer.current) clearTimeout(zoomTimer.current);
    if (scrubEndTimer.current) clearTimeout(scrubEndTimer.current);
  }, []);

  useEffect(() => () => {
    gestureLockRef.current = false;
    setGestureLock(false);
    setReorderDrag(undefined);
    setClipPreview(undefined);
  }, []);

  useEffect(() => {
    if (scrubbingRef.current || gestureLock) return;
    const x = timelineScrollOffset(props.currentMs, duration, trackWidth);
    scrollXRef.current = x;
    setViewportScrollX(x);
    setVisibleCenterX(x);
    horizontalRef.current?.scrollTo({ x, animated: false });
  }, [duration, gestureLock, props.currentMs, trackWidth, viewportWidth]);

  useEffect(() => {
    if (!selectedCue) { lastRevealRef.current = undefined; return; }
    const id = `${props.selectedLayerId}:${props.selectedCaptionId}`;
    const last = lastRevealRef.current;
    if (last?.id === id && last.trackWidth === trackWidth && last.viewportWidth === viewportWidth) return;
    lastRevealRef.current = { id, trackWidth, viewportWidth };
    if (last?.id !== id) setCueNumber('');
    revealCue(selectedCue.startMs);
  }, [props.selectedLayerId, props.selectedCaptionId, selectedCue, trackWidth, viewportWidth, revealCue]);

  useEffect(() => {
    if (!reorderDrag) return;
    const activeIndex = previewClips.findIndex((clip) => clip.id === reorderDrag.clipId);
    const focusIndex = activeIndex >= 0 ? activeIndex : reorderDrag.toIndex;
    const enterOffset = reorderScrollOffsetForTile(
      focusIndex,
      REORDER_TILE,
      REORDER_GAP,
      trackWidth,
      viewportContentWidth,
    );
    const x = reorderAutoScrollOffset(
      enterOffset,
      reorderDrag.toIndex,
      REORDER_TILE,
      REORDER_GAP,
      trackWidth,
      viewportWidth,
    );
    scrollXRef.current = x;
    horizontalRef.current?.scrollTo({ x, animated: false });
  }, [previewClips, reorderDrag, trackWidth, viewportContentWidth, viewportWidth]);

  const seekFromScroll = (offset: number, force = false) => {
    const timeMs = timelineTimeAtScroll(offset, duration, trackWidth);
    if (!force && Math.abs(timeMs - lastScrubMsRef.current) < 32) return;
    lastScrubMsRef.current = timeMs;
    props.onSeek(timeMs);
  };

  const finishScrub = () => {
    if (scrubEndTimer.current) clearTimeout(scrubEndTimer.current);
    if (!scrubbingRef.current) return;
    scrubbingRef.current = false;
    if (!gestureLockRef.current) seekFromScroll(scrollXRef.current, true);
  };

  const setItemGestureLock = (locked: boolean) => {
    gestureLockRef.current = locked;
    setGestureLock(locked);
  };

  const selectTimelineItem = (select: () => void) => {
    if (scrubEndTimer.current) clearTimeout(scrubEndTimer.current);
    scrubEndTimer.current = null;
    scrubbingRef.current = false;
    select();
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

  const selectOrdinal = (ordinal: number) => {
    const cue = activeIndex?.ordered[ordinal];
    if (!cue) return;
    selectTimelineItem(() => {
      if ('pair' in cue) props.onSelectTranslationCaption(props.selectedLayerId!, cue.pair);
      else props.onSelectCaption(cue);
    });
    setCueNumber('');
    revealCue(cue.startMs);
  };
  const jumpToCueNumber = () => {
    if (/^\d+$/.test(cueNumber)) selectOrdinal(Number(cueNumber) - 1);
  };
  const selectedControlProps = selectedCue ? {
    label: 'pair' in selectedCue ? selectedCue.pair.translation.text : selectedCue.text,
    startMs: selectedCue.startMs, endMs: selectedCue.endMs, durationMs: duration,
    trackWidth, lane: 0, controlTop: 0, color: '#334155', selected: true,
    onPress: () => selectTimelineItem(() => {
      if ('pair' in selectedCue) props.onSelectTranslationCaption(props.selectedLayerId!, selectedCue.pair);
      else props.onSelectCaption(selectedCue);
    }),
    onChangeStart: beginBlockGesture,
    onChange: (edge: TimelineTimingEdge, startMs: number, endMs: number) => props.onItemTimingChange(
      'pair' in selectedCue ? { kind: 'translation', trackId: props.selectedLayerId!, sourceCaptionId: selectedCue.id }
        : { kind: 'caption', captionId: selectedCue.id }, edge, startMs, endMs),
    onEnd: endBlockGesture,
  } : undefined;

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
      style={{ height: Math.min(330, totalRowsHeight + RULER_HEIGHT + 38 + footerHeight), overflow: 'hidden', borderRadius: 22, backgroundColor: '#1C1C1E' }}>
      <View style={{ height: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: '#1D242C' }}>
        <ZoomButton label="−" onPress={() => updateZoom(effectiveScale / 1.5)} />
        <Text style={{ minWidth: 118, color: '#D7DDE5', textAlign: 'center', fontSize: 11, fontWeight: '800' }}>TIMELINE {zoomPercent}%</Text>
        <ZoomButton label="+" onPress={() => updateZoom(effectiveScale * 1.5)} />
      </View>
      <ScrollView
        ref={horizontalRef}
        style={{ flex: 1 }}
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
          setViewportScrollX(x);
          if (Math.abs(x - visibleCenterX) >= Math.max(120, viewportWidth / 3)) setVisibleCenterX(x);
          if (scrubbingRef.current && !gestureLockRef.current) seekFromScroll(x);
        }}
        onScrollEndDrag={() => {
          if (!scrubbingRef.current) return;
          if (scrubEndTimer.current) clearTimeout(scrubEndTimer.current);
          scrubEndTimer.current = setTimeout(finishScrub, 90);
        }}
        onMomentumScrollBegin={() => {
          if (gestureLockRef.current || !scrubbingRef.current) return;
          if (scrubEndTimer.current) clearTimeout(scrubEndTimer.current);
          scrubbingRef.current = true;
        }}
        onMomentumScrollEnd={finishScrub}>
        <View style={{ width: LABEL_WIDTH + trackWidth, height: '100%', marginLeft: leadingPadding }}>
          <TimelineRuler durationMs={duration} trackWidth={trackWidth} pixelsPerSecond={effectiveScale} visibleStartMs={visibleRange.startMs} visibleEndMs={visibleRange.endMs} />
          <ScrollView ref={verticalRef} style={{ marginTop: RULER_HEIGHT }} contentContainerStyle={{ paddingVertical: 1 }} nestedScrollEnabled scrollEnabled={!gestureLock}>
            <TimelineRow label="VIDEO" labelColor={chrome.accent} selected={Boolean(props.selectedClipId)} trackWidth={trackWidth} height={videoRowHeight} onPressTrack={(x) => { props.onClearSelection(); props.onSeek(x / trackWidth * duration); }} controls={<Text style={{ color: chrome.muted, fontSize: 8 }}>{props.clips.length} CLIP{props.clips.length === 1 ? '' : 'S'}</Text>}>
              {reorderDrag ? (
                <VideoReorderBanner
                  clips={previewClips}
                  originalClips={props.clips}
                  activeClipId={reorderDrag.clipId}
                  dropIndex={reorderDrag.toIndex}
                />
              ) : null}
              {reorderMode ? (
                <View pointerEvents="none" style={{ position: 'absolute', left: Math.max(0, (reorderDrag?.toIndex ?? 0) * (REORDER_TILE + REORDER_GAP) - 2), top: 4, bottom: 4, width: 3, borderRadius: 2, backgroundColor: '#FFFFFF', zIndex: 10 }} />
              ) : null}
              {clipPositions.map((entry, index) => ({ ...entry, index })).filter(({ clip, gapStartMs, afterGapEndMs }) => reorderMode || isVisible(gapStartMs, afterGapEndMs) || reorderDrag?.clipId === clip.id).map(({ clip, gapStartMs, startMs, endMs, afterGapEndMs, index }) => {
                const previousEndMs = index === 0 ? 0 : clipPositions[index - 1].endMs;
                const leadingGapMs = startMs - previousEndMs;
                const reordering = reorderDrag?.clipId === clip.id;
                const source = sourceById.get(clip.sourceId);
                return (
                <Fragment key={clip.id}>
                  <VideoClipBlock
                    projectId={props.projectId}
                    clip={clip}
                    sourceUri={source?.uri}
                    fallbackThumbUri={source?.thumbnailUri}
                    clipIndex={index}
                    clipCount={previewClips.length}
                    leadingGapMs={leadingGapMs}
                    label={`CLIP ${index + 1}`}
                    startMs={startMs}
                    endMs={endMs}
                    durationMs={duration}
                    trackWidth={trackWidth}
                    filmstrip={reorderMode}
                    tileSize={REORDER_TILE}
                    tileGap={REORDER_GAP}
                    selected={props.selectedClipId === clip.id || reordering}
                    reordering={reordering}
                    color={index % 2 ? '#38404A' : '#46515D'}
                    onPress={() => props.onSelectClip(clip.id)}
                    onGestureLock={setItemGestureLock}
                    onTrimPreview={(edge, targetSourceMs) => {
                      setItemGestureLock(true);
                      const preview = previewVideoClipTrim(clip, edge, targetSourceMs);
                      setClipPreview(props.clips.map((candidate) => candidate.id === clip.id ? preview : candidate));
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
                    onReorderPreview={(toIndex) => {
                      setItemGestureLock(true);
                      setReorderDrag({ clipId: clip.id, toIndex });
                      const preview = previewVideoClipReorder(props.clips, clip.id, toIndex);
                      if (preview) setClipPreview(preview);
                    }}
                    onReorderCommit={(toIndex) => {
                      setItemGestureLock(false);
                      setReorderDrag(undefined);
                      setClipPreview(undefined);
                      props.onReorderClip(clip.id, toIndex);
                    }}
                    onReorderCancel={() => {
                      setItemGestureLock(false);
                      setReorderDrag(undefined);
                      setClipPreview(undefined);
                    }}
                  />
                  {!reorderMode && startMs > gapStartMs ? (
                    <VideoGapBlock
                      startMs={gapStartMs}
                      endMs={startMs}
                      durationMs={duration}
                      trackWidth={trackWidth}
                      onPress={props.onClearSelection}
                      onRemove={() => props.onSetClipGap(clip.id, 0)}
                    />
                  ) : null}
                  {!reorderMode && afterGapEndMs > endMs ? (
                    <VideoGapBlock
                      startMs={endMs}
                      endMs={afterGapEndMs}
                      durationMs={duration}
                      trackWidth={trackWidth}
                      accessibilityLabel={`Empty gap after ${formatGap(afterGapEndMs - endMs)}. Tap to clear the selection.`}
                      onPress={props.onClearSelection}
                      onRemove={() => props.onSetClipGap(clip.id, 0, 'after')}
                    />
                  ) : null}
                </Fragment>
                );
              })}
            </TimelineRow>
            <TimelineRow label="AUDIO" labelColor="#64E8FF" selected={Boolean(props.selectedAudioClipId)} trackWidth={trackWidth} height={audioRowHeight} onPressTrack={(x) => { props.onClearSelection(); props.onSeek(x / trackWidth * duration); }} controls={<Text style={{ color: '#6F7985', fontSize: 8 }}>{props.audioClips.length} TRACK{props.audioClips.length === 1 ? '' : 'S'}</Text>}>
              {props.audioClips.filter((clip) => isVisible(clip.startMs, audioClipEnd(clip))).map((clip) => {
                const source = props.audioSources.find((candidate) => candidate.id === clip.sourceId);
                return (
                  <TimedBlock
                    key={clip.id}
                    label={`${clip.muted ? 'MUTED · ' : ''}${source?.displayName ?? 'AUDIO'}`}
                    startMs={clip.startMs}
                    endMs={audioClipEnd(clip)}
                    durationMs={duration}
                    trackWidth={trackWidth}
                    lane={audioLayout.laneById.get(clip.id) ?? 0}
                    controlTop={audioLayout.laneCount * LANE_HEIGHT + 3}
                    color={clip.muted ? '#59636F' : '#006D78'}
                    selected={props.selectedAudioClipId === clip.id}
                    waveformPeaks={source?.waveformPeaks}
                    waveformVisibleStartMs={visibleRange.startMs}
                    waveformVisibleEndMs={visibleRange.endMs}
                    visibleTrackBounds={visibleTrackBounds}
                    sourceStartMs={clip.sourceStartMs}
                    sourceEndMs={clip.sourceEndMs}
                    sourceDurationMs={source?.durationMs}
                    onPress={() => props.onSelectAudioClip(clip.id)}
                    onChangeStart={beginBlockGesture}
                    onChange={(edge, startMs, endMs) => props.onItemTimingChange({ kind: 'audio', clipId: clip.id }, edge, startMs, endMs)}
                    onEnd={endBlockGesture}
                  />
                );
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
                  onPressLabel={() => selectTimelineItem(() => props.onSelectLayer(layer.id))}
                  onPressTrack={(x) => { props.onClearSelection(); props.onSeek(x / trackWidth * duration); }}
                  trackWidth={trackWidth}
                  height={isCaptions ? captionRowHeight : visualRowHeight(layer.id)}
                  controls={<View style={{ gap: 2 }}>
                    {isCaptions && captionLayout.laneCount > 1 ? <Text style={{ color: '#19D98B', fontSize: 7, fontWeight: '800' }}>{captionLayout.laneCount} AUTO LANES</Text> : null}
                    <View style={{ flexDirection: 'row', gap: 2 }}>
                      <TinyButton label="↑" disabled={layerIndex === 0} onPress={() => props.onMoveLayer(layer.id, -1)} />
                      <TinyButton label="↓" disabled={layerIndex === props.layers.length - 1} onPress={() => props.onMoveLayer(layer.id, 1)} />
                      {!isCaptions ? <TinyButton label="×" danger onPress={() => props.onDeleteLayer(layer.id)} /> : null}
                    </View>
                  </View>}>
                  {isCaptions ? captionPage.cues.map((caption, index) => (
                    <TimedBlock key={caption.id} label={caption.text} startMs={caption.startMs} endMs={caption.endMs} durationMs={duration} trackWidth={trackWidth} lane={captionLayout.laneById.get(caption.id) ?? 0} controlTop={0} hideControls marker={captionPage.markers.get(caption.id)} ordinal={captionPage.first + index + 1} visibleTrackBounds={visibleTrackBounds} color={NEON_CAPTION_COLORS[(captionPage.first + index) % NEON_CAPTION_COLORS.length]} selected={props.selectedLayerId === 'captions' && props.selectedCaptionId === caption.id} onPress={() => selectTimelineItem(() => props.onSelectCaption(caption))} onChangeStart={beginBlockGesture} onChange={(edge, startMs, endMs) => props.onItemTimingChange({ kind: 'caption', captionId: caption.id }, edge, startMs, endMs)} onEnd={endBlockGesture} />
                  )) : (
                    <TimedBlock label={layer.kind === 'text' ? layer.text : 'IMAGE'} startMs={layer.startMs} endMs={layer.endMs} durationMs={duration} trackWidth={trackWidth} lane={0} controlTop={LANE_HEIGHT + 3} visibleTrackBounds={visibleTrackBounds} color={layer.kind === 'text' ? '#A855F7' : '#00B8FF'} selected={props.selectedLayerId === layer.id} onPress={() => props.onSelectLayer(layer.id)} onChangeStart={beginBlockGesture} onChange={(edge, startMs, endMs) => props.onItemTimingChange({ kind: 'visual', layerId: layer.id }, edge, startMs, endMs)} onEnd={endBlockGesture} />
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
                      if (first) selectTimelineItem(() => props.onSelectTranslationCaption(track.id, first));
                    }}
                    onPressTrack={(x) => { props.onClearSelection(); props.onSeek(x / trackWidth * duration); }}
                    trackWidth={trackWidth}
                    height={translationRowHeight(track.id)}
                    controls={<Text style={{ color: track.visible ? '#19D98B' : '#7B8591', fontSize: 7, fontWeight: '900' }}>{track.visible ? 'VISIBLE · INDEPENDENT' : 'HIDDEN · INDEPENDENT'}</Text>}>
                    {translationPages.get(track.id)!.cues.map(({ pair }, pairIndex) => (
                      <TimedBlock
                        key={pair.translation.id}
                        label={pair.translation.text || 'Translation pending'}
                        startMs={pair.startMs}
                        endMs={pair.endMs}
                        durationMs={duration}
                        trackWidth={trackWidth}
                        lane={translationPages.get(track.id)!.layout.laneById.get(pair.source.id) ?? 0}
                        controlTop={0}
                        hideControls
                        ordinal={translationPages.get(track.id)!.first + pairIndex + 1}
                        marker={translationPages.get(track.id)!.markers.get(pair.source.id)}
                        visibleTrackBounds={visibleTrackBounds}
                        color={pair.translation.status === 'stale' || pair.translation.status === 'pending' || pair.translation.status === 'failed'
                          ? '#A66220'
                          : NEON_CAPTION_COLORS[(pairIndex + trackIndex + 1) % NEON_CAPTION_COLORS.length]}
                        selected={props.selectedLayerId === track.id && props.selectedCaptionId === pair.source.id}
                        onPress={() => selectTimelineItem(() => props.onSelectTranslationCaption(track.id, pair))}
                        onChangeStart={beginBlockGesture}
                        onChange={(edge, startMs, endMs) => props.onItemTimingChange({ kind: 'translation', trackId: track.id, sourceCaptionId: pair.source.id }, edge, startMs, endMs)}
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
      {selectedControlProps && activeIndex && selectedOrdinal !== undefined ? (
        <View testID="caption-timing-dock" style={{ height: footerHeight, flexShrink: 0, backgroundColor: '#252C34' }}>
          <View style={{ height: 44, flexDirection: 'row', alignItems: 'center' }}>
            <Pressable accessibilityRole="button" accessibilityLabel="Previous cue" disabled={selectedOrdinal === 0} onPress={() => selectOrdinal(selectedOrdinal - 1)} style={{ width: 44, height: 44, justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: chrome.text }}>Prev</Text></Pressable>
            <TextInput accessibilityLabel={`Jump to cue number, selected ${selectedOrdinal + 1} of ${activeIndex.ordered.length}`} keyboardType="number-pad" returnKeyType="go" value={cueNumber} placeholder={`${selectedOrdinal + 1}/${activeIndex.ordered.length}`} placeholderTextColor={chrome.text} onChangeText={setCueNumber} onSubmitEditing={jumpToCueNumber} style={{ flex: 1, minWidth: 44, height: 44, color: chrome.text, textAlign: 'center', padding: 0 }} />
            <Pressable accessibilityRole="button" accessibilityLabel="Go to cue number" onPress={jumpToCueNumber} style={{ width: 44, height: 44, justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: chrome.text }}>Go</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Next cue" disabled={selectedOrdinal === activeIndex.ordered.length - 1} onPress={() => selectOrdinal(selectedOrdinal + 1)} style={{ width: 44, height: 44, justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: chrome.text }}>Next</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Reveal selected cue" onPress={() => revealCue(selectedCue!.startMs)} style={{ width: 60, height: 44, justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: chrome.text }}>Reveal</Text></Pressable>
          </View>
          <View testID="caption-docked-controls" style={{ width: viewportWidth, height: TIMELINE_CONTROL_HEIGHT, position: 'relative' }}>
            <TimelineMoveGrip {...selectedControlProps} controlRail />
            <TimingGrip {...selectedControlProps} side="start" />
            <TimingGrip {...selectedControlProps} side="end" />
          </View>
        </View>
      ) : null}
      <View pointerEvents="none" style={{ position: 'absolute', left: '50%', top: 36, bottom: footerHeight, width: 2, marginLeft: -1, backgroundColor: '#FF5267' }}>
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
  projectId: string;
  clip: VideoClip;
  sourceUri?: string;
  fallbackThumbUri?: string;
  clipIndex: number;
  clipCount: number;
  leadingGapMs: number;
  label: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  trackWidth: number;
  filmstrip?: boolean;
  tileSize?: number;
  tileGap?: number;
  selected: boolean;
  reordering?: boolean;
  color: string;
  onPress: () => void;
  onGestureLock: (locked: boolean) => void;
  onTrimPreview: (edge: 'start' | 'end', targetSourceMs: number) => void;
  onTrimCommit: (edge: 'start' | 'end', targetSourceMs: number) => void;
  onGapPreview: (gapBeforeMs: number) => void;
  onGapCommit: (gapBeforeMs: number) => void;
  onReorderPreview: (toIndex: number) => void;
  onReorderCommit: (toIndex: number) => void;
  onReorderCancel: () => void;
}) {
  const clipDuration = Math.max(120, props.endMs - props.startMs);
  const tile = props.tileSize ?? REORDER_TILE;
  const gap = props.tileGap ?? REORDER_GAP;
  const left = props.filmstrip
    ? props.clipIndex * (tile + gap)
    : props.startMs / props.durationMs * props.trackWidth;
  const width = props.filmstrip
    ? tile
    : Math.max(2, clipDuration / props.durationMs * props.trackWidth - 2);
  return (
    <View
      style={{
        position: 'absolute',
        left,
        width,
        top: props.filmstrip || props.reordering ? 4 : 3,
        bottom: props.filmstrip || props.reordering ? 4 : 3,
        zIndex: props.reordering ? 8 : props.selected ? 5 : 1,
        justifyContent: props.filmstrip ? 'flex-end' : 'center',
        paddingHorizontal: props.filmstrip ? 4 : 10,
        paddingBottom: props.filmstrip ? 4 : 0,
        overflow: 'hidden',
        borderRadius: props.filmstrip ? 10 : chrome.radius.sm,
        borderWidth: props.selected || props.reordering ? 2 : props.filmstrip ? 1 : 0,
        borderColor: props.reordering ? '#FFFFFF' : props.selected ? chrome.accent : '#2A323A',
        backgroundColor: props.color,
        opacity: props.reordering ? 0.98 : 1,
        transform: props.reordering ? [{ scale: 1.04 }] : undefined,
      }}>
      {props.filmstrip ? (
        <ClipFrameThumb
          projectId={props.projectId}
          clipId={props.clip.id}
          sourceUri={props.sourceUri}
          fallbackUri={props.fallbackThumbUri}
          sourceStartMs={props.clip.sourceStartMs}
          style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}
          contentFit="cover"
        />
      ) : null}
      <View pointerEvents="none" style={{ flexDirection: 'row', alignItems: 'center', gap: 4, zIndex: 2 }}>
        <Text numberOfLines={1} style={{ color: '#F7F8FA', fontSize: props.filmstrip ? 9 : 8, fontWeight: '900', textShadowColor: 'rgba(0,0,0,0.75)', textShadowRadius: 3 }}>{props.label}</Text>
        {!props.filmstrip ? (
          <ClipFrameThumb
            projectId={props.projectId}
            clipId={props.clip.id}
            sourceUri={props.sourceUri}
            fallbackUri={props.fallbackThumbUri}
            sourceStartMs={props.clip.sourceStartMs}
            style={{ width: 18, height: 18, borderRadius: 3, backgroundColor: '#12161B' }}
            contentFit="cover"
          />
        ) : null}
      </View>
      <VideoMoveGrip {...props} />
      {props.selected && !props.reordering && !props.filmstrip ? (
        <>
          <VideoTrimGrip side="start" {...props} />
          <VideoTrimGrip side="end" {...props} />
        </>
      ) : null}
    </View>
  );
}

function ClipFrameThumb(props: {
  projectId: string;
  clipId: string;
  sourceUri?: string;
  fallbackUri?: string;
  sourceStartMs: number;
  style: object;
  contentFit: 'cover' | 'contain';
}) {
  const cacheKey = `${props.projectId}:${props.clipId}:${Math.round(props.sourceStartMs)}`;
  const [generatedUri, setGeneratedUri] = useState<string | undefined>(() => clipThumbCache.get(cacheKey));
  useEffect(() => {
    let cancelled = false;
    if (clipThumbCache.has(cacheKey) || !props.sourceUri) return undefined;
    void ensureClipFrameThumbnail({
      projectId: props.projectId,
      clipId: props.clipId,
      videoUri: props.sourceUri,
      sourceStartMs: props.sourceStartMs,
    }).then((generated) => {
      if (cancelled || !generated) return;
      clipThumbCache.set(cacheKey, generated);
      setGeneratedUri(generated);
    });
    return () => { cancelled = true; };
  }, [cacheKey, props.clipId, props.projectId, props.sourceStartMs, props.sourceUri]);
  const uri = clipThumbCache.get(cacheKey) ?? generatedUri ?? props.fallbackUri;
  if (!uri) return <View style={props.style} />;
  return <Image source={{ uri }} contentFit={props.contentFit} style={props.style} />;
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
  const reorderIndexRef = useRef(props.clipIndex);
  const originIndexRef = useRef(props.clipIndex);
  const modeRef = useRef<'none' | 'gap' | 'reorder'>('none');
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressArmedRef = useRef(false);

  const responder = useMemo(() => {
    const clearLongPress = () => {
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    };
    const finishGesture = (kind: 'release' | 'terminate') => {
      clearLongPress();
      const mode = modeRef.current;
      modeRef.current = 'none';
      longPressArmedRef.current = false;
      if (mode === 'reorder') {
        if (kind === 'release') propsRef.current.onReorderCommit(reorderIndexRef.current);
        else propsRef.current.onReorderCancel();
        return;
      }
      if (mode === 'gap') {
        propsRef.current.onGapCommit(gapRef.current);
        return;
      }
      propsRef.current.onGestureLock(false);
    };
    return PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
    onPanResponderGrant: () => {
      propsRef.current.onPress();
      propsRef.current.onGestureLock(true);
      initialGapRef.current = propsRef.current.leadingGapMs;
      gapRef.current = initialGapRef.current;
      originIndexRef.current = propsRef.current.clipIndex;
      reorderIndexRef.current = propsRef.current.clipIndex;
      modeRef.current = 'none';
      longPressArmedRef.current = false;
      clearLongPress();
      longPressTimerRef.current = setTimeout(() => {
        longPressArmedRef.current = true;
        modeRef.current = 'reorder';
        reorderIndexRef.current = originIndexRef.current;
        propsRef.current.onReorderPreview(originIndexRef.current);
      }, 350);
    },
    onPanResponderMove: (_event, gesture) => {
      if (modeRef.current === 'none') {
        if (!longPressArmedRef.current) {
          if (Math.abs(gesture.dx) <= 8 && Math.abs(gesture.dy) <= 8) return;
          clearLongPress();
          if (Math.abs(gesture.dx) <= Math.abs(gesture.dy)) return;
          modeRef.current = 'gap';
        } else {
          modeRef.current = 'reorder';
        }
      }
      if (modeRef.current === 'reorder') {
        if (propsRef.current.clipCount <= 1) return;
        const slotWidth = Math.max(24, (propsRef.current.tileSize ?? REORDER_TILE) + (propsRef.current.tileGap ?? REORDER_GAP));
        const deltaIndex = Math.round(gesture.dx / slotWidth);
        const toIndex = clamp(originIndexRef.current + deltaIndex, 0, propsRef.current.clipCount - 1);
        reorderIndexRef.current = toIndex;
        propsRef.current.onReorderPreview(toIndex);
        return;
      }
      const delta = gesture.dx / Math.max(1, propsRef.current.trackWidth) * propsRef.current.durationMs;
      const gap = clamp(initialGapRef.current + delta, 0, 60 * 60_000);
      gapRef.current = gap;
      propsRef.current.onGapPreview(gap);
    },
    onPanResponderRelease: () => finishGesture('release'),
    onPanResponderTerminate: () => finishGesture('terminate'),
    });
  }, []);

  useEffect(() => () => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  }, []);

  return (
    <View
      {...responder.panHandlers}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={`${props.label}. Tap to select. Hold then drag to reorder. Drag horizontally to add or remove empty space before this clip.`}
      style={{ position: 'absolute', left: props.selected ? 16 : 0, right: props.selected ? 16 : 0, top: 0, bottom: 0 }}
    />
  );
}

function VideoReorderBanner(props: {
  clips: VideoClip[];
  originalClips: VideoClip[];
  activeClipId: string;
  dropIndex?: number;
}) {
  const originalNumber = (clipId: string) => {
    const index = props.originalClips.findIndex((clip) => clip.id === clipId);
    return index >= 0 ? index + 1 : 0;
  };
  const activeIndex = props.clips.findIndex((clip) => clip.id === props.activeClipId);
  const before = activeIndex > 0 ? props.clips[activeIndex - 1] : undefined;
  const after = activeIndex >= 0 && activeIndex < props.clips.length - 1 ? props.clips[activeIndex + 1] : undefined;
  const placement = !before && !after
    ? 'Only clip'
    : !before
      ? `Before CLIP ${originalNumber(after!.id)}`
      : !after
        ? `After CLIP ${originalNumber(before.id)}`
        : `Between CLIP ${originalNumber(before.id)} and CLIP ${originalNumber(after.id)}`;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 4, right: 4, top: -14, zIndex: 9, alignItems: 'center' }}>
      <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, backgroundColor: 'rgba(8,12,16,0.92)' }}>
        <Text style={{ color: '#64D2FF', fontSize: 8, fontWeight: '900' }}>HOLD-DRAG TILES · {placement}</Text>
      </View>
    </View>
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
        <Pressable accessibilityRole="button" accessibilityLabel="Clear selection and seek timeline" onPress={(event) => props.onPressTrack?.(event.nativeEvent.locationX)} style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }} />
        <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}>
          {props.children}
        </View>
      </View>
    </View>
  );
}

function TimedBlock(props: {
  label: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  trackWidth: number;
  lane: number;
  controlTop: number;
  marker?: { left: number; width: number; top: number };
  ordinal?: number;
  hideControls?: boolean;
  visibleTrackBounds?: TimelineTrackBounds;
  color: string;
  selected: boolean;
  waveformPeaks?: number[];
  waveformVisibleStartMs?: number;
  waveformVisibleEndMs?: number;
  sourceStartMs?: number;
  sourceEndMs?: number;
  sourceDurationMs?: number;
  onPress: () => void;
  onChangeStart: () => void;
  onChange: (edge: TimelineTimingEdge, startMs: number, endMs: number) => void;
  onEnd: () => void;
}) {
  const width = Math.max(0, (props.endMs - props.startMs) / props.durationMs * props.trackWidth);
  const controls = timelineBlockControls(width, props.selected);
  const bodyLeft = props.startMs / props.durationMs * props.trackWidth;
  const rail = timelineControlRail(bodyLeft, props.trackWidth, props.visibleTrackBounds);
  return (
    <>
    <View style={{ position: 'absolute', left: bodyLeft, width: controls.width, top: props.lane * LANE_HEIGHT + 3, height: LANE_HEIGHT - 6, zIndex: props.selected ? 6 : 1, justifyContent: 'center' }}>
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, width, top: 0, bottom: 0, overflow: 'hidden', borderRadius: 6, borderWidth: props.selected ? 2 : 1, borderColor: props.selected ? '#FFFFFF' : `${props.color}CC`, backgroundColor: `${props.color}B8` }}>
        {props.waveformPeaks && props.waveformPeaks.length >= 8 ? (
          <AudioWaveform
            peaks={props.waveformPeaks}
            sourceStartMs={props.sourceStartMs ?? 0}
            sourceEndMs={props.sourceEndMs ?? props.sourceDurationMs ?? 1}
            sourceDurationMs={props.sourceDurationMs ?? Math.max(1, (props.sourceEndMs ?? 1) - (props.sourceStartMs ?? 0))}
            clipStartMs={props.startMs}
            clipEndMs={props.endMs}
            visibleStartMs={props.waveformVisibleStartMs ?? props.startMs}
            visibleEndMs={props.waveformVisibleEndMs ?? props.endMs}
            renderedClipWidth={width}
            color={props.selected ? '#E8FDFF' : '#B8F7FF'}
          />
        ) : null}
        <Text numberOfLines={1} style={{ position: 'absolute', left: 7, right: 7, top: 1, color: '#FFFFFF', fontSize: 7, fontWeight: '900', zIndex: 2, textShadowColor: '#00161A', textShadowRadius: 2 }}>{props.label}</Text>
      </View>
      <TimelineMoveGrip {...props} />
    </View>
      {props.marker ? (
        <Pressable accessibilityRole="button" accessibilityLabel={timelineTimingLabel(props.label, props.startMs, props.endMs, props.selected, `Select cue ${props.ordinal ?? ''}`)} accessibilityState={{ selected: props.selected }}
          onPress={props.onPress}
          style={{ position: 'absolute', ...props.marker, height: TIMELINE_MARKER_HEIGHT - 6,
            borderRadius: 6, borderWidth: 1, borderColor: props.selected ? '#FFFFFF' : props.color,
            backgroundColor: '#334155', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 }}>
          <Text pointerEvents="none" numberOfLines={2} style={{ color: '#FFFFFF', fontSize: 9 }}>{props.ordinal ? `${props.ordinal}. ` : ''}{props.label}</Text>
        </Pressable>
      ) : null}
      {props.selected && !props.hideControls ? (
        <View accessibilityLabel={`Timing controls for ${props.label}`} style={{ position: 'absolute', left: rail.left,
          top: props.controlTop, width: rail.width,
          height: TIMELINE_CONTROL_HEIGHT - 6, borderRadius: 6, backgroundColor: '#334155' }}>
          <TimelineMoveGrip {...props} controlRail />
          <TimingGrip side="start" {...props} />
          <TimingGrip side="end" {...props} />
        </View>
      ) : null}
    </>
  );
}

function AudioWaveform(props: {
  peaks: number[];
  sourceStartMs: number;
  sourceEndMs: number;
  sourceDurationMs: number;
  clipStartMs: number;
  clipEndMs: number;
  visibleStartMs: number;
  visibleEndMs: number;
  renderedClipWidth: number;
  color: string;
}) {
  const window = audioWaveformWindow({
    peaks: props.peaks,
    sourceDurationMs: props.sourceDurationMs,
    sourceStartMs: props.sourceStartMs,
    sourceEndMs: props.sourceEndMs,
    clipStartMs: props.clipStartMs,
    clipEndMs: props.clipEndMs,
    visibleStartMs: props.visibleStartMs,
    visibleEndMs: props.visibleEndMs,
    renderedClipWidth: props.renderedClipWidth,
  });
  if (window.bars.length === 0) return null;
  const maxHalfHeight = (LANE_HEIGHT - 11) / 2;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: window.leftPx, width: window.widthPx, top: 3, bottom: 3, flexDirection: 'row', alignItems: 'center', gap: 1, opacity: 0.96 }}>
      <View style={{ position: 'absolute', left: 0, right: 0, top: '50%', height: 1, backgroundColor: `${props.color}55` }} />
      {window.bars.map((peak, index) => {
        const halfHeight = Math.max(0.5, Math.pow(peak, 0.68) * maxHalfHeight);
        return (
          <View
            key={index}
            style={{
              flex: 1,
              minWidth: 1,
              height: Math.max(1, Math.round(halfHeight * 2)),
              borderRadius: 1,
              backgroundColor: props.color,
              opacity: peak === 0 ? 0.28 : 0.55 + peak * 0.45,
            }}
          />
        );
      })}
    </View>
  );
}

function useTimelineTimingResponder(props: Parameters<typeof TimedBlock>[0], edge: TimelineTimingEdge) {
  const propsRef = useRef(props);
  propsRef.current = props;
  const gesture = useMemo(() => createTimelineTimingGesture(), []);
  useEffect(() => () => gesture.finish(), [gesture]);
  return useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
    onPanResponderGrant: () => gesture.begin(propsRef.current, edge),
    onPanResponderMove: (_event, movement) => gesture.move(movement.dx, movement.dy),
    onPanResponderRelease: () => gesture.finish(),
    onPanResponderTerminate: () => gesture.finish(),
  }), [edge, gesture]);
}

function TimelineMoveGrip(props: Parameters<typeof TimedBlock>[0] & { controlRail?: boolean }) {
  const responder = useTimelineTimingResponder(props, 'move');
  return (
    <View
      {...responder.panHandlers}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={timelineTimingLabel(props.label, props.startMs, props.endMs, props.selected, 'Move')}
      accessibilityState={{ selected: props.selected }}
      accessibilityActions={TIMELINE_ACCESSIBILITY_ACTIONS}
      onAccessibilityAction={(event) => adjustTimelineTiming(props, 'move', event.nativeEvent.actionName)}
      style={{ position: 'absolute', left: props.controlRail ? TIMELINE_GRIP_WIDTH : 0, right: props.controlRail ? TIMELINE_GRIP_WIDTH : 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}
    >{props.controlRail ? <Text pointerEvents="none" style={{ color: '#FFFFFF', fontSize: 10 }}>Move</Text> : null}</View>
  );
}

function TimingGrip(props: Parameters<typeof TimedBlock>[0] & { side: 'start' | 'end' }) {
  const responder = useTimelineTimingResponder(props, props.side);
  return <View {...responder.panHandlers} accessible accessibilityRole="adjustable" accessibilityLabel={timelineTimingLabel(props.label, props.startMs, props.endMs, props.selected, props.side === 'start' ? 'Start boundary' : 'End boundary')} accessibilityState={{ selected: props.selected }} accessibilityActions={TIMELINE_ACCESSIBILITY_ACTIONS} onAccessibilityAction={(event) => adjustTimelineTiming(props, props.side, event.nativeEvent.actionName)} style={{ position: 'absolute', [props.side === 'start' ? 'left' : 'right']: 0, top: 0, bottom: 0, width: TIMELINE_GRIP_WIDTH, zIndex: 10, borderRadius: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF' }}><Text pointerEvents="none" style={{ color: '#151A20', fontSize: 9 }}>{props.side === 'start' ? 'Start' : 'End'}</Text></View>;
}

function TinyButton(props: { label: string; danger?: boolean; disabled?: boolean; onPress: () => void }) {
  const accessibilityLabel = props.label === '↑'
    ? 'Move layer up'
    : props.label === '↓'
      ? 'Move layer down'
      : 'Remove layer';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={4}
      style={{
        width: 26,
        height: 26,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 7,
        backgroundColor: props.danger ? '#3A2028' : '#252C34',
        opacity: props.disabled ? 0.25 : 1,
      }}>
      <Text style={{ color: props.danger ? '#FF7C8D' : '#D7E0E8', fontSize: 18, lineHeight: 21, fontWeight: '900' }}>{props.label}</Text>
    </Pressable>
  );
}
function ZoomButton(props: { label: string; onPress: () => void }) { return <Pressable accessibilityRole="button" accessibilityLabel={props.label === '+' ? 'Zoom timeline in' : 'Zoom timeline out'} onPress={props.onPress} style={{ width: 42, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: '#2C2C2E' }}><Text style={{ color: '#64D2FF', fontSize: 20, fontWeight: '600' }}>{props.label}</Text></Pressable>; }
function formatRulerTime(ms: number, intervalMs: number) { const minutes = Math.floor(ms / 60_000); const seconds = (ms % 60_000) / 1000; return intervalMs < 1000 ? `${minutes}:${seconds.toFixed(intervalMs < 500 ? 2 : 1).padStart(4, '0')}` : `${minutes}:${Math.floor(seconds).toString().padStart(2, '0')}`; }
function formatGap(ms: number) { return `${(Math.max(0, ms) / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`; }
function touchDistance(first?: { pageX: number; pageY: number }, second?: { pageX: number; pageY: number }) { if (!first || !second) return 0; return Math.hypot(first.pageX - second.pageX, first.pageY - second.pageY); }
function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }
