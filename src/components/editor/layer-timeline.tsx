import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, PanResponder, Pressable, ScrollView, Text, View } from 'react-native';
import { Image } from 'expo-image';

import { chrome } from '@/lib/ui-theme';
import { indexTimelineCues, packTimelineLanes, queryTimelineCues, timelineCuePage } from '@/lib/timeline-layout';
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
  const [viewportWidth, setViewportWidth] = useState(360);
  const [clipPreview, setClipPreview] = useState<VideoClip[]>();
  const [reorderDrag, setReorderDrag] = useState<{ clipId: string; toIndex: number }>();
  const [gestureLock, setGestureLock] = useState(false);
  const [magnifiedCue, setMagnifiedCue] = useState<{ trackId: string; id: string }>();
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
  const selectionOwnsViewportRef = useRef(Boolean(props.selectedCaptionId));
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
  const captionRowHeight = captionLayout.laneCount * LANE_HEIGHT + 10;
  const translationRowHeight = (id: string) => translationPages.get(id)!.layout.laneCount * LANE_HEIGHT + 10;
  const activeIndex = props.selectedLayerId === 'captions' ? captionIndex : translationIndexes.get(props.selectedLayerId ?? '');
  const selectedOrdinal = activeIndex?.byId.get(props.selectedCaptionId ?? '');
  const selectedCue = selectedOrdinal === undefined ? undefined : activeIndex?.ordered[selectedOrdinal];
  const editIndex = magnifiedCue?.trackId === 'captions' ? captionIndex : translationIndexes.get(magnifiedCue?.trackId ?? '');
  const editOrdinal = editIndex?.byId.get(magnifiedCue?.id ?? '');
  const editCue = editOrdinal === undefined ? undefined : editIndex?.ordered[editOrdinal];
  const activeMagnifiedCue = editCue ? magnifiedCue : undefined;
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
    selectionOwnsViewportRef.current = true;
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
    if (scrubbingRef.current || gestureLock || (hasSelectedCue && selectionOwnsViewportRef.current)) return;
    const x = timelineScrollOffset(props.currentMs, duration, trackWidth);
    scrollXRef.current = x;
    setViewportScrollX(x);
    setVisibleCenterX(x);
    horizontalRef.current?.scrollTo({ x, animated: false });
  }, [duration, gestureLock, hasSelectedCue, props.currentMs, trackWidth, viewportWidth]);

  useEffect(() => {
    if (!selectedCue) { lastRevealRef.current = undefined; return; }
    const id = `${props.selectedLayerId}:${props.selectedCaptionId}`;
    const last = lastRevealRef.current;
    if (last?.id === id && !selectionOwnsViewportRef.current) return;
    if (last?.id === id && last.trackWidth === trackWidth && last.viewportWidth === viewportWidth) return;
    lastRevealRef.current = { id, trackWidth, viewportWidth };
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
    selectionOwnsViewportRef.current = true;
    select();
  };

  const beginBlockGesture = () => {
    if (scrubEndTimer.current) clearTimeout(scrubEndTimer.current);
    scrubEndTimer.current = null;
    scrubbingRef.current = false;
    selectionOwnsViewportRef.current = true;
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

  const openCueEditor = (trackId: string, id?: string) => {
    const index = trackId === 'captions' ? captionIndex : translationIndexes.get(trackId);
    const ordinal = id === undefined ? 0 : index?.byId.get(id);
    const cue = ordinal === undefined ? undefined : index?.ordered[ordinal];
    if (!cue) return;
    // Explicit cue editing owns the viewport without seeking or changing scale.
    lastRevealRef.current = { id: `${trackId}:${cue.id}`, trackWidth, viewportWidth };
    selectTimelineItem(() => {
      if ('pair' in cue) props.onSelectTranslationCaption(trackId, cue.pair);
      else props.onSelectCaption(cue);
    });
    setMagnifiedCue({ trackId, id: cue.id });
  };
  const captionTouchLock = (locked: boolean) => {
    if (locked) selectTimelineItem(() => {});
    setItemGestureLock(locked);
  };
  const editingTrack = activeMagnifiedCue?.trackId;
  const editOwner = editCue && editingTrack ? {
    label: 'pair' in editCue ? editCue.pair.translation.text || 'Translation pending' : editCue.text,
    startMs: editCue.startMs, endMs: editCue.endMs, durationMs: duration, trackWidth,
    selected: true, lane: 0, controlTop: 0, color: '#00B8FF',
    onPress: () => {}, onChangeStart: beginBlockGesture, onEnd: endBlockGesture,
    onChange: (edge: TimelineTimingEdge, startMs: number, endMs: number) => props.onItemTimingChange(
      editingTrack === 'captions' ? { kind: 'caption', captionId: editCue.id }
        : { kind: 'translation', trackId: editingTrack, sourceCaptionId: editCue.id }, edge, startMs, endMs),
  } : undefined;

  return (
    <View
      onLayout={(event) => setViewportWidth(Math.max(1, event.nativeEvent.layout.width))}
      onStartShouldSetResponderCapture={(event) => !activeMagnifiedCue && event.nativeEvent.touches.length === 2}
      onMoveShouldSetResponderCapture={(event) => !activeMagnifiedCue && event.nativeEvent.touches.length === 2}
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
      <View style={{ height: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingHorizontal: 44, borderBottomWidth: 1, borderBottomColor: '#1D242C' }}>
        <ZoomButton label="−" onPress={() => updateZoom(effectiveScale / 1.5)} />
        <Text style={{ minWidth: 70, color: '#D7DDE5', textAlign: 'center', fontSize: 10, fontWeight: '800' }}>{zoomPercent}%</Text>
        <ZoomButton label="+" onPress={() => updateZoom(effectiveScale * 1.5)} />
      </View>
      <ScrollView
        ref={horizontalRef}
        style={{ flex: 1 }}
        horizontal
        nestedScrollEnabled
        scrollEnabled={!gestureLock && !activeMagnifiedCue}
        decelerationRate="fast"
        scrollEventThrottle={32}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ width: scrollContentWidth }}
        onScrollBeginDrag={() => {
          if (gestureLockRef.current) return;
          if (scrubEndTimer.current) clearTimeout(scrubEndTimer.current);
          scrubbingRef.current = true;
          selectionOwnsViewportRef.current = false;
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
                  onEditCues={isCaptions ? () => openCueEditor('captions', props.selectedLayerId === 'captions' ? props.selectedCaptionId : undefined) : undefined}
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
                  {isCaptions ? captionPage.bodies.map((caption) => (
                    <TimedBlock key={caption.id} captionGesture onMagnify={() => openCueEditor('captions', caption.id)} onTouchLock={captionTouchLock} label={caption.text} startMs={caption.startMs} endMs={caption.endMs} durationMs={duration} trackWidth={trackWidth} lane={captionLayout.laneById.get(caption.id) ?? 0} controlTop={captionLayout.laneCount * LANE_HEIGHT + 3} visibleTrackBounds={visibleTrackBounds} color={NEON_CAPTION_COLORS[captionIndex.byId.get(caption.id)! % NEON_CAPTION_COLORS.length]} selected={props.selectedLayerId === 'captions' && props.selectedCaptionId === caption.id} onPress={() => selectTimelineItem(() => props.onSelectCaption(caption))} onChangeStart={beginBlockGesture} onChange={(edge, startMs, endMs) => props.onItemTimingChange({ kind: 'caption', captionId: caption.id }, edge, startMs, endMs)} onEnd={endBlockGesture} />
                  )) : (
                    <TimedBlock label={layer.kind === 'text' ? layer.text : 'IMAGE'} startMs={layer.startMs} endMs={layer.endMs} durationMs={duration} trackWidth={trackWidth} lane={0} controlTop={LANE_HEIGHT + 3} visibleTrackBounds={visibleTrackBounds} color={layer.kind === 'text' ? '#A855F7' : '#00B8FF'} selected={props.selectedLayerId === layer.id} onPress={() => props.onSelectLayer(layer.id)} onChangeStart={beginBlockGesture} onChange={(edge, startMs, endMs) => props.onItemTimingChange({ kind: 'visual', layerId: layer.id }, edge, startMs, endMs)} onEnd={endBlockGesture} />
                  )}
                  {isCaptions ? captionPage.density.map((bin) => (
                    <TimelineDensityBin key={bin.left} {...bin} onPress={() => {
                      const cue = queryTimelineCues(captionIndex, bin.startMs, bin.endMs, 1).cues[0];
                      if (cue) selectTimelineItem(() => props.onSelectCaption(cue));
                    }} />
                  )) : null}
                </TimelineRow>
                {isCaptions ? displayTranslationTracks.map((track, trackIndex) => (
                  <TimelineRow
                    key={track.id}
                    label={`↳ ${track.name.toUpperCase()}`}
                    labelColor={track.visible ? '#64E8FF' : '#6E7884'}
                    selected={props.selectedLayerId === track.id && !props.selectedClipId}
                    onEditCues={() => openCueEditor(track.id, props.selectedLayerId === track.id ? props.selectedCaptionId : undefined)}
                    onPressLabel={() => {
                      const first = track.pairs.find((pair) => pair.timelineVisible);
                      if (first) selectTimelineItem(() => props.onSelectTranslationCaption(track.id, first));
                    }}
                    onPressTrack={(x) => { props.onClearSelection(); props.onSeek(x / trackWidth * duration); }}
                    trackWidth={trackWidth}
                    height={translationRowHeight(track.id)}
                    controls={<Text style={{ color: track.visible ? '#19D98B' : '#7B8591', fontSize: 7, fontWeight: '900' }}>{track.visible ? 'VISIBLE · INDEPENDENT' : 'HIDDEN · INDEPENDENT'}</Text>}>
                    {translationPages.get(track.id)!.bodies.map(({ pair }) => (
                      <TimedBlock
                        key={pair.translation.id}
                        captionGesture
                        onMagnify={() => openCueEditor(track.id, pair.source.id)}
                        onTouchLock={captionTouchLock}
                        label={pair.translation.text || 'Translation pending'}
                        startMs={pair.startMs}
                        endMs={pair.endMs}
                        durationMs={duration}
                        trackWidth={trackWidth}
                        lane={translationPages.get(track.id)!.layout.laneById.get(pair.source.id) ?? 0}
                        controlTop={translationPages.get(track.id)!.layout.laneCount * LANE_HEIGHT + 3}
                        visibleTrackBounds={visibleTrackBounds}
                        color={pair.translation.status === 'stale' || pair.translation.status === 'pending' || pair.translation.status === 'failed'
                          ? '#A66220'
                          : NEON_CAPTION_COLORS[(translationIndexes.get(track.id)!.byId.get(pair.source.id)! + trackIndex + 1) % NEON_CAPTION_COLORS.length]}
                        selected={props.selectedLayerId === track.id && props.selectedCaptionId === pair.source.id}
                        onPress={() => selectTimelineItem(() => props.onSelectTranslationCaption(track.id, pair))}
                        onChangeStart={beginBlockGesture}
                        onChange={(edge, startMs, endMs) => props.onItemTimingChange({ kind: 'translation', trackId: track.id, sourceCaptionId: pair.source.id }, edge, startMs, endMs)}
                        onEnd={endBlockGesture}
                      />
                    ))}
                    {translationPages.get(track.id)!.density.map((bin) => (
                      <TimelineDensityBin key={bin.left} {...bin} onPress={() => {
                        const cue = queryTimelineCues(translationIndexes.get(track.id)!, bin.startMs, bin.endMs, 1).cues[0];
                        if (cue) selectTimelineItem(() => props.onSelectTranslationCaption(track.id, cue.pair));
                      }} />
                    ))}
                  </TimelineRow>
                )) : null}
                </View>
              );
            })}
          </ScrollView>
        </View>
      </ScrollView>
      <Pressable accessibilityRole="button" accessibilityLabel="Edit cue timing" accessibilityHint="Opens magnified timing. Use previous and next to reach tiny or zero-duration cues."
        onPress={() => openCueEditor(activeIndex ? props.selectedLayerId! : 'captions', selectedCue?.id)}
        style={{ position: 'absolute', left: 8, top: 2, width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: '#334155' }}>
        <Text style={{ color: '#FFFFFF', fontSize: 20 }}>↔</Text>
      </Pressable>
      {editOwner && activeMagnifiedCue ? <CaptionMagnifier key={`${activeMagnifiedCue.trackId}:${activeMagnifiedCue.id}`} {...editOwner}
        onDismiss={() => setMagnifiedCue(undefined)}
        onPrevious={editOrdinal! > 0 ? () => openCueEditor(activeMagnifiedCue.trackId, editIndex!.ordered[editOrdinal! - 1].id) : undefined}
        onNext={editOrdinal! + 1 < editIndex!.ordered.length ? () => openCueEditor(activeMagnifiedCue.trackId, editIndex!.ordered[editOrdinal! + 1].id) : undefined}
      /> : null}
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

function TimelineRow(props: { label: string; labelColor: string; selected?: boolean; controls: React.ReactNode; children: React.ReactNode; onPressLabel?: () => void; onEditCues?: () => void; onPressTrack?: (x: number) => void; trackWidth: number; height: number }) {
  return (
    <View style={{ width: LABEL_WIDTH + props.trackWidth, height: props.height, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#1D242C' }}>
      <Pressable onPress={props.onPressLabel} onLongPress={props.onEditCues} accessibilityRole="button"
        accessibilityLabel={props.label} accessibilityHint={props.onEditCues ? 'Hold to browse and edit cue timing, including zero-duration cues.' : undefined}
        accessibilityActions={props.onEditCues ? [{ name: 'editTiming', label: 'Browse and edit cue timing' }] : undefined}
        onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === 'editTiming') props.onEditCues?.(); }}
        style={{ width: LABEL_WIDTH, height: '100%', paddingHorizontal: 6, justifyContent: 'center', gap: 2, backgroundColor: props.selected ? '#252D22' : 'transparent' }}>
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

function TimelineDensityBin(props: { left: number; width: number; startMs: number; endMs: number; count: number; onPress: () => void }) {
  return <Pressable testID="timeline-cue-density-bin" accessibilityRole="button"
    accessibilityLabel={`${props.count} cues intersect ${(props.startMs / 1000).toFixed(3)} to ${(props.endMs / 1000).toFixed(3)} seconds. Select first cue. Zoom in for interval detail.`}
    onPress={props.onPress} style={{ position: 'absolute', left: props.left, width: props.width,
      top: 3, height: LANE_HEIGHT - 6, borderWidth: 1, borderColor: '#64748B', backgroundColor: '#334155', justifyContent: 'center' }}>
    <Text numberOfLines={1} style={{ color: '#FFFFFF', fontSize: 9, textAlign: 'center' }}>{props.count} cues</Text>
  </Pressable>;
}

function TimedBlock(props: {
  captionGesture?: boolean;
  onMagnify?: () => void;
  onTouchLock?: (locked: boolean) => void;
  label: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  trackWidth: number;
  lane: number;
  controlTop: number;
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
  // Resolve the caption pixel scale first: dividing a 96ms interval by 5000
  // before multiplying by 5000 yields 95.99999999999999, hiding direct grips.
  // Keep the threshold strict; genuinely sub-96px cues cannot fit 3x32px.
  const width = Math.max(0, props.captionGesture
    ? (props.endMs - props.startMs) * (props.trackWidth / props.durationMs)
    : (props.endMs - props.startMs) / props.durationMs * props.trackWidth);
  const controls = timelineBlockControls(width, props.selected);
  const bodyLeft = props.startMs / props.durationMs * props.trackWidth;
  const rail = timelineControlRail(bodyLeft, props.trackWidth, props.visibleTrackBounds);
  return (
    <>
    <View style={{ position: 'absolute', left: bodyLeft, width: controls.width, top: props.lane * LANE_HEIGHT + (props.captionGesture ? 0 : 3), height: props.captionGesture ? LANE_HEIGHT : LANE_HEIGHT - 6, zIndex: props.selected ? 6 : 1, justifyContent: 'center' }}>
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
      {props.captionGesture ? <CaptionGestureSurface {...props} width={controls.width} /> : <TimelineMoveGrip {...props} />}
    </View>
      {props.selected && !props.captionGesture ? (
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

// The magnifier is a separate surface: its three equal targets represent the
// actual boundaries/body, never an inflated time interval on the timeline.
const CAPTION_MAGNIFIED_WIDTH = 192;
const CAPTION_MAGNIFIED_HEIGHT = 48;
const CAPTION_DIRECT_GRIP = 32;
type CaptionTimingOwner = Parameters<typeof TimedBlock>[0];

function CaptionMagnifier(props: CaptionTimingOwner & {
  onDismiss: () => void; onPrevious?: () => void; onNext?: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  return <Modal transparent animationType="fade" visible onRequestClose={() => { if (!dragging) props.onDismiss(); }}>
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.65)' }}>
      <Pressable accessibilityLabel="Dismiss cue timing" accessibilityRole="button" disabled={dragging} onPress={props.onDismiss}
        style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} />
      <View accessibilityViewIsModal onAccessibilityEscape={() => { if (!dragging) props.onDismiss(); }}
        style={{ width: '100%', maxWidth: 360, padding: 16, borderRadius: 18, backgroundColor: '#20262E', gap: 12 }}>
        <Text accessibilityRole="header" style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '700' }}>Magnified cue timing</Text>
        <Text numberOfLines={3} style={{ color: '#FFFFFF', fontSize: 14 }}>{props.label}</Text>
        <Text accessibilityLiveRegion="polite" style={{ color: '#D7DDE5', fontSize: 12, fontVariant: ['tabular-nums'] }}>
          {(props.startMs / 1000).toFixed(3)} s - {(props.endMs / 1000).toFixed(3)} s
        </Text>
        <Text style={{ color: '#AEB7C2', fontSize: 12 }}>{props.endMs <= props.startMs
          ? 'Zero-duration cue. Drag an edge to recover its duration.'
          : 'Drag the center to move. Drag either edge to trim.'}</Text>
        <View style={{ alignSelf: 'center', width: CAPTION_MAGNIFIED_WIDTH, height: CAPTION_MAGNIFIED_HEIGHT }}>
          <CaptionGestureSurface {...props} magnified width={CAPTION_MAGNIFIED_WIDTH} onTouchLock={setDragging} />
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Previous cue" disabled={dragging || !props.onPrevious} onPress={props.onPrevious}
            style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', opacity: props.onPrevious ? 1 : 0.35 }}><Text style={{ color: '#FFFFFF', fontSize: 24 }}>‹</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Close cue timing" disabled={dragging} onPress={props.onDismiss}
            style={{ minWidth: 64, height: 48, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#64D2FF', fontSize: 14 }}>Done</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Next cue" disabled={dragging || !props.onNext} onPress={props.onNext}
            style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', opacity: props.onNext ? 1 : 0.35 }}><Text style={{ color: '#FFFFFF', fontSize: 24 }}>›</Text></Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}

function CaptionGestureSurface(props: CaptionTimingOwner & { width: number; magnified?: boolean }) {
  const trim = props.magnified || props.width >= 3 * CAPTION_DIRECT_GRIP;
  const grip = props.magnified ? CAPTION_MAGNIFIED_WIDTH / 3 : CAPTION_DIRECT_GRIP;
  const height = props.magnified ? CAPTION_MAGNIFIED_HEIGHT : LANE_HEIGHT;
  // Capture this conversion at grant. Renders caused by trimming must never
  // change the mapping mid-gesture; the real timeline scale stays untouched.
  const owner = props.magnified ? { ...props, trackWidth: CAPTION_MAGNIFIED_WIDTH,
    durationMs: Math.max(80, props.endMs - props.startMs) } : props;
  return <View testID={props.magnified ? 'caption-magnified-surface' : 'caption-direct-surface'}
    style={{ position: 'absolute', left: 0, top: 0, width: props.width, height,
      borderRadius: 6, backgroundColor: props.magnified ? '#007FA8' : 'transparent' }}>
    <CaptionTimingGrip {...owner} edge="move" left={trim ? grip : 0} width={props.width - (trim ? 2 * grip : 0)} height={height} allowDrag={Boolean(trim)} />
    {trim ? <CaptionTimingGrip {...owner} edge="start" left={0} width={grip} height={height} allowDrag /> : null}
    {trim ? <CaptionTimingGrip {...owner} edge="end" left={props.width - grip} width={grip} height={height} allowDrag /> : null}
  </View>;
}

function CaptionTimingGrip(props: CaptionTimingOwner & {
  edge: TimelineTimingEdge; left: number; width: number; height: number; allowDrag: boolean;
}) {
  const current = useRef(props); current.current = props;
  const gesture = useMemo(() => createTimelineTimingGesture(), []);
  const state = useRef({ active: false, abandoned: false, claimed: false, timer: undefined as ReturnType<typeof setTimeout> | undefined });
  const responder = useMemo(() => {
    const clear = () => { if (state.current.timer !== undefined) clearTimeout(state.current.timer); state.current.timer = undefined; };
    const finish = () => {
      clear(); gesture.finish();
      if (state.current.claimed) current.current.onTouchLock?.(false);
      state.current.claimed = false; state.current.active = false; state.current.abandoned = true;
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: (event) => event.nativeEvent.touches.length === 1,
      onMoveShouldSetPanResponder: () => false,
      onPanResponderTerminationRequest: () => !state.current.active,
      onShouldBlockNativeResponder: () => state.current.active,
      onPanResponderGrant: () => {
        clear(); state.current = { active: false, abandoned: false, claimed: true, timer: undefined };
        gesture.begin(current.current, current.current.edge);
        current.current.onTouchLock?.(true);
        if (current.current.onMagnify) state.current.timer = setTimeout(() => {
          finish(); current.current.onMagnify?.();
        }, 450);
      },
      onPanResponderMove: (event, movement) => {
        if (state.current.abandoned) return;
        if (event.nativeEvent?.touches?.length > 1) { finish(); return; }
        if (!Number.isFinite(movement.dx) || !Number.isFinite(movement.dy)) return;
        if (!state.current.active) {
          if (Math.max(Math.abs(movement.dx), Math.abs(movement.dy)) <= 8) return;
          clear();
          if (Math.abs(movement.dy) >= Math.abs(movement.dx) || !current.current.allowDrag) { finish(); return; }
          state.current.active = true;
        }
        gesture.move(movement.dx, movement.dy);
      },
      onPanResponderRelease: finish,
      onPanResponderTerminate: finish,
    });
  }, [gesture]);
  useEffect(() => () => {
    if (state.current.timer !== undefined) clearTimeout(state.current.timer);
    gesture.finish();
    if (state.current.claimed) current.current.onTouchLock?.(false);
    state.current.claimed = false;
    state.current.abandoned = true;
  }, [gesture]);
  return <View {...responder.panHandlers} accessible accessibilityRole="adjustable"
    accessibilityState={{ selected: props.selected }}
    accessibilityLabel={timelineTimingLabel(props.label, props.startMs, props.endMs, props.selected, props.edge)}
    accessibilityActions={props.onMagnify ? [...TIMELINE_ACCESSIBILITY_ACTIONS, { name: 'activate' as const, label: 'Open magnified cue timing' }] : TIMELINE_ACCESSIBILITY_ACTIONS}
    onAccessibilityAction={(event) => {
      if (event.nativeEvent.actionName === 'activate') props.onMagnify?.();
      else adjustTimelineTiming(props, props.edge, event.nativeEvent.actionName);
    }}
    style={{ position: 'absolute', left: props.left, top: 0, width: props.width, height: props.height,
      alignItems: 'center', justifyContent: 'center', borderRadius: 6,
      backgroundColor: props.edge === 'move' ? 'transparent' : '#E8FDFF' }}>
    {props.edge === 'move' ? null : <View pointerEvents="none" style={{ width: 3, height: 20, borderRadius: 2, backgroundColor: '#007FA8' }} />}
  </View>;
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
