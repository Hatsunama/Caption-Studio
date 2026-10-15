import { Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, ScrollView, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { createTimelineNativeScrollGestures, TimelineNativeGestureContext, TimelineNativeGeometryContext, TimelineNativeGestureView, TimelineNativeScrollView } from './timeline-native-gesture';

import { chrome } from '@/lib/ui-theme';
import { orderedTimelineTrackIds, visualTimelineGroups, visualTimelineTrackId, moveTimelineTrack } from '@/lib/timeline-tracks';
import { timelineTouchIntent, type TimelineTouchIntent } from '@/lib/timeline-touch-intent';
import { createTimelineBoundaryFeedback } from '@/lib/timeline-boundary-feedback';
import { timelineHaptic } from '@/services/timeline-haptics';
import { indexTimelineCues, packTimelineLanes, timelineCueChoices, timelineCuePage } from '@/lib/timeline-layout';
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
import { mapPreviewTranslationTracks } from '@/lib/translation-preview-timeline';
import { audioClipEnd } from '@/lib/audio-timeline';
import { audioWaveformWindow } from '@/lib/audio-waveform';
import { adjustTimelineTiming, TIMELINE_ACCESSIBILITY_ACTIONS, timelineTimingLabel, createTimelineGestureGeometry, createTimelineTimingGesture, timelineVisibleTrackBounds, type TimelineTimingGestureOwner } from '@/lib/timeline-gesture';
import { timelineHandleHitLayout, timelineVideoHandleLayout } from '@/lib/timeline-handle-layout';
import { ensureClipFrameThumbnail } from '@/services/project-media';
import type { CaptionPair } from '@/lib/caption-tracks';
import type { TimelineItemReference, TimelineTimingEdge } from '@/lib/timeline-item-editor';
import type { AudioClip, CaptionBlock, ProjectAudioSource, ProjectVideoSource, VideoClip, VisualLayer } from '@/types/project';

const LABEL_WIDTH = 82;
const RULER_HEIGHT = 28;
const TIMELINE_EDGE_HANDLE_WIDTH = 24;
const TIMELINE_EDGE_HANDLE_COLOR = '#64D2FF';
const TIMELINE_EDGE_HANDLE_BAR_COLOR = '#172007';
const LANE_HEIGHT = 32;
const REORDER_TILE = 72;
const REORDER_GAP = 8;
const NEON_CAPTION_COLORS = ['#FF2FA9', '#00B8FF', '#19D98B', '#A855F7', '#FF4D6D', '#00D9C8'];
const clipThumbCache = new Map<string, string>();
const TimelineGestureGeometryContext = TimelineNativeGeometryContext;
type FeedbackTimingOwner = Omit<TimelineTimingGestureOwner, 'onChange'> & {
  getFeedbackBoundaries?: () => readonly number[];
  onChange: (edge: TimelineTimingEdge, startMs: number, endMs: number) => void | { startMs: number; endMs: number };
};

export function LayerTimeline(props: {
  projectId: string;
  availableHeight?: number;
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
  trackOrder?: readonly string[];
  onReorderTrack?: (order: string[]) => void;
  revealRequest?: number;
  onAddVideos: () => void;
  onSelectAudioClip: (clipId: string) => void;
  voiceoverMode?: boolean;
  voiceoverDraft?: { startMs: number; endMs: number; meterLevel: number };
}) {
  const displayLayers = useMemo(() => props.voiceoverMode ? [] : props.layers, [props.layers, props.voiceoverMode]);
  const displayAudioClips = useMemo(() => props.voiceoverMode ? [] : props.audioClips, [props.audioClips, props.voiceoverMode]);
  const horizontalRef = useRef<ScrollView>(null);
  const verticalRef = useRef<ScrollView>(null);
  const labelScrollRef = useRef<ScrollView>(null);
  const verticalOffsetRef = useRef(0);
  const [trackDrag, setTrackDrag] = useState<{ id: string; order: string[] }>();
  const trackDragOrigin = useRef<{ id: string; order: string[]; preview: string[]; top: number; scroll: number; heights: Map<string, number>; dy: number; pageY?: number } | undefined>(undefined);
  const trackViewport = useRef<{ top: number; height: number } | undefined>(undefined);
  const [viewportWidth, setViewportWidth] = useState(360);
  const [clipPreview, setClipPreview] = useState<VideoClip[]>();
  const [frontTrimPreview, setFrontTrimPreview] = useState<{
    clipId: string;
    sourceStartMs: number;
    progress: number;
  }>();
  const [reorderDrag, setReorderDrag] = useState<{ clipId: string; toIndex: number }>();
  const [cueChooser, setCueChooser] = useState<{ trackId: string; startMs: number; endMs: number; offset: number }>();
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
  const displayTranslationTracks = useMemo(
    () => clipPreview && props.clips?.length
      ? mapPreviewTranslationTracks(props.translationTracks, props.clips, clipPreview, displayCaptions)
      : props.translationTracks,
    [clipPreview, props.translationTracks, props.clips, displayCaptions],
  );
  const duration = Math.max(1, props.durationMs, clipPositions.at(-1)?.afterGapEndMs ?? 0);
  const minimumScale = minimumTimelineScale(duration, Math.max(1, viewportWidth - LABEL_WIDTH));
  const [pixelsPerSecond, setPixelsPerSecond] = useState(() => Math.max(16, minimumScale));
  const [gestureGeometry] = useState(() => createTimelineGestureGeometry({ viewportWidth, scale: pixelsPerSecond }));
  const [nativeScrollGestures] = useState(createTimelineNativeScrollGestures);
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
  const selectionOwnsViewportRef = useRef(false);
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
    props.selectedLayerId === 'captions' ? props.selectedCaptionId : undefined, gestureLock),
  [captionIndex, duration, trackWidth, visibleTrackBounds, props.selectedLayerId, props.selectedCaptionId, gestureLock]);
  const translationPages = useMemo(() => new Map([...translationIndexes].map(([id, index]) => [id,
    timelineCuePage(index, duration, trackWidth, visibleTrackBounds, props.selectedLayerId === id ? props.selectedCaptionId : undefined, gestureLock),
  ])), [translationIndexes, duration, trackWidth, visibleTrackBounds, props.selectedLayerId, props.selectedCaptionId, gestureLock]);
  const chooserChoices = cueChooser
    ? cueChooser.trackId === 'captions'
      ? timelineCueChoices(captionIndex, cueChooser.startMs, cueChooser.endMs, cueChooser.offset)
      : timelineCueChoices(translationIndexes.get(cueChooser.trackId)!, cueChooser.startMs, cueChooser.endMs, cueChooser.offset)
    : undefined;
  const selectedCue = useMemo(() => {
    const index = props.selectedLayerId === 'captions' ? captionIndex : translationIndexes.get(props.selectedLayerId ?? '');
    const ordinal = index?.byId.get(props.selectedCaptionId ?? '');
    return ordinal === undefined ? undefined : index?.ordered[ordinal];
  }, [captionIndex, props.selectedCaptionId, props.selectedLayerId, translationIndexes]);
  const captionLayout = captionPage.layout;
  const captionRowHeight = captionLayout.laneCount * LANE_HEIGHT + 10;
  const translationRowHeight = (id: string) => translationPages.get(id)!.layout.laneCount * LANE_HEIGHT + 10;
  const audioLayout = useMemo(() => packTimelineLanes(displayAudioClips.filter((clip) => !clip.hiddenByVideoTrim)
    .map((clip) => ({ id: clip.id, startMs: clip.startMs, endMs: audioClipEnd(clip) }))), [displayAudioClips]);
  const audioRowHeight = Math.max(1, audioLayout.laneCount) * LANE_HEIGHT + 10;
  const sourceById = useMemo(() => new Map(props.sources.map((source) => [source.id, source])), [props.sources]);
  const visualGroups = useMemo(() => visualTimelineGroups(displayLayers), [displayLayers]);
  // Snapshot once at gesture start, not per pointer frame. IDs are namespaced:
  // translated cues can share a source ID without excluding the primary cue.
  const feedbackEntries = useMemo(() => [
    ...buildClipTimeline(props.clips).map(({ clip, startMs, endMs }) => ({ id: 'video:' + clip.id, startMs, endMs })),
    ...displayAudioClips.filter((clip) => !clip.hiddenByVideoTrim).map((clip) => ({ id: 'audio:' + clip.id, startMs: clip.startMs, endMs: audioClipEnd(clip) })),
    ...displayLayers.flatMap((layer) => layer.kind !== 'captions' && layer.timelineVisible !== false
      ? [{ id: 'visual:' + layer.id, startMs: layer.startMs, endMs: layer.endMs }] : []),
    ...props.captions.filter((cue) => cue.timelineVisible !== false).map((cue) => ({ id: 'caption:' + cue.id, startMs: cue.startMs, endMs: cue.endMs })),
    ...props.translationTracks.flatMap((track) => track.pairs.filter((pair) => pair.timelineVisible)
      .map((pair) => ({ id: 'translation:' + track.id + ':' + pair.source.id, startMs: pair.startMs, endMs: pair.endMs }))),
  ], [props.clips, displayAudioClips, displayLayers, props.captions, props.translationTracks]);
  const feedbackBoundaries = (excludedId: string) => () => [0, duration, props.currentMs,
    ...feedbackEntries.filter((entry) => entry.id !== excludedId).flatMap((entry) => [entry.startMs, entry.endMs])];
  const videoRowHeight = reorderMode ? 90 : 46;
  const groupById = new Map(visualGroups.map((group) => [group.id, group]));
  const availableTracks = ['video', 'audio'];
  for (const layer of displayLayers) {
    const id = visualTimelineTrackId(layer);
    if (!availableTracks.includes(id)) availableTracks.push(id);
    if (layer.kind === 'captions') for (const track of displayTranslationTracks) availableTracks.push('translation:' + track.id);
  }
  const orderedTracks = props.voiceoverMode ? ['video', 'audio'] : orderedTimelineTrackIds(availableTracks, props.trackOrder);
  const shownTracks = trackDrag?.order ?? orderedTracks;
  const rowHeight = (id: string) => id === 'video' ? videoRowHeight : id === 'audio' ? audioRowHeight
    : id === 'captions' ? captionRowHeight : id.startsWith('translation:') ? translationRowHeight(id.slice(12))
    : (groupById.get(id)?.layout.laneCount ?? 1) * LANE_HEIGHT + 14;
  const totalRowsHeight = shownTracks.reduce((height, id) => height + rowHeight(id), 0);
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

  const selectedTrackId = props.selectedClipId ? 'video' : props.selectedAudioClipId ? 'audio'
    : displayTranslationTracks.some((track) => track.id === props.selectedLayerId) ? 'translation:' + props.selectedLayerId
    : (() => { const layer = displayLayers.find((item) => item.id === props.selectedLayerId); return layer ? visualTimelineTrackId(layer) : undefined; })();
  const selectedRowTop = shownTracks.slice(0, Math.max(0, shownTracks.indexOf(selectedTrackId ?? '')))
    .reduce((top, id) => top + rowHeight(id), 0);
  const syncVerticalScroll = useCallback((y: number, source: 'items' | 'labels' | 'reveal') => {
    const next = Math.max(0, y);
    if (source !== 'reveal' && Math.abs(next - verticalOffsetRef.current) < 0.5) return;
    verticalOffsetRef.current = next;
    if (source !== 'items') verticalRef.current?.scrollTo({ y: next, animated: false });
    if (source !== 'labels') labelScrollRef.current?.scrollTo({ y: next, animated: false });
  }, []);
  useEffect(() => {
    verticalOffsetRef.current = 0;
    verticalRef.current?.scrollTo({ y: 0, animated: false });
    labelScrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [props.projectId, props.revealRequest]);
  const revealCue = useCallback((_startMs: number) => {
    verticalOffsetRef.current = selectedRowTop;
    verticalRef.current?.scrollTo({ y: selectedRowTop, animated: false });
    labelScrollRef.current?.scrollTo({ y: selectedRowTop, animated: false });
  }, [selectedRowTop]);
  const lastRevealRef = useRef<{ id: string; trackWidth: number; viewportWidth: number } | undefined>(undefined);
  const hasSelectedCue = selectedCue !== undefined;
  useEffect(() => {
    if (hasSelectedCue) {
      verticalOffsetRef.current = selectedRowTop;
      verticalRef.current?.scrollTo({ y: selectedRowTop, animated: false });
      labelScrollRef.current?.scrollTo({ y: selectedRowTop, animated: false });
    }
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
    setFrontTrimPreview(undefined);
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

  const selectTimelineItem = (select: () => void, feedback = true) => {
    if (scrubEndTimer.current) clearTimeout(scrubEndTimer.current);
    scrubEndTimer.current = null;
    scrubbingRef.current = false;
    selectionOwnsViewportRef.current = false;
    if (feedback) timelineHaptic('selection');
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
    selectionOwnsViewportRef.current = false;
    props.onTimingChangeEnd();
  };

  const updateZoom = (next: number) => {
    const clamped = clampTimelineScale(next, minimumScale);
    gestureGeometry.update({ scale: clamped });
    setPixelsPerSecond(clamped);
    setZoomNotice(timelineZoomPercent(clamped, minimumScale));
    if (zoomTimer.current) clearTimeout(zoomTimer.current);
    zoomTimer.current = setTimeout(() => setZoomNotice(undefined), 1_100);
  };

  const timelineTouchLock = (locked: boolean) => {
    if (locked) selectTimelineItem(() => {}, false);
    setItemGestureLock(locked);
  };
  const rows = new Map<string, React.ReactElement<Parameters<typeof TimelineRow>[0]>>();
  rows.set('video', (<TimelineRow label="VIDEO" labelColor={chrome.accent} selected={Boolean(props.selectedClipId)} trackWidth={trackWidth} height={videoRowHeight} onPressTrack={(x) => { props.onClearSelection(); props.onSeek(x / trackWidth * duration); }} controls={<Text style={{ color: chrome.muted, fontSize: 8 }}>{props.clips.length} CLIP{props.clips.length === 1 ? '' : 'S'}</Text>}>
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
                    playheadMs={props.currentMs}
                    getFeedbackBoundaries={feedbackBoundaries('video:' + clip.id)}
                    filmstrip={reorderMode}
                    tileSize={REORDER_TILE}
                    tileGap={REORDER_GAP}
                    selected={props.selectedClipId === clip.id || reordering}
                    reordering={reordering}
                    color={index % 2 ? '#38404A' : '#46515D'}
                    onPress={() => selectTimelineItem(() => props.onSelectClip(clip.id))}
                    onGestureLock={setItemGestureLock}
                    onGestureCancel={() => {
                      setItemGestureLock(false);
                      setReorderDrag(undefined);
                      setClipPreview(undefined);
                      setFrontTrimPreview(undefined);
                    }}
                    onTrimPreview={(edge, targetSourceMs) => {
                      setItemGestureLock(true);
                      const preview = previewVideoClipTrim(clip, edge, targetSourceMs);
                      setClipPreview(props.clips.map((candidate) => candidate.id === clip.id ? preview : candidate));
                      if (edge === 'start') setFrontTrimPreview({
                        clipId: clip.id,
                        sourceStartMs: preview.sourceStartMs,
                        progress: clamp((preview.sourceStartMs - clip.availableSourceStartMs) /
                          Math.max(1, clip.availableSourceEndMs - clip.availableSourceStartMs), 0, 1),
                      });
                    }}
                    onTrimCommit={(edge, targetSourceMs) => {
                      setItemGestureLock(false);
                      setClipPreview(undefined);
                      setFrontTrimPreview(undefined);
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
            </TimelineRow>));
  rows.set('audio', (<TimelineRow label={props.voiceoverMode ? "VOICE OVER" : "AUDIO"} labelColor={props.voiceoverMode ? "#FF4D6D" : "#64E8FF"} selected={Boolean(props.selectedAudioClipId)} trackWidth={trackWidth} height={audioRowHeight} onPressTrack={(x) => { props.onClearSelection(); props.onSeek(x / trackWidth * duration); }} controls={<Text style={{ color: props.voiceoverMode ? '#FFB8C5' : '#6F7985', fontSize: 8 }}>{props.voiceoverMode ? 'LIVE TAKE' : `${props.audioClips.length} TRACK${props.audioClips.length === 1 ? '' : 'S'}`}</Text>}>
              {displayAudioClips.filter((clip) => !clip.hiddenByVideoTrim && isVisible(clip.startMs, audioClipEnd(clip))).map((clip) => {
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
                    color={clip.muted ? '#59636F' : '#006D78'}
                    selected={props.selectedAudioClipId === clip.id}
                    waveformPeaks={source?.waveformPeaks}
                    waveformVisibleStartMs={visibleRange.startMs}
                    waveformVisibleEndMs={visibleRange.endMs}
                    sourceStartMs={clip.sourceStartMs}
                    sourceEndMs={clip.sourceEndMs}
                    sourceDurationMs={source?.durationMs}
                    getFeedbackBoundaries={feedbackBoundaries('audio:' + clip.id)}
                    onPress={() => selectTimelineItem(() => props.onSelectAudioClip(clip.id))}
                    onTouchLock={timelineTouchLock}
                    onChangeStart={beginBlockGesture}
                    playheadMs={props.currentMs}
                    onChange={(edge, startMs, endMs) => props.onItemTimingChange({ kind: 'audio', clipId: clip.id }, edge, startMs, endMs)}
                    onEnd={endBlockGesture}
                  />
                );
              })}
              {props.voiceoverDraft ? <LiveRecordingBlock {...props.voiceoverDraft} durationMs={duration} trackWidth={trackWidth} /> : null}
            </TimelineRow>));
  if (!props.voiceoverMode) {
    if (displayLayers.some((layer) => layer.kind === 'captions')) rows.set('captions', (
      <TimelineRow label="CAPTIONS" labelColor="#FF4FD8" selected={props.selectedLayerId === 'captions'}
        onPressLabel={() => selectTimelineItem(() => props.onSelectLayer('captions'))}
        onPressTrack={(x) => { props.onClearSelection(); props.onSeek(x / trackWidth * duration); }} trackWidth={trackWidth} height={captionRowHeight}>
        {captionPage.overview.map((entry) => <TimelineCoverageStrip key={entry.left + ':' + entry.width} {...entry} trackWidth={trackWidth} color="#FF4FD8" onPress={() => setCueChooser({ trackId: 'captions', startMs: entry.startMs, endMs: entry.endMs, offset: 0 })} />)}
        {captionPage.bodies.map((caption) => <TimedBlock key={caption.id} onTouchLock={timelineTouchLock} getFeedbackBoundaries={feedbackBoundaries('caption:' + caption.id)} label={caption.text} startMs={caption.startMs} endMs={caption.endMs} durationMs={duration} trackWidth={trackWidth} playheadMs={props.currentMs} lane={captionLayout.laneById.get(caption.id) ?? 0} color={NEON_CAPTION_COLORS[captionIndex.byId.get(caption.id)! % NEON_CAPTION_COLORS.length]} selected={props.selectedLayerId === 'captions' && props.selectedCaptionId === caption.id} onPress={() => selectTimelineItem(() => props.onSelectCaption(caption))} onChangeStart={beginBlockGesture} onChange={(edge, startMs, endMs) => props.onItemTimingChange({ kind: 'caption', captionId: caption.id }, edge, startMs, endMs)} onEnd={endBlockGesture} />)}
      </TimelineRow>
    ));
    for (const group of visualGroups) rows.set(group.id, (
      <TimelineRow label={group.id.toUpperCase()} labelColor={group.id === 'images' ? '#64E8FF' : group.id === 'watermarks' ? '#FF8FC4' : '#A985F8'}
        selected={selectedTrackId === group.id} trackWidth={trackWidth} height={rowHeight(group.id)}
        onPressTrack={(x) => { props.onClearSelection(); props.onSeek(x / trackWidth * duration); }}>
        {group.items.map((layer) => <TimedBlock key={layer.id} onTouchLock={timelineTouchLock}
          getFeedbackBoundaries={feedbackBoundaries('visual:' + layer.id)}
          label={layer.kind === 'text' ? layer.text : layer.name || 'IMAGE'} thumbnailUri={layer.kind === 'image' ? layer.uri : undefined}
          startMs={layer.startMs} endMs={layer.endMs} durationMs={duration} trackWidth={trackWidth} playheadMs={props.currentMs}
          lane={group.layout.laneById.get(layer.id) ?? 0} color={layer.kind === 'text' ? layer.watermark ? '#E8579C88' : '#A855F7' : '#00B8FF'}
          selected={props.selectedLayerId === layer.id} onPress={() => selectTimelineItem(() => props.onSelectLayer(layer.id))}
          onChangeStart={beginBlockGesture} onChange={(edge, startMs, endMs) => props.onItemTimingChange({ kind: 'visual', layerId: layer.id }, edge, startMs, endMs)} onEnd={endBlockGesture} />)}
      </TimelineRow>
    ));
    for (const [trackIndex, track] of displayTranslationTracks.entries()) rows.set('translation:' + track.id, (<TimelineRow
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
                    {translationPages.get(track.id)!.overview.map((entry) => (
                      <TimelineCoverageStrip key={`${entry.left}:${entry.width}`} {...entry} trackWidth={trackWidth} color="#64E8FF" onPress={() => setCueChooser({ trackId: track.id, startMs: entry.startMs, endMs: entry.endMs, offset: 0 })} />
                    ))}
                    {translationPages.get(track.id)!.bodies.map(({ pair }) => (
                      <TimedBlock
                        key={pair.translation.id}
                        onTouchLock={timelineTouchLock}
                        label={pair.displayProvenance === 'source-fallback' ? `${pair.displayText} (source fallback)` : pair.displayText || 'Translation pending'}
                        startMs={pair.startMs}
                        endMs={pair.endMs}
                        durationMs={duration}
                        trackWidth={trackWidth}
                        lane={translationPages.get(track.id)!.layout.laneById.get(pair.source.id) ?? 0}
                        color={pair.translation.status === 'stale' || pair.translation.status === 'pending' || pair.translation.status === 'failed'
                          ? '#A66220'
                          : NEON_CAPTION_COLORS[(translationIndexes.get(track.id)!.byId.get(pair.source.id)! + trackIndex + 1) % NEON_CAPTION_COLORS.length]}
                        selected={props.selectedLayerId === track.id && props.selectedCaptionId === pair.source.id}
                        onPress={() => selectTimelineItem(() => props.onSelectTranslationCaption(track.id, pair))}
                        onChangeStart={beginBlockGesture}
                        playheadMs={props.currentMs}
                        getFeedbackBoundaries={feedbackBoundaries('translation:' + track.id + ':' + pair.source.id)}
                        onChange={(edge, startMs, endMs) => props.onItemTimingChange({ kind: 'translation', trackId: track.id, sourceCaptionId: pair.source.id }, edge, startMs, endMs)}
                        onEnd={endBlockGesture}
                      />
                    ))}
                  </TimelineRow>));
  }
  const moveTrack = useCallback((id: string, dy: number, pageY?: number) => {
    const origin = trackDragOrigin.current;
    if (!origin || origin.id !== id) return;
    origin.dy = dy;
    if (Number.isFinite(pageY)) origin.pageY = pageY;
    const center = origin.top + dy + verticalOffsetRef.current - origin.scroll + (origin.heights.get(id) ?? 46) / 2;
    let top = 0;
    let destination = 0;
    for (const candidate of origin.order) {
      const height = origin.heights.get(candidate) ?? 46;
      if (candidate !== id && center > top + height / 2) destination++;
      top += height;
    }
    const next = moveTimelineTrack(origin.order, id, destination);
    if (next.some((item, index) => item !== origin.preview[index])) timelineHaptic('boundary');
    origin.preview = next;
    setTrackDrag({ id, order: origin.preview });
  }, []);
  useEffect(() => {
    if (!trackDrag?.id) return;
    const timer = setInterval(() => {
      const origin = trackDragOrigin.current;
      const viewport = trackViewport.current;
      if (!origin || !viewport || origin.pageY === undefined) return;
      const direction = origin.pageY < viewport.top + 28 ? -1 : origin.pageY > viewport.top + viewport.height - 28 ? 1 : 0;
      if (!direction) return;
      const extent = [...origin.heights.values()].reduce((sum, height) => sum + height, 0);
      const next = Math.max(0, Math.min(Math.max(0, extent - viewport.height), verticalOffsetRef.current + direction * 8));
      if (next === verticalOffsetRef.current) return;
      syncVerticalScroll(next, 'reveal');
      moveTrack(origin.id, origin.dy, origin.pageY);
    }, 40);
    return () => clearInterval(timer);
  }, [trackDrag?.id, moveTrack, syncVerticalScroll]);
  return (
    <TimelineNativeGestureContext.Provider value={nativeScrollGestures}>
    <TimelineGestureGeometryContext.Provider value={gestureGeometry}>
    <View
      onLayout={(event) => {
        const width = Math.max(1, event.nativeEvent.layout.width);
        if (gestureGeometry.update({ viewportWidth: width })) {
          if (scrubEndTimer.current) clearTimeout(scrubEndTimer.current);
          scrubEndTimer.current = null;
          scrubbingRef.current = false;
          selectionOwnsViewportRef.current = false;
          pinch.current.distance = 0;
        }
        setViewportWidth(width);
      }}
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
      style={{ height: Math.min(props.availableHeight ?? 330, totalRowsHeight + RULER_HEIGHT + 38), overflow: 'hidden', borderRadius: 22, backgroundColor: '#1C1C1E' }}>
      <View style={{ height: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingHorizontal: 44, borderBottomWidth: 1, borderBottomColor: '#1D242C' }}>
        <ZoomButton label="−" onPress={() => updateZoom(effectiveScale / 1.5)} />
        <Text style={{ minWidth: 70, color: '#D7DDE5', textAlign: 'center', fontSize: 10, fontWeight: '800' }}>{zoomPercent}%</Text>
        <ZoomButton label="+" onPress={() => updateZoom(effectiveScale * 1.5)} />
      </View>
      <TimelineNativeScrollView
        nativeGesture={nativeScrollGestures[0]}
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
        <View style={{ width: LABEL_WIDTH + trackWidth + trailingPadding, height: '100%', marginLeft: leadingPadding }}>
          <TimelineRuler durationMs={duration} trackWidth={trackWidth} pixelsPerSecond={effectiveScale} visibleStartMs={visibleRange.startMs} visibleEndMs={visibleRange.endMs} />
          <TimelineNativeScrollView nativeGesture={nativeScrollGestures[1]} key={props.projectId} ref={verticalRef} style={{ marginTop: RULER_HEIGHT }} contentContainerStyle={{ paddingVertical: 1 }} nestedScrollEnabled scrollEnabled={!gestureLock}
            scrollEventThrottle={16} onScroll={(event) => syncVerticalScroll(event.nativeEvent.contentOffset.y, 'items')}>
            {shownTracks.map((id) => <Fragment key={id}>{rows.get(id)}</Fragment>)}
          </TimelineNativeScrollView>
        </View>
      </TimelineNativeScrollView>
      <TimelineNativeScrollView nativeGesture={nativeScrollGestures[2]} ref={labelScrollRef} testID="timeline-track-labels" nestedScrollEnabled scrollEnabled={!gestureLock}
        scrollEventThrottle={16} onScroll={(event) => syncVerticalScroll(event.nativeEvent.contentOffset.y, 'labels')}
        contentContainerStyle={{ paddingVertical: 1 }} style={{ position: 'absolute', left: 0, width: LABEL_WIDTH, top: 36 + RULER_HEIGHT, bottom: 0, backgroundColor: '#1C1C1E' }}>
        {shownTracks.map((id) => {
          const row = rows.get(id);
          if (!row) return null;
          return <View key={id} style={{ height: row.props.height, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#1D242C', backgroundColor: row.props.selected ? '#252D22' : '#1C1C1E' }}>
            {!props.voiceoverMode ? <TimelineTrackHandle label={row.props.label} disabled={!props.onReorderTrack}
              onStart={() => {
                timelineHaptic('selection');
                const top = orderedTracks.slice(0, orderedTracks.indexOf(id)).reduce((sum, item) => sum + rowHeight(item), 0);
                trackDragOrigin.current = { id, order: [...orderedTracks], preview: [...orderedTracks], top, scroll: verticalOffsetRef.current, heights: new Map(orderedTracks.map((item) => [item, rowHeight(item)])), dy: 0 };
                labelScrollRef.current?.getNativeScrollRef()?.measureInWindow((_x, y, _width, height) => { trackViewport.current = { top: y, height }; });
                setTrackDrag({ id, order: [...orderedTracks] });
                setItemGestureLock(true);
              }}
              onMove={(dy, pageY) => moveTrack(id, dy, pageY)}
              onFinish={(cancelled) => {
                const origin = trackDragOrigin.current;
                trackDragOrigin.current = undefined;
                setItemGestureLock(false);
                if (!cancelled && origin && origin.preview.some((item, index) => item !== origin.order[index])) props.onReorderTrack?.(origin.preview);
                setTrackDrag(undefined);
              }}
              onAccessibleMove={(direction) => props.onReorderTrack?.(moveTimelineTrack(orderedTracks, id, orderedTracks.indexOf(id) + direction))} /> : null}
            <Pressable onPress={row.props.onPressLabel} disabled={!row.props.onPressLabel} accessibilityRole={row.props.onPressLabel ? 'button' : 'text'} accessibilityLabel={row.props.label}
              style={{ flex: 1, minHeight: 44, justifyContent: 'center', paddingHorizontal: 3 }}>
              <Text numberOfLines={1} style={{ color: row.props.labelColor, fontSize: 8, fontWeight: '900' }}>{row.props.label}</Text>
              {row.props.controls}
            </Pressable>
          </View>;
        })}
      </TimelineNativeScrollView>
      {frontTrimPreview ? <View testID="front-trim-feedback" pointerEvents="none" style={{ position: 'absolute', left: 8, right: 8, bottom: 8, zIndex: 12, padding: 8, borderRadius: 10, borderWidth: 1, borderColor: '#64D2FF', backgroundColor: 'rgba(8, 16, 22, 0.96)', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flex: 1, gap: 5 }}>
          <Text style={{ color: '#64D2FF', fontSize: 9, fontWeight: '900' }}>NEW START · {formatRulerTime(frontTrimPreview.sourceStartMs, 100)}</Text>
          <View style={{ height: 4, borderRadius: 2, backgroundColor: '#384A55', overflow: 'hidden' }}>
            <View style={{ width: `${frontTrimPreview.progress * 100}%`, height: 4, backgroundColor: '#64D2FF' }} />
          </View>
        </View>
      </View> : null}
      <View pointerEvents="none" style={{ position: 'absolute', left: '50%', top: 36, bottom: 0, width: 2, marginLeft: -1, backgroundColor: '#FF5267' }}>
        <View style={{ position: 'absolute', left: -7, top: 0, width: 0, height: 0, borderLeftWidth: 8, borderRightWidth: 8, borderTopWidth: 11, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: '#FF5267' }} />
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Add videos to the end of the timeline" onPress={props.onAddVideos} style={{ position: 'absolute', right: 8, top: 2, width: 34, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 17, backgroundColor: '#64D2FF' }}>
        <Text style={{ color: '#11140C', fontSize: 22, fontWeight: '700', lineHeight: 25 }}>+</Text>
      </Pressable>
      {cueChooser && chooserChoices ? <View testID="timeline-cue-chooser" style={{ position: 'absolute', left: 8, right: 8, bottom: 8, height: 220, zIndex: 20, padding: 10, borderRadius: 12, borderWidth: 1, borderColor: '#667481', backgroundColor: '#222A32' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <Text style={{ color: '#FFFFFF', fontSize: 12, fontWeight: '900' }}>SELECT CUE · {cueChooser.offset + 1}{chooserChoices.hasMore ? '+' : `–${cueChooser.offset + chooserChoices.cues.length}`}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close cue chooser" onPress={() => setCueChooser(undefined)} hitSlop={8}><Text style={{ color: '#FFFFFF', fontSize: 20 }}>×</Text></Pressable>
        </View>
        <ScrollView style={{ flex: 1 }} nestedScrollEnabled>
          {chooserChoices.cues.map((cue) => {
            const label = cueChooser.trackId === 'captions'
              ? captionIndex.ordered[captionIndex.byId.get(cue.id)!]?.text ?? ''
              : translationIndexes.get(cueChooser.trackId)!.ordered[translationIndexes.get(cueChooser.trackId)!.byId.get(cue.id)!]?.pair.displayText || 'Translation pending';
            const time = `${formatRulerTime(cue.startMs, 100)}–${formatRulerTime(cue.endMs, 100)}`;
            return <Pressable key={cue.id} testID="timeline-cue-choice" accessibilityRole="button" accessibilityLabel={`${label}, ${time}`} onPress={() => {
              const trackId = cueChooser.trackId;
              setCueChooser(undefined);
              if (trackId === 'captions') {
                const caption = captionIndex.ordered[captionIndex.byId.get(cue.id)!];
                selectTimelineItem(() => props.onSelectCaption(caption));
              } else {
                const pair = translationIndexes.get(trackId)!.ordered[translationIndexes.get(trackId)!.byId.get(cue.id)!].pair;
                selectTimelineItem(() => props.onSelectTranslationCaption(trackId, pair));
              }
            }} style={{ paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#3D4853' }}>
              <Text numberOfLines={2} style={{ color: '#FFFFFF', fontSize: 12 }}>{label}</Text>
              <Text style={{ color: '#B9C6D2', fontSize: 10 }}>{time}</Text>
            </Pressable>;
          })}
        </ScrollView>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Previous cue choices" disabled={cueChooser.offset === 0} onPress={() => setCueChooser({ ...cueChooser, offset: Math.max(0, cueChooser.offset - 32) })}><Text style={{ color: cueChooser.offset === 0 ? '#68737E' : '#64D2FF', fontSize: 12 }}>Previous</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Next cue choices" disabled={!chooserChoices.hasMore} onPress={() => setCueChooser({ ...cueChooser, offset: cueChooser.offset + 32 })}><Text style={{ color: chooserChoices.hasMore ? '#64D2FF' : '#68737E', fontSize: 12 }}>Next</Text></Pressable>
        </View>
      </View> : null}
      {zoomNotice == null ? null : <View pointerEvents="none" style={{ position: 'absolute', alignSelf: 'center', top: 72, paddingHorizontal: 16, paddingVertical: 9, borderRadius: 14, backgroundColor: 'rgba(5,7,9,0.92)' }}><Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '900' }}>{zoomNotice}%</Text></View>}
    </View>
    </TimelineGestureGeometryContext.Provider>
    </TimelineNativeGestureContext.Provider>
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
  playheadMs: number;
  getFeedbackBoundaries?: () => readonly number[];
  filmstrip?: boolean;
  tileSize?: number;
  tileGap?: number;
  selected: boolean;
  reordering?: boolean;
  color: string;
  onPress: () => void;
  onGestureLock: (locked: boolean) => void;
  onGestureCancel: () => void;
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
  const blockLeft = props.filmstrip
    ? props.clipIndex * (tile + gap)
    : props.startMs / props.durationMs * props.trackWidth;
  const blockWidth = props.filmstrip
    ? tile
    : Math.max(2, clipDuration / props.durationMs * props.trackWidth - 2);
  const showTrimGrips = props.selected && !props.reordering && !props.filmstrip;
  const handleLayout = timelineVideoHandleLayout(blockLeft, blockWidth, props.trackWidth, showTrimGrips);
  return (
    <View
      style={{
        position: 'absolute',
        left: handleLayout.left,
        width: handleLayout.width,
        top: props.filmstrip || props.reordering ? 4 : showTrimGrips ? 0 : 3,
        bottom: props.filmstrip || props.reordering ? 4 : showTrimGrips ? 0 : 3,
        zIndex: props.reordering ? 8 : props.selected ? 5 : 1,
        overflow: 'visible',
        transform: props.reordering ? [{ scale: 1.04 }] : undefined,
      }}>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: handleLayout.visualLeft,
          width: handleLayout.visualWidth,
          top: showTrimGrips ? 3 : 0,
          bottom: showTrimGrips ? 3 : 0,
          justifyContent: props.filmstrip ? 'flex-end' : 'center',
          paddingHorizontal: props.filmstrip ? 4 : 10,
          paddingBottom: props.filmstrip ? 4 : 0,
          overflow: 'hidden',
          borderRadius: props.filmstrip ? 10 : chrome.radius.sm,
          borderWidth: props.selected || props.reordering ? 2 : props.filmstrip ? 1 : 0,
          borderColor: props.reordering ? '#FFFFFF' : props.selected ? chrome.accent : '#2A323A',
          backgroundColor: props.color,
          opacity: props.reordering ? 0.98 : 1,
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
      </View>
      <VideoMoveGrip {...props} bodyLeft={handleLayout.visualLeft} bodyWidth={handleLayout.visualWidth}
        moveLeft={'moveLeft' in handleLayout ? handleLayout.moveLeft : undefined}
        moveWidth={'moveWidth' in handleLayout ? handleLayout.moveWidth : undefined} />
      {showTrimGrips ? (
        <>
          <VideoTrimGrip {...props} side="start" gripLeft={handleLayout.startGripLeft} />
          <VideoTrimGrip {...props} side="end" gripLeft={handleLayout.endGripLeft} />
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
  const cacheKey = `${props.projectId}:${props.clipId}:${props.sourceUri ?? ''}:${Math.round(props.sourceStartMs)}`;
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

function VideoTrimGrip(props: Parameters<typeof VideoClipBlock>[0] & { side: 'start' | 'end'; gripLeft: number }) {
  const propsRef = useRef(props);
  propsRef.current = props;
  const targetRef = useRef(props.side === 'start' ? props.clip.sourceStartMs : props.clip.sourceEndMs);
  const initialClipRef = useRef(props.clip);
  const initialBoundaryRef = useRef(props.side === 'start' ? props.startMs : props.endMs);
  const { nativeCallbacks, ...panHandlers } = useTimelineTimingPanHandlers({
    startMs: props.startMs,
    endMs: props.endMs,
    durationMs: props.durationMs,
    trackWidth: props.trackWidth,
    playheadMs: props.playheadMs,
    getFeedbackBoundaries: props.getFeedbackBoundaries,
    onPress: props.onPress,
    onChangeStart: () => {
      const current = propsRef.current;
      initialClipRef.current = current.clip;
      initialBoundaryRef.current = current.side === 'start' ? current.startMs : current.endMs;
      targetRef.current = current.side === 'start'
        ? current.clip.sourceStartMs
        : current.clip.sourceEndMs;
    },
    onChange: (edge, startMs, endMs) => {
      const current = propsRef.current;
      const initialClip = initialClipRef.current;
      const trimEdge: 'start' | 'end' = edge === 'start' ? 'start' : 'end';
      const boundaryMs = trimEdge === 'start' ? startMs : endMs;
      const sourceDelta = (boundaryMs - initialBoundaryRef.current) * initialClip.playbackRate;
      const target = trimEdge === 'start'
        ? clamp(
            initialClip.sourceStartMs + sourceDelta,
            initialClip.availableSourceStartMs,
            initialClip.sourceEndMs - 120 * initialClip.playbackRate,
          )
        : clamp(
            initialClip.sourceEndMs + sourceDelta,
            initialClip.sourceStartMs + 120 * initialClip.playbackRate,
            initialClip.availableSourceEndMs,
          );
      targetRef.current = target;
      current.onTrimPreview(trimEdge, target);
      // Report the clamped grabbed edge, not an impossible pointer position
      // beyond available source frames. Start trims still use ripple preview.
      const appliedBoundary = initialBoundaryRef.current + (target -
        (trimEdge === 'start' ? initialClip.sourceStartMs : initialClip.sourceEndMs)) / initialClip.playbackRate;
      return trimEdge === 'start'
        ? { startMs: appliedBoundary, endMs: initialBoundaryRef.current + (initialClip.sourceEndMs - initialClip.sourceStartMs) / initialClip.playbackRate }
        : { startMs: initialBoundaryRef.current - (initialClip.sourceEndMs - initialClip.sourceStartMs) / initialClip.playbackRate, endMs: appliedBoundary };
    },
    onEnd: () => {
      const current = propsRef.current;
      current.onTrimCommit(current.side, targetRef.current);
    },
    onCancel: () => propsRef.current.onGestureCancel(),
  }, props.side, props.onGestureLock);
  return (
    <TimelineNativeGestureView
      panHandlers={panHandlers}
      nativeCallbacks={nativeCallbacks}
      accessibilityRole="adjustable"
      accessibilityLabel={`${props.side === 'start' ? 'Start' : 'End'} trim handle`}
      style={{ position: 'absolute', left: props.gripLeft, top: 0, bottom: 0, width: TIMELINE_EDGE_HANDLE_WIDTH, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: TIMELINE_EDGE_HANDLE_COLOR }}>
      <View pointerEvents="none" style={{ width: 3, height: 18, borderRadius: 2, backgroundColor: TIMELINE_EDGE_HANDLE_BAR_COLOR }} />
    </TimelineNativeGestureView>
  );
}

function VideoMoveGrip(props: Parameters<typeof VideoClipBlock>[0] & { bodyLeft: number; bodyWidth: number; moveLeft?: number; moveWidth?: number }) {
  const [feedback] = useState(() => createTimelineBoundaryFeedback(() => timelineHaptic('boundary')));
  const feedbackOrigin = useRef({ startMs: props.startMs, endMs: props.endMs });
  const intent = useRef<TimelineTouchIntent>('pending');
  const gestureGeometry = useContext(TimelineGestureGeometryContext);
  const claimed = useRef(false);
  const propsRef = useRef(props);
  propsRef.current = props;
  const gapRef = useRef(props.leadingGapMs);
  const initialGapRef = useRef(props.leadingGapMs);
  const millisecondsPerPixel = useRef(props.durationMs / Math.max(1, props.trackWidth));
  const reorderIndexRef = useRef(props.clipIndex);
  const originIndexRef = useRef(props.clipIndex);
  const modeRef = useRef<'none' | 'gap' | 'reorder'>('none');
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressArmedRef = useRef(false);

  const cancelGesture = useCallback(() => {
    feedback.reset();
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
    modeRef.current = 'none';
    longPressArmedRef.current = false;
    if (!claimed.current) return;
    claimed.current = false;
    propsRef.current.onGestureCancel();
  }, [feedback]);

  const [responder] = useState(() => {
    const previewGap = (gap: number) => {
      propsRef.current.onGapPreview(gap);
      const delta = gap - initialGapRef.current;
      feedback.update(feedbackOrigin.current.startMs + delta, feedbackOrigin.current.endMs + delta);
    };
    const clearLongPress = () => {
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    };
    const finishGesture = (kind: 'release' | 'terminate') => {
      clearLongPress();
      feedback.reset();
      if (!claimed.current) return;
      claimed.current = false;
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
    const shouldClaim = (_event: unknown, movement: { dx: number; dy: number }) => {
      if (longPressArmedRef.current) return true;
      if (intent.current === 'pending') intent.current = timelineTouchIntent(movement.dx, movement.dy);
      return intent.current === 'horizontal';
    };
    const begin = (movement?: { dx: number; dy: number }, reorder = false) => {
      const wasArmed = reorder || longPressArmedRef.current;
      claimed.current = true;
      propsRef.current.onPress();
      propsRef.current.onGestureLock(true);
      initialGapRef.current = propsRef.current.leadingGapMs;
      millisecondsPerPixel.current = propsRef.current.durationMs / Math.max(1, propsRef.current.trackWidth);
      gapRef.current = initialGapRef.current;
      originIndexRef.current = propsRef.current.clipIndex;
      reorderIndexRef.current = propsRef.current.clipIndex;
      feedbackOrigin.current = { startMs: propsRef.current.startMs, endMs: propsRef.current.endMs };
      feedback.begin(propsRef.current.startMs, propsRef.current.endMs,
        propsRef.current.getFeedbackBoundaries?.() ?? [propsRef.current.playheadMs],
        2 * propsRef.current.durationMs / Math.max(1, propsRef.current.trackWidth));
      modeRef.current = wasArmed ? 'reorder' : movement ? 'gap' : 'none';
      longPressArmedRef.current = wasArmed;
      clearLongPress();
      if (wasArmed) propsRef.current.onReorderPreview(originIndexRef.current);
      else if (movement) {
        gapRef.current = clamp(initialGapRef.current + movement.dx * millisecondsPerPixel.current, 0, 60 * 60_000);
        previewGap(gapRef.current);
      }
      if (modeRef.current === 'none') longPressTimerRef.current = setTimeout(() => {
        if (!claimed.current) return;
        longPressArmedRef.current = true;
        modeRef.current = 'reorder';
        reorderIndexRef.current = originIndexRef.current;
        propsRef.current.onReorderPreview(originIndexRef.current);
      }, 350);
    };
    const move = (gesture: { dx: number; dy: number }) => {
      if (!claimed.current) return;
      if (modeRef.current === 'none') {
        if (!longPressArmedRef.current) {
          if (Math.abs(gesture.dx) <= 8 && Math.abs(gesture.dy) <= 8) return;
          clearLongPress();
          if (Math.abs(gesture.dx) <= Math.abs(gesture.dy)) return;
          modeRef.current = 'gap';
        } else modeRef.current = 'reorder';
      }
      if (modeRef.current === 'reorder') {
        if (propsRef.current.clipCount <= 1) return;
        const slotWidth = Math.max(24, (propsRef.current.tileSize ?? REORDER_TILE) + (propsRef.current.tileGap ?? REORDER_GAP));
        const toIndex = clamp(originIndexRef.current + Math.round(gesture.dx / slotWidth), 0, propsRef.current.clipCount - 1);
        if (toIndex !== reorderIndexRef.current) timelineHaptic('boundary');
        reorderIndexRef.current = toIndex;
        propsRef.current.onReorderPreview(toIndex);
        return;
      }
      const delta = gesture.dx * millisecondsPerPixel.current;
      gapRef.current = clamp(initialGapRef.current + delta, 0, 60 * 60_000);
      previewGap(gapRef.current);
    };
    const panResponder = PanResponder.create({
    onStartShouldSetPanResponderCapture: () => { intent.current = 'pending'; longPressArmedRef.current = false; return false; },
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: shouldClaim,
    onMoveShouldSetPanResponderCapture: shouldClaim,
    onPanResponderTerminationRequest: () => !claimed.current,
    onShouldBlockNativeResponder: () => claimed.current,
    onPanResponderGrant: (_event, movement) => begin(movement),
    onPanResponderMove: (_event, gesture) => move(gesture),
    onPanResponderRelease: (_event, movement) => { move(movement); finishGesture('release'); },
    onPanResponderTerminate: cancelGesture,
    });
    return { ...panResponder, nativeCallbacks: {
      prepare: () => { intent.current = 'pending'; longPressArmedRef.current = false; },
      holdMilliseconds: 350,
      begin: (dx: number, dy: number, reorder?: boolean) => begin({ dx, dy }, reorder),
      move: (dx: number, dy: number, touches: number) => { if (touches > 1) cancelGesture(); else move({ dx, dy }); },
      finish: () => finishGesture('release'), cancel: cancelGesture,
    } };
  });

  useEffect(() => () => {
    cancelGesture();
  }, [cancelGesture]);
  useEffect(() => gestureGeometry?.subscribe(cancelGesture), [gestureGeometry, cancelGesture]);

  const moveWidth = props.moveWidth ?? props.bodyWidth;
  const moveLeft = props.moveLeft ?? props.bodyLeft;
  return (
    <TimelineNativeGestureView
      panHandlers={responder.panHandlers}
      nativeCallbacks={responder.nativeCallbacks}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={`${props.label}. Tap to select. Hold then drag to reorder. Drag horizontally to add or remove empty space before this clip.`}
      style={{ position: 'absolute', left: moveLeft, width: moveWidth, top: 0, bottom: 0 }}>
      <Pressable accessible={false} onPress={props.onPress} onPressIn={() => { longPressArmedRef.current = false; }}
        onLongPress={() => { if (intent.current === 'pending') longPressArmedRef.current = true; }} delayLongPress={350} style={{ position: 'absolute', inset: 0 }} />
    </TimelineNativeGestureView>
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

function TimelineTrackHandle(props: { label: string; disabled: boolean; onStart: () => void; onMove: (dy: number, pageY?: number) => void; onFinish: (cancelled: boolean) => void; onAccessibleMove: (direction: -1 | 1) => void }) {
  const current = useRef(props);
  current.current = props;
  const active = useRef(false);
  const geometry = useContext(TimelineGestureGeometryContext);
  const finish = useCallback((cancelled: boolean) => {
    if (!active.current) return;
    active.current = false;
    current.current.onFinish(cancelled);
  }, []);
  const [responder] = useState(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_event, movement) => !current.current.disabled && timelineTouchIntent(movement.dx, movement.dy) === 'vertical',
    onPanResponderGrant: (_event, movement) => { active.current = true; current.current.onStart(); if (movement) current.current.onMove(movement.dy, movement.moveY); },
    onPanResponderMove: (event, movement) => { if (event.nativeEvent.touches.length > 1) finish(true); else if (active.current) current.current.onMove(movement.dy, movement.moveY); },
    onPanResponderTerminationRequest: () => !active.current,
    onPanResponderRelease: () => finish(false),
    onPanResponderTerminate: () => finish(true),
  }));
  useEffect(() => () => finish(true), [finish]);
  useEffect(() => geometry?.subscribe(() => finish(true)), [geometry, finish]);
  const [nativeCallbacks] = useState(() => ({
    axis: 'vertical' as const,
    begin: (_dx: number, dy: number, _reorder?: boolean, pageY?: number) => {
      if (current.current.disabled) return;
      active.current = true;
      current.current.onStart();
      current.current.onMove(dy, pageY);
    },
    move: (_dx: number, dy: number, touches: number, pageY?: number) => {
      if (touches !== 1) finish(true);
      else if (active.current) current.current.onMove(dy, pageY);
    },
    finish: () => finish(false),
    cancel: () => finish(true),
  }));
  return <TimelineNativeGestureView panHandlers={responder.panHandlers} nativeCallbacks={nativeCallbacks} nativeDisabled={props.disabled} hitSlop={10} accessible accessibilityRole="adjustable" accessibilityLabel={'Reorder ' + props.label + ' track'}
    accessibilityState={{ disabled: props.disabled }} accessibilityActions={[{ name: 'increment', label: 'Move track down' }, { name: 'decrement', label: 'Move track up' }]}
    onAccessibilityAction={(event) => { if (!props.disabled && (event.nativeEvent.actionName === 'increment' || event.nativeEvent.actionName === 'decrement')) props.onAccessibleMove(event.nativeEvent.actionName === 'increment' ? 1 : -1); }}
    style={{ width: 24, minHeight: 44, alignItems: 'center', justifyContent: 'center', opacity: props.disabled ? 0.4 : 1 }}>
    <View pointerEvents="none" style={{ width: 10, flexDirection: 'row', flexWrap: 'wrap', gap: 2 }}>
      {Array.from({ length: 8 }, (_, index) => <View key={index} style={{ width: 3, height: 3, borderRadius: 2, backgroundColor: '#9BA6B3' }} />)}
    </View>
  </TimelineNativeGestureView>;
}

function TimelineRow(props: { label: string; labelColor: string; selected?: boolean; controls?: React.ReactNode; children: React.ReactNode; onPressLabel?: () => void; onPressTrack?: (x: number) => void; trackWidth: number; height: number }) {
  return (
    <View style={{ width: LABEL_WIDTH + props.trackWidth, height: props.height, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#1D242C' }}>
      <View pointerEvents="none" style={{ width: LABEL_WIDTH, height: '100%' }} />
      <View style={{ width: props.trackWidth, height: props.height - 8, borderRadius: 7, backgroundColor: '#171D23', overflow: 'visible' }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Clear selection and seek timeline" onPress={(event) => props.onPressTrack?.(event.nativeEvent.locationX)} style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }} />
        <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}>
          {props.children}
        </View>
      </View>
    </View>
  );
}

function TimelineCoverageStrip(props: { left: number; width: number; startMs: number; endMs: number; trackWidth: number; color: string; onPress: () => void }) {
  const left = clamp(props.left, 0, props.trackWidth);
  const width = clamp(props.width, 0, props.trackWidth - left);
  if (width <= 0) return null;
  return <Pressable testID="timeline-cue-overview" accessibilityRole="button"
    accessibilityLabel="Cue coverage. Tap to choose a cue."
    onPress={props.onPress} style={{ position: 'absolute', left, width,
      top: 8, height: LANE_HEIGHT - 16, borderRadius: 4, backgroundColor: props.color, opacity: 0.55, zIndex: 0 }} />;
}

function TimedBlock(props: {
  getFeedbackBoundaries?: () => readonly number[];
  onTouchLock?: (locked: boolean) => void;
  label: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  trackWidth: number;
  playheadMs: number;
  lane: number;
  color: string;
  selected: boolean;
  thumbnailUri?: string;
  waveformPeaks?: number[];
  waveformVisibleStartMs?: number;
  waveformVisibleEndMs?: number;
  sourceStartMs?: number;
  sourceEndMs?: number;
  sourceDurationMs?: number;
  onPress: () => void;
  onChangeStart: () => void;
  onChange: FeedbackTimingOwner['onChange'];
  onEnd: () => void;
}) {
  const width = Math.max(0, (props.endMs - props.startMs) * (props.trackWidth / props.durationMs));
  const bodyLeft = props.startMs / props.durationMs * props.trackWidth;
  const handleLayout = timelineHandleHitLayout(props.selected, width);
  const interactionLeft = bodyLeft + handleLayout.envelope.left;
  const interactionWidth = handleLayout.envelope.width;
  const visualLeft = bodyLeft - interactionLeft;
  const verticalInset = handleLayout.showTrimGrips ? 3 : 0;
  const interactionHeight = LANE_HEIGHT + verticalInset * 2;
  const showThumbnail = Boolean(props.thumbnailUri && width >= 56);
  const labelInset = Math.min(8, Math.max(2, (width - 16) / 4));
  const labelLeft = showThumbnail ? Math.min(32, Math.max(2, width - labelInset - 16)) : labelInset;
  const labelRight = labelInset;
  const labelWidth = Math.max(0, width - labelLeft - labelRight);
  const showLabel = labelWidth >= 16;
  return (
    <View style={{ position: 'absolute', left: interactionLeft, width: interactionWidth, top: props.lane * LANE_HEIGHT - verticalInset, height: interactionHeight, zIndex: props.selected ? 6 : 1, justifyContent: 'center' }}>
      <View pointerEvents="none" style={{ position: 'absolute', left: visualLeft, width, top: verticalInset, bottom: verticalInset, overflow: 'hidden', borderRadius: 6, borderWidth: props.selected ? 2 : 1, borderColor: props.selected ? '#FFFFFF' : `${props.color.slice(0, 7)}CC`, backgroundColor: props.color.length === 9 ? props.color : `${props.color}B8` }}>
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
      </View>
      {showThumbnail ? <View pointerEvents="none" style={{ position: 'absolute', left: visualLeft + 3, top: 3 + verticalInset, width: 24, height: 24, borderRadius: 3, overflow: 'hidden', zIndex: 2, backgroundColor: '#172027' }}><Image source={{ uri: props.thumbnailUri }} contentFit="cover" style={{ width: '100%', height: '100%' }} /></View> : null}
      {showLabel ? <Text pointerEvents="none" numberOfLines={1} style={{ position: 'absolute', left: visualLeft + labelLeft, width: labelWidth, top: 1 + verticalInset, color: '#FFFFFF', fontSize: 7, fontWeight: '900', zIndex: 2, textShadowColor: '#00161A', textShadowRadius: 2 }}>{props.label}</Text> : null}
      <DirectTimelineGestureSurface {...props} width={interactionWidth} blockLeft={visualLeft} blockWidth={width} />
    </View>
  );
}

function LiveRecordingBlock(props: { startMs: number; endMs: number; meterLevel: number; durationMs: number; trackWidth: number }) {
  const startMs = clamp(props.startMs, 0, props.durationMs);
  const endMs = clamp(Math.max(startMs + 80, props.endMs), startMs + 80, props.durationMs);
  const left = startMs / props.durationMs * props.trackWidth;
  const width = Math.max(4, (endMs - startMs) / props.durationMs * props.trackWidth);
  const bars = Array.from({ length: Math.max(6, Math.min(40, Math.round(width / 5))) }, (_value, index) => clamp(props.meterLevel * (0.58 + ((index * 17) % 13) / 30), 0.04, 1));
  return <View pointerEvents="none" style={{ position: 'absolute', left, width, top: 3, bottom: 3, overflow: 'hidden', borderRadius: 6, borderWidth: 1, borderColor: '#FF6D83', backgroundColor: '#6B2636', flexDirection: 'row', alignItems: 'center', gap: 1, paddingHorizontal: 2 }}>
    {bars.map((level, index) => <View key={index} style={{ flex: 1, minWidth: 1, height: Math.max(2, level * (LANE_HEIGHT - 9)), borderRadius: 2, backgroundColor: '#FFD5DC' }} />)}
  </View>;
}

type TimelineTimingOwner = Parameters<typeof TimedBlock>[0];

function useTimelineTimingPanHandlers(
  owner: FeedbackTimingOwner,
  edge: TimelineTimingEdge,
  onTouchLock?: (locked: boolean) => void,
) {
  const gestureGeometry = useContext(TimelineGestureGeometryContext);
  const current = useRef({ owner, edge, onTouchLock });
  current.current = { owner, edge, onTouchLock };
  const [gesture] = useState(() => createTimelineTimingGesture());
  const [feedback] = useState(() => createTimelineBoundaryFeedback(() => timelineHaptic('boundary')));
  const explicitFeedback = useRef(false);
  const intent = useRef<TimelineTouchIntent>('pending');
  const claimed = useRef(false);
  const cancelGesture = useCallback(() => {
    gesture.cancel();
    feedback.reset();
    if (claimed.current) current.current.onTouchLock?.(false);
    claimed.current = false;
  }, [gesture, feedback]);
  useEffect(() => {
    // Live edits are reported only after their authoritative domain constraints
    // have been applied. Do not buzz at rejected or out-of-range pointer values.
    if (claimed.current && !explicitFeedback.current) feedback.update(owner.startMs, owner.endMs);
  }, [feedback, owner.startMs, owner.endMs]);
  const [responder] = useState(() => {
    const finish = () => {
      gesture.finish();
      feedback.reset();
      if (claimed.current) current.current.onTouchLock?.(false);
      claimed.current = false;
    };
    const shouldClaim = (event: { nativeEvent: { touches: readonly unknown[] } }, movement: { dx: number; dy: number }) => {
      if (event.nativeEvent.touches.length !== 1) return false;
      if (intent.current === 'pending') intent.current = timelineTouchIntent(movement.dx, movement.dy);
      return intent.current === 'horizontal';
    };
    const begin = (movement?: { dx: number; dy: number }) => {
      claimed.current = true;
      const active = current.current;
      explicitFeedback.current = false;
      feedback.begin(active.owner.startMs, active.owner.endMs,
        active.owner.getFeedbackBoundaries?.() ?? [active.owner.playheadMs ?? NaN],
        2 * active.owner.durationMs / Math.max(1, active.owner.trackWidth));
      gesture.begin({ ...active.owner, onChange: (nextEdge, startMs, endMs) => {
        const applied = current.current.owner.onChange(nextEdge, startMs, endMs);
        if (applied) {
          explicitFeedback.current = true;
          feedback.update(applied.startMs, applied.endMs);
        }
      } }, active.edge);
      active.onTouchLock?.(true);
      if (movement) gesture.move(movement.dx, movement.dy);
    };
    const move = (dx: number, dy: number, touches: number) => {
      if (touches > 1) { cancelGesture(); return; }
      if (Number.isFinite(dx) && Number.isFinite(dy)) gesture.move(dx, dy);
    };
    const panResponder = PanResponder.create({
      onStartShouldSetPanResponderCapture: () => { intent.current = 'pending'; return false; },
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: shouldClaim,
      onMoveShouldSetPanResponderCapture: shouldClaim,
      onPanResponderTerminationRequest: () => !claimed.current,
      onShouldBlockNativeResponder: () => claimed.current,
      onPanResponderGrant: (_event, movement) => begin(movement),
      onPanResponderMove: (event, movement) => move(movement.dx, movement.dy, event.nativeEvent.touches.length),
      onPanResponderRelease: (event, movement) => { move(movement.dx, movement.dy, event.nativeEvent.touches.length); finish(); },
      onPanResponderTerminate: cancelGesture,
    });
    return { ...panResponder, nativeCallbacks: {
      begin: (dx: number, dy: number) => begin({ dx, dy }), move,
      finish, cancel: cancelGesture,
    } };
  });
  useEffect(() => () => {
    cancelGesture();
  }, [cancelGesture]);
  useEffect(() => gestureGeometry?.subscribe(cancelGesture), [gestureGeometry, cancelGesture]);
  return { ...responder.panHandlers, nativeCallbacks: responder.nativeCallbacks };
}

function DirectTimelineGestureSurface(props: TimelineTimingOwner & { width: number; blockLeft: number; blockWidth: number }) {
  const layout = timelineHandleHitLayout(props.selected, props.blockWidth);
  const moveLeft = layout.showTrimGrips ? TIMELINE_EDGE_HANDLE_WIDTH : 0;
  const moveRight = moveLeft + layout.moveHit.width;
  const height = layout.showTrimGrips ? LANE_HEIGHT + 6 : LANE_HEIGHT;
  return <View testID="timeline-direct-surface" style={{ position: 'absolute', left: 0, top: 0, width: props.width, height, borderRadius: 6 }}>
    {layout.showTrimGrips ? <TimelineTimingGrip {...props} edge="start" left={0} width={moveLeft} height={height} /> : null}
    <TimelineTimingGrip {...props} edge="move" left={moveLeft} width={Math.max(0, moveRight - moveLeft)} height={height} />
    {layout.showTrimGrips ? <TimelineTimingGrip {...props} edge="end" left={moveRight} width={Math.max(0, props.width - moveRight)} height={height} /> : null}
    {layout.showTrimGrips ? <>
      <TimelineEdgeHandleMarker left={0} width={TIMELINE_EDGE_HANDLE_WIDTH} />
      <TimelineEdgeHandleMarker left={moveRight} width={TIMELINE_EDGE_HANDLE_WIDTH} />
    </> : null}
  </View>;
}

function TimelineEdgeHandleMarker(props: { left: number; width: number }) {
  return <View pointerEvents="none" style={{ position: 'absolute', left: props.left, top: 0, bottom: 0,
    width: props.width, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: TIMELINE_EDGE_HANDLE_COLOR }}>
    <View pointerEvents="none" style={{ width: 3, height: 18, borderRadius: 2, backgroundColor: TIMELINE_EDGE_HANDLE_BAR_COLOR }} />
  </View>;
}

function TimelineTimingGrip(props: TimelineTimingOwner & {
  edge: TimelineTimingEdge; left: number; width: number; height: number;
}) {
  const { nativeCallbacks, ...panHandlers } = useTimelineTimingPanHandlers(props, props.edge, props.onTouchLock);
  return <TimelineNativeGestureView panHandlers={panHandlers} nativeCallbacks={nativeCallbacks} accessible accessibilityRole="adjustable"
    accessibilityState={{ selected: props.selected }}
    accessibilityLabel={timelineTimingLabel(props.label, props.startMs, props.endMs, props.selected, props.edge)}
    accessibilityActions={TIMELINE_ACCESSIBILITY_ACTIONS}
    onAccessibilityAction={(event) => adjustTimelineTiming(props, props.edge, event.nativeEvent.actionName)}
    style={{ position: 'absolute', left: props.left, top: 0, width: props.width, height: props.height,
      alignItems: 'center', justifyContent: 'center', borderRadius: 6 }}>
    <Pressable accessible={false} onPress={props.onPress} style={{ position: 'absolute', inset: 0 }} />
  </TimelineNativeGestureView>;
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

function ZoomButton(props: { label: string; onPress: () => void }) { return <Pressable accessibilityRole="button" accessibilityLabel={props.label === '+' ? 'Zoom timeline in' : 'Zoom timeline out'} onPress={props.onPress} style={{ width: 42, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: '#2C2C2E' }}><Text style={{ color: '#64D2FF', fontSize: 20, fontWeight: '600' }}>{props.label}</Text></Pressable>; }
function formatRulerTime(ms: number, intervalMs: number) { const minutes = Math.floor(ms / 60_000); const seconds = (ms % 60_000) / 1000; return intervalMs < 1000 ? `${minutes}:${seconds.toFixed(intervalMs < 500 ? 2 : 1).padStart(4, '0')}` : `${minutes}:${Math.floor(seconds).toString().padStart(2, '0')}`; }
function formatGap(ms: number) { return `${(Math.max(0, ms) / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`; }
function touchDistance(first?: { pageX: number; pageY: number }, second?: { pageX: number; pageY: number }) { if (!first || !second) return 0; return Math.hypot(first.pageX - second.pageX, first.pageY - second.pageY); }
function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }
