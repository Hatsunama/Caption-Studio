import { projectTimelineDuration } from '@/lib/project-timeline';
import { editorLayerSelection, editorSelectionState, shouldOpenEditorTool, type EditorSelection, type EditorTool } from '@/lib/editor-selection';
import { visualLayerVisibleAtTime } from '@/lib/visual-layer-visibility';
import { usePreviewSceneGesture, type PreviewSceneTarget } from '@/hooks/use-preview-scene-gesture';
import { applyPreviewSceneGeometry } from '@/lib/preview-scene-project';
import { LayerTransformOverlay } from '@/components/editor/layer-transform-overlay';
import { captionPreviewState, projectHasEditorLayer } from '@/lib/caption-preview';
import { reconcileCaptionScriptDraft } from '@/lib/caption-script';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { AudioModule, RecordingPresets, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { AnimationBrowser } from '@/components/editor/animation-browser';
import { projectMediaRecoveryPrompts } from '@/components/editor/project-media-recovery-prompts';
import { PersistedHorizontalScroll, PersistedHorizontalScrollScope } from '@/components/editor/persisted-horizontal-scroll';
import { CaptionOverlay } from '@/components/editor/caption-overlay';
import { DualCaptionEditor } from '@/components/editor/dual-caption-editor';
import { DualLanguagePicker } from '@/components/editor/dual-language-picker';
import { FontBrowser } from '@/components/editor/font-browser';
import { ExtractAudioSourceSheet } from '@/components/editor/extract-audio-source-sheet';
import { WatermarkSheet } from '@/components/editor/watermark-sheet';
import { ImageLayerOverlay } from '@/components/editor/image-layer-overlay';
import { LayerTimeline } from '@/components/editor/layer-timeline';
import { MediaLoadingOverlay } from '@/components/media-loading-overlay';
import { PlaybackLoadingOverlay } from '@/components/editor/playback-loading-overlay';
import { ScopeSheet } from '@/components/editor/scope-sheet';
import { ScriptEditor } from '@/components/editor/script-editor';
import { VideoTools } from '@/components/editor/video-tools';
import { VideoTransformOverlay } from '@/components/editor/video-transform-overlay';
import { VideoTransitionOverlay } from '@/components/editor/video-transition-overlay';
import { useTimelineVideoController } from '@/hooks/use-timeline-video-controller';
import { useTimelineAudioController } from '@/hooks/use-timeline-audio-controller';
import { useProjectAudioWaveforms } from '@/hooks/use-project-audio-waveforms';
import { useProjectCaptionTranslation } from '@/hooks/use-project-caption-translation';
import { useForegroundOperation } from '@/hooks/use-foreground-operation';
import { useEditorRuntimePolicy } from '@/hooks/use-editor-runtime-policy';
import { useScriptEditorExit } from '@/hooks/use-script-editor-exit';
import { resolveEditorBackStep } from '@/lib/editor-back-navigation';
import { deleteAudioClip, duplicateAudioClip, moveAudioClip, splitAudioClip, updateAudioClip } from '@/lib/audio-timeline';
import { applyTimelineItemTiming, type TimelineItemReference, type TimelineTimingEdge } from '@/lib/timeline-item-editor';
import { findAnimationPreset } from '@/lib/animation-presets';
import { canAutomaticallyTranslatePair, captionLanguageLabel, type CaptionLanguageTag } from '@/lib/caption-languages';
import { exportTranslationSummary } from '@/lib/export-caption-pairs';
import {
  projectPrimaryCaptionLanguage,
  resolvedProjectCaptionLanguage,
  removeTranslationCaptionTrack,
  resolveCaptionPairs,
  setTranslationCueStyle,
  setTranslationCueSkipped,
  setTranslationStackGap,
  setTranslationTrackStyle,
  setTranslationTrackVisibility,
  DEFAULT_TRANSLATION_STACK_GAP,
  MAX_TRANSLATION_STACK_GAP,
  MIN_TRANSLATION_STACK_GAP,
} from '@/lib/caption-tracks';
import {
  collectLinkedMediaUris,
  collectProjectOwnedUris,
  createLinkedMediaPermissionLedger,
  createProjectOwnedAssetLedger,
  trackLinkedMediaPermissions,
  trackProjectOwnedAssets,
} from '@/lib/media-lifecycle';
import { fontChoicePatch, type FontChoice, type FontColors } from '@/lib/font-style-choice';
import { canApplyVideoTransition, VIDEO_TRANSITION_PRESETS } from '@/lib/video-transitions';
import {
  addImageLayer as addImageLayerToProject,
  createTextLayer,
  createWatermarkLayer,
  deleteCaptionBlock,
  deleteVideoClip,
  deleteVisualLayer,
  moveVisualLayer,
  MAX_PROJECT_WATERMARKS,
  setCanvasPreset as applyCanvasPreset,
  replaceVisibleCaptionScript,
  splitVisualLayer,
  setTextLayerStyle,
  setTextLayerText,
  setVideoClipGap,
  setVideoClipLeadingGap,
  setVideoClipTransform,
  setVideoTransition,
  moveVideoClip,
  reorderVideoClip,
  splitVideoClip,
  trimVideoClip,
  updateVideoClip,
} from '@/lib/project-editor';
import { applyStylePatch, resolveCaptionStyle, type StyleScope } from '@/lib/style-resolver';
import {
  buildClipTimeline,
  setClipPlaybackRate,
  timelineEntryAt,
  totalClipDuration,
  visibleTimelineCaptions,
} from '@/lib/video-timeline';
import { pickAndStoreImage, type MediaImportProgress } from '@/services/media-import';
import type { TextVisualLayer } from '@/types/project';
import {
  cancelProjectVideoExport,
  exportProjectVideo,
  exportSubtitleFile,
  getProjectVideoExportProgress,
  userFacingExportError,
  type ProjectVideoExportProgress,
} from '@/services/project-export';
import { validateProjectSources } from '@/services/project-media';
import {
  appendVideosToProject,
  appendAudioToProject,
  appendRecordedAudioToProject,
  appendProjectVideoAudioToProject,
  cancelProjectCaptionGeneration,
  checkpointEditorProject,
  discardEditorSession,
  generateAndSaveProjectCaptions,
  loadProjectForEditing,
  saveEditorDraft,
} from '@/services/project-workflows';
import { createEditorSession, type EditorProjectOperation } from '@/services/editor-session';
import { CaptionGenerationCancelledError } from '@/services/caption-generation-session';
import {
  NATURAL_TRANSLATION_MODEL_LABEL,
  type CaptionTranslationProgress,
} from '@/services/caption-translation';
import {
  changedPrimaryCaptionTextIds,
  prepareOptionalDualCaptionTrack,
  type DualCaptionTextEdit,
} from '@/services/project-caption-translation';
import {
  ProjectPersistenceError,
} from '@/services/project-persistence';
import { VideoExportCancelledError } from '@/services/video-export-session';
import { chrome } from '@/lib/ui-theme';
import {
  TRANSCRIPTION_MODEL_OPTIONS,
  type TranscriptionModelId,
  type TranscriptionProgress,
} from '@/services/transcription';
import {
  type CaptionAnimationId,
  type CaptionProject,
  type CaptionStylePatch,
  type CaptionBlock,
  type VideoClip,
  type VideoTransformPatch,
  type AudioClip,
} from '@/types/project';

function confirmOptionalTranslationExport(project: CaptionProject, video: boolean): Promise<boolean> {
  if (video && (!project.export.burnCaptions || !project.layers.some((layer) => layer.kind === 'captions' && layer.visible))) {
    return Promise.resolve(true);
  }
  const { missing, needsReview } = exportTranslationSummary(project);
  if (!missing && !needsReview) return Promise.resolve(true);
  return new Promise((resolve) => Alert.alert(
    'Export with unfinished translations?',
    `${missing} second-language lines are missing. ${needsReview} existing translations may need review.\n\nExport anyway keeps available text and omits empty second-language lines. Original captions and saved projects are unchanged. You can refresh or skip lines later.`,
    [
      { text: 'Back to editing', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Export anyway', onPress: () => resolve(true) },
    ],
    { cancelable: true, onDismiss: () => resolve(false) },
  ));
}

const palette = {
  background: chrome.background,
  surface: chrome.surface,
  surfaceRaised: chrome.surfaceRaised,
  text: chrome.text,
  muted: chrome.muted,
  accent: chrome.accent,
  purple: chrome.purple,
};

type PendingStyleChange = {
  label: string;
  patch: CaptionStylePatch;
  translationTrackId?: string;
};

export default function EditorScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const [initialProject, setInitialProject] = useState<CaptionProject>();
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    let active = true;
    void loadProjectForEditing(projectId, projectMediaRecoveryPrompts)
      .then((stored) => {
        if (!active) return;
        if (!stored) throw new Error('This project no longer exists on this device.');
        setInitialProject(stored);
      })
      .catch((caught) => {
        if (active) setLoadError(caught instanceof Error ? caught.message : 'The project could not be opened.');
      });
    return () => { active = false; };
  }, [projectId]);

  if (loadError) {
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, backgroundColor: palette.background }}><Text selectable style={{ color: '#FFBBC8', textAlign: 'center' }}>{loadError}</Text></View>;
  }
  if (!initialProject) {
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.background }}><ActivityIndicator color={palette.accent} /></View>;
  }
  return <EditorWorkspace key={initialProject.id} initialProject={initialProject} />;
}

function EditorWorkspace({ initialProject }: { initialProject: CaptionProject }) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const [workspaceHeight, setWorkspaceHeight] = useState(height);
  const [project, renderProject] = useState(initialProject);
  const [editorSession] = useState(() => createEditorSession(
    initialProject, renderProject, checkpointEditorProject,
  ));
  const setProject = editorSession.update;
  const [finishingSession, setFinishingSession] = useState(false);
  const ownedAssetLedgerRef = useRef(createProjectOwnedAssetLedger(initialProject));
  const linkedPermissionLedgerRef = useRef(createLinkedMediaPermissionLedger(initialProject));
  const [selectedCaptionId, setSelectedCaptionId] = useState<string>();
  const [selectedLayerId, setSelectedLayerId] = useState<string>();
  const [selectedClipId, setSelectedClipId] = useState<string>();
  const [selectedAudioClipId, setSelectedAudioClipId] = useState<string>();
  const [progress, setProgress] = useState<TranscriptionProgress>();
  const [transcriptionCancelling, setTranscriptionCancelling] = useState(false);
  const [mediaProgress, setMediaProgress] = useState<MediaImportProgress>();
  const [error, setError] = useState<string>();
  const [persistenceError, setPersistenceError] = useState<string>();
  const [fontBrowserOpen, setFontBrowserOpen] = useState(false);
  const [pendingChange, setPendingChange] = useState<PendingStyleChange>();
  const [editingText, setEditingText] = useState<string>();
  const [editingLayerId, setEditingLayerId] = useState<string>();
  const [scriptEditorOpen, setScriptEditorOpen] = useState(false);
  const [scriptDraftCaptions, setScriptDraftCaptions] = useState<CaptionBlock[] | null>(null);
  const [scriptKeyboardOpen, setScriptKeyboardOpen] = useState(false);
  const [scriptEditingCaptionId, setScriptEditingCaptionId] = useState<string>();
  const editorScrollRef = useRef<ScrollView>(null);
  const scriptBackRequestRef = useRef<(() => void) | undefined>(undefined);
  const dualCaptionBackRequestRef = useRef<(() => void) | undefined>(undefined);
  const textLayerBackRequestRef = useRef<(() => void) | undefined>(undefined);
  const languagePickerBackRequestRef = useRef<(() => void) | undefined>(undefined);
  const fontBrowserBackRequestRef = useRef<(() => void) | undefined>(undefined);
  const registerFontBrowserBackRequest = useCallback((request: (() => void) | undefined) => {
    fontBrowserBackRequestRef.current = request;
  }, []);
  const registerScriptBackRequest = useCallback((request: (() => void) | undefined) => {
    scriptBackRequestRef.current = request;
  }, []);
  const registerDualCaptionBackRequest = useCallback((request: (() => void) | undefined) => {
    dualCaptionBackRequestRef.current = request;
  }, []);
  const registerTextLayerBackRequest = useCallback((request: (() => void) | undefined) => {
    textLayerBackRequestRef.current = request;
  }, []);
  const registerLanguagePickerBackRequest = useCallback((request: (() => void) | undefined) => {
    languagePickerBackRequestRef.current = request;
  }, []);
  const scriptExit = useScriptEditorExit(scriptEditorOpen, editorScrollRef, () => {
    setScriptKeyboardOpen(false);
    setScriptEditingCaptionId(undefined);
    setScriptDraftCaptions(null);
    setScriptEditorOpen(false);
  });
  const [dualCaptionEditorOpen, setDualCaptionEditorOpen] = useState(false);
  const [dualLanguagePickerOpen, setDualLanguagePickerOpen] = useState(false);
  const [selectedTranslationTrackId, setSelectedTranslationTrackId] = useState<string>();
  const [activeTool, setActiveTool] = useState<EditorTool>('captions');
  const activeToolRef = useRef<EditorTool>('captions');
  const openEditorTool = (tool: EditorTool) => {
    if (!shouldOpenEditorTool(activeToolRef.current, tool)) return;
    activeToolRef.current = tool;
    setActiveTool(tool);
  };
  const [exporting, setExporting] = useState(false);
  const [exportKind, setExportKind] = useState<'video' | 'subtitle'>('video');
  const [exportProgress, setExportProgress] = useState<ProjectVideoExportProgress>();
  const [animationScope, setAnimationScope] = useState<StyleScope>('caption');
  const [extractAudioOpen, setExtractAudioOpen] = useState(false);
  const [watermarkOpen, setWatermarkOpen] = useState(false);
  const [extractAudioBusy, setExtractAudioBusy] = useState(false);
  const [voiceoverOpen, setVoiceoverOpen] = useState(false);
  const [voiceoverSaving, setVoiceoverSaving] = useState(false);
  const [voiceoverStartMs, setVoiceoverStartMs] = useState<number>();
  const voiceoverRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const voiceoverRecorderState = useAudioRecorderState(voiceoverRecorder, 100);
  const voiceoverBackRequestRef = useRef<(() => void) | undefined>(undefined);
  const [transitionTimingOpen, setTransitionTimingOpen] = useState(false);
  const clearEditorSelection = () => {
    setSelectedCaptionId(undefined);
    setSelectedLayerId(undefined);
    setSelectedClipId(undefined);
    setSelectedAudioClipId(undefined);
    setSelectedTranslationTrackId(undefined);
  };
  const undoStackRef = useRef<CaptionProject[]>([]);
  const redoStackRef = useRef<CaptionProject[]>([]);
  const interactionStartRef = useRef<CaptionProject | undefined>(undefined);
  const [historyAvailability, setHistoryAvailability] = useState({ undo: false, redo: false });
  const workspaceMountedRef = useRef(true);
  const [exitApproved, setExitApproved] = useState(false);
  const exitPromptOpenRef = useRef(false);
  const pendingExitActionRef = useRef<Parameters<typeof navigation.dispatch>[0] | undefined>(undefined);
  // The script editor is a full preview transport surface, including while its
  // keyboard is open. Admit companion audio and transition media with video.
  const blockingUi = Boolean(
    fontBrowserOpen
    || pendingChange
    || editingLayerId
    || dualCaptionEditorOpen
    || dualLanguagePickerOpen
    || transitionTimingOpen
    || progress
    || mediaProgress
    || exporting
    || extractAudioOpen
    || watermarkOpen
    || extractAudioBusy
    || finishingSession,
  );
  const runtimePolicy = useEditorRuntimePolicy(blockingUi);

  useEffect(() => {
    if (!exporting || exportKind !== 'video') return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await getProjectVideoExportProgress();
        if (active) {
          setExportProgress((current) => {
            if (next.stage !== 'idle') return next;
            if (current?.stage === 'rendering' || current?.stage === 'publishing') {
              return { stage: 'publishing', percent: 99 };
            }
            return current ?? next;
          });
        }
      } catch {
        if (active) setExportProgress({ stage: 'rendering', percent: null });
      } finally {
        if (active) timer = setTimeout(poll, 500);
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [exportKind, exporting]);

  const trackSessionMedia = (next: CaptionProject) => {
    ownedAssetLedgerRef.current = trackProjectOwnedAssets(
      ownedAssetLedgerRef.current,
      collectProjectOwnedUris(next),
    );
    linkedPermissionLedgerRef.current = trackLinkedMediaPermissions(
      linkedPermissionLedgerRef.current,
      collectLinkedMediaUris(next),
    );
  };

  const persistProjectInBackground = () => {
    void editorSession.checkpoint().then(() => {
      if (workspaceMountedRef.current) setPersistenceError(undefined);
    }).catch((caught) => {
      if (workspaceMountedRef.current) setPersistenceError(caught instanceof Error ? caught.message : 'The project could not be saved.');
    });
  };

  const commitEditorProject = async (operation: EditorProjectOperation, alreadyPersists = false) => {
    try {
      const receipt = await editorSession.commit(async (before) => {
        const next = await operation(before);
        if (next) trackSessionMedia(next);
        return next;
      }, alreadyPersists);
      if (workspaceMountedRef.current) setPersistenceError(undefined);
      return receipt;
    } catch (caught) {
      if (workspaceMountedRef.current) {
        if (caught instanceof ProjectPersistenceError) {
          setPersistenceError(caught.message);
        } else {
          setError(caught instanceof Error ? caught.message : 'The project view could not be updated after saving.');
        }
      }
      throw caught;
    }
  };

  const transport = useTimelineVideoController(project, setError, runtimePolicy.videoSurfacesAdmitted);
  const { currentMs, isPlaying } = transport;
  useTimelineAudioController(project, currentMs, isPlaying, runtimePolicy.mediaAdmitted, setError);
  useProjectAudioWaveforms(
    project,
    runtimePolicy.mediaAdmitted && !isPlaying && !scriptEditorOpen,
    ({ sourceId, sourceUri, waveformPeaks, waveformVersion }) => {
      if (!editorSession.editable()) return;
      const current = editorSession.current();
      const source = current.audioSources.find((candidate) => candidate.id === sourceId && candidate.uri === sourceUri);
      if (!source || (source.waveformVersion === waveformVersion && source.waveformPeaks?.length === waveformPeaks.length)) {
        return;
      }
      const next = {
        ...current,
        audioSources: current.audioSources.map((candidate) => (
          candidate.id === sourceId && candidate.uri === sourceUri
            ? { ...candidate, waveformPeaks, waveformVersion }
            : candidate
        )),
      };
      setProject(next);
      persistProjectInBackground();
    },
    setError,
  );
  const pauseTransport = transport.pause;
  const cancelCaptionGeneration = useCallback(async () => {
    setTranscriptionCancelling(true);
    const cancelled = await cancelProjectCaptionGeneration();
    if (!cancelled) setTranscriptionCancelling(false);
  }, []);

  useEffect(() => {
    if (!runtimePolicy.mediaAdmitted) pauseTransport();
  }, [isPlaying, pauseTransport, runtimePolicy.mediaAdmitted]);

  useEffect(() => navigation.addListener('beforeRemove', (event) => {
    if (exitApproved) return;
    event.preventDefault();
    const { data } = event;
    const backStep = resolveEditorBackStep({
      interactionLocked: Boolean(finishingSession || transcriptionCancelling || mediaProgress || extractAudioBusy || voiceoverSaving || (exporting && exportKind !== 'video')),
      captionGenerationActive: Boolean(progress && !transcriptionCancelling),
      videoExportActive: Boolean(exporting && exportKind === 'video'),
      textEditorOpen: Boolean(editingLayerId),
      fontBrowserOpen,
      styleScopeOpen: Boolean(pendingChange),
      transitionTimingOpen,
      voiceoverOpen,
      audioSourceOpen: extractAudioOpen,
      watermarkOpen,
      languagePickerOpen: dualLanguagePickerOpen,
      dualCaptionEditorOpen,
      scriptEditorOpen,
      selectionActive: Boolean(
        selectedCaptionId || selectedLayerId || selectedClipId || selectedAudioClipId || selectedTranslationTrackId
      ),
      timelineRooted: scriptExit.timelineRooted(),
    });
    if (backStep !== 'confirm-exit') {
      pauseTransport();
      if (backStep === 'cancel-caption-generation') void cancelCaptionGeneration();
      else if (backStep === 'cancel-video-export') void cancelProjectVideoExport();
      else if (backStep === 'close-text-editor') (textLayerBackRequestRef.current ?? (() => {
        setEditingLayerId(undefined);
        setEditingText(undefined);
      }))();
      else if (backStep === 'close-font-browser') (fontBrowserBackRequestRef.current ?? (() => setFontBrowserOpen(false)))();
      else if (backStep === 'close-style-scope') setPendingChange(undefined);
      else if (backStep === 'close-transition-timing') setTransitionTimingOpen(false);
      else if (backStep === 'close-voiceover') (voiceoverBackRequestRef.current ?? (() => setVoiceoverOpen(false)))();
      else if (backStep === 'close-audio-source') setExtractAudioOpen(false);
      else if (backStep === 'close-language-picker') (languagePickerBackRequestRef.current ?? (() => setDualLanguagePickerOpen(false)))();
      else if (backStep === 'close-dual-caption-editor') {
        (dualCaptionBackRequestRef.current ?? (() => setDualCaptionEditorOpen(false)))();
      }
      else if (backStep === 'close-script-editor') (scriptBackRequestRef.current ?? scriptExit.close)();
      else if (backStep === 'clear-selection') clearEditorSelection();
      else if (backStep === 'reveal-timeline') scriptExit.revealTimeline();
      return;
    }
    if (exitPromptOpenRef.current) return;
    exitPromptOpenRef.current = true;
    pendingExitActionRef.current = data.action;
    pauseTransport();
    const finishExit = async (decision: 'save' | 'discard') => {
      try {
        setFinishingSession(true);
        await editorSession.finish(async (latest) => {
          const ledger = { owned: ownedAssetLedgerRef.current, linked: linkedPermissionLedgerRef.current };
          if (decision === 'save') return saveEditorDraft(latest, ledger);
          await discardEditorSession(initialProject, latest, ledger);
          return null;
        });
        if (!workspaceMountedRef.current) return;
        setExitApproved(true);
      } catch (caught) {
        exitPromptOpenRef.current = false;
        if (workspaceMountedRef.current) setFinishingSession(false);
        Alert.alert('Could not leave the editor', caught instanceof Error ? caught.message : 'Your choice could not be completed.');
      }
    };
    Alert.alert(
      'Save this draft?',
      'Save keeps this editing session in Projects. Discard returns without keeping this session’s changes.',
      [
        { text: 'Keep editing', style: 'cancel', onPress: () => { exitPromptOpenRef.current = false; } },
        { text: 'Discard', style: 'destructive', onPress: () => { void finishExit('discard'); } },
        { text: 'Save draft', onPress: () => { void finishExit('save'); } },
      ],
    );
  }), [
    cancelCaptionGeneration,
    dualCaptionEditorOpen,
    dualLanguagePickerOpen,
    editingLayerId,
    editorSession,
    exitApproved,
    exportKind,
    exporting,
    extractAudioBusy,
    extractAudioOpen,
    finishingSession,
    fontBrowserOpen,
    initialProject,
    mediaProgress,
    navigation,
    pauseTransport,
    pendingChange,
    progress,
    scriptEditorOpen,
    scriptExit,
    selectedAudioClipId,
    selectedCaptionId,
    selectedClipId,
    selectedLayerId,
    selectedTranslationTrackId,
    transcriptionCancelling,
    transitionTimingOpen,
    voiceoverOpen,
    voiceoverSaving,
  ]);

  useEffect(() => {
    if (!exitApproved) return;
    const action = pendingExitActionRef.current;
    if (action) navigation.dispatch(action);
  }, [exitApproved, navigation]);

  const clipTimeline = useMemo(() => buildClipTimeline(project.clips), [project.clips]);
  const timelineDurationMs = projectTimelineDuration(project);
  const seekTimeline = transport.seek;

  useEffect(() => {
    let active = true;
    void validateProjectSources(initialProject.sources).catch((caught) => {
      if (!active) return;
      setError(
        caught instanceof Error
          ? `The source video is unavailable: ${caught.message}`
          : 'The source video is unavailable. Reconnect or reselect the original file.',
      );
    });
    return () => { active = false; };
  }, [initialProject.sources]);

  const timelineCaptions = useMemo(() => visibleTimelineCaptions(project.captions), [project.captions]);
  const primaryCaptionLanguage = useMemo(() => resolvedProjectCaptionLanguage(project), [project]);
  const timelineLayers = useMemo(
    () => project.layers.filter((layer) => layer.kind === 'captions' || layer.timelineVisible !== false),
    [project.layers],
  );
  const translationTimelineTracks = useMemo(
    () => (project.captionTracks?.translations ?? []).map((track) => ({
      id: track.id,
      name: track.displayName,
      visible: track.visible,
      pairs: resolveCaptionPairs(project, track.id).filter((pair) => pair.timelineVisible),
    })),
    [project],
  );
  const selectedTranslationTrack = project.captionTracks?.translations.find((track) => track.id === selectedTranslationTrackId)
    ?? project.captionTracks?.translations.find((track) => track.visible)
    ?? project.captionTracks?.translations[0];
  const selectedTranslationPairs = useMemo(
    () => selectedTranslationTrack ? resolveCaptionPairs(project, selectedTranslationTrack.id).filter((pair) => pair.timelineVisible) : [],
    [project, selectedTranslationTrack],
  );
  const previewCaptions = useMemo(() => scriptEditorOpen
    ? reconcileCaptionScriptDraft(project, scriptDraftCaptions ?? timelineCaptions) : timelineCaptions,
  [project, scriptEditorOpen, scriptDraftCaptions, timelineCaptions]);
  const { active: activeCaption, activeCaptions, selected: selectedCaption } = useMemo(
    () => captionPreviewState(previewCaptions, currentMs, selectedCaptionId),
    [currentMs, previewCaptions, selectedCaptionId],
  );
  const selectedClip = project.clips.find((clip) => clip.id === selectedClipId);
  const selectedClipIndex = project.clips.findIndex((clip) => clip.id === selectedClipId);
  const transitionBoundaryAvailable = canApplyVideoTransition(project.clips, selectedClipIndex);
  const selectedAudioClip = project.audioClips.find((clip) => clip.id === selectedAudioClipId);
  const voiceoverMeterLevel = recordingMeterLevel(voiceoverRecorderState.metering);
  const selectedLayer = project.layers.find((layer) => layer.id === selectedLayerId);
  const selectedTextLayer = selectedLayer?.kind === 'text' ? selectedLayer : undefined;
  const selectedImageLayer = selectedLayer?.kind === 'image' ? selectedLayer : undefined;
  const translationTrackSelected = selectedTranslationTrack?.id === selectedLayerId;
  const selectedTranslationPair = translationTrackSelected
    ? selectedTranslationPairs.find((pair) => pair.source.id === selectedCaptionId)
    : undefined;
  const selectedAnimationId = activeTool === 'stickers' && selectedTextLayer
    ? selectedTextLayer.style.animation.id
    : selectedTranslationPair
      ? selectedTranslationPair.style.animation.id
    : selectedCaption
      ? resolveCaptionStyle(project.projectStyle, selectedCaption).animation.id
      : project.projectStyle.animation.id;
  const selectedLineHeight = activeTool === 'stickers' && selectedTextLayer
    ? selectedTextLayer.style.lineHeight
    : selectedTranslationPair
      ? selectedTranslationPair.style.lineHeight
      : selectedCaption
        ? resolveCaptionStyle(project.projectStyle, selectedCaption).lineHeight
        : project.projectStyle.lineHeight;
  const scriptEditingCaption = scriptEditorOpen && scriptKeyboardOpen
    ? previewCaptions.find((caption) => caption.id === scriptEditingCaptionId)
    : undefined;
  const displayCaption = scriptEditorOpen
    ? scriptEditingCaption ?? (!isPlaying ? selectedCaption ?? activeCaption : activeCaption)
    : activeCaption;
  const displayTranslationPairs = useMemo(
    () => translationTimelineTracks.flatMap((track) => track.visible
      ? track.pairs.filter((pair) => pair.translation.text.trim()
        && currentMs >= pair.startMs && currentMs < pair.endMs)
      : []),
    [currentMs, translationTimelineTracks],
  );
  // Script editing shares the actual resized root with the keyboard. The
  // normal preview minimum would consume nearly all of a short Android window.
  const previewHeight = scriptEditorOpen
    ? scriptKeyboardOpen
      // Reserve the 44px header and at least 100px of list (two 23px
      // caption lines plus row insets), even in a short resized window.
      ? Math.max(0, Math.min(180, workspaceHeight * 0.4, workspaceHeight - 145))
      : Math.min(500, workspaceHeight * 0.4)
    : Math.min(Math.max(280, height * 0.43), 500);
  const scriptCropActive = scriptEditorOpen && scriptKeyboardOpen;
  const cropCaptionStyle = displayCaption ? resolveCaptionStyle(project.projectStyle, displayCaption) : undefined;
  const [lastCropPosition, setLastCropPosition] = useState(project.projectStyle.position);
  // Hold the camera through timing gaps; draft selection and authored position
  // changes retarget it without changing the original canvas or its overlays.
  if (cropCaptionStyle && (cropCaptionStyle.position.x !== lastCropPosition.x
    || cropCaptionStyle.position.y !== lastCropPosition.y)) {
    setLastCropPosition(cropCaptionStyle.position);
  }
  const scriptCrop = captionPreviewCrop(
    project.canvas.aspectWidth / project.canvas.aspectHeight,
    width - 80, // 24px outer inset plus a separate 48px transport and 8px gap.
    previewHeight - 8,
    cropCaptionStyle?.position ?? lastCropPosition,
  );
  const [cropOffset] = useState(() => new Animated.ValueXY({ x: 0, y: 0 }));
  useEffect(() => {
    if (!scriptCropActive) {
      cropOffset.setValue({ x: 0, y: 0 });
      return;
    }
    const animation = Animated.timing(cropOffset, {
      toValue: { x: scriptCrop.x, y: scriptCrop.y },
      duration: 180,
      useNativeDriver: true,
      isInteraction: false,
    });
    animation.start();
    return () => animation.stop();
  }, [cropOffset, scriptCropActive, scriptCrop.x, scriptCrop.y]);
  const canvasSize = scriptCropActive ? scriptCrop.canvas : fitRect(
    project.canvas.aspectWidth / project.canvas.aspectHeight,
    width - 24,
    previewHeight - 8,
  );
  const canvasWidth = canvasSize.width;
  const canvasHeight = canvasSize.height;
  const currentClipEntry = timelineEntryAt(clipTimeline, currentMs);
  const currentVideoTransform = currentClipEntry?.clip.transform ?? project.videoTransform;
  const editableVideoClip = currentClipEntry?.clip ?? selectedClip;
  const editableVideoTransform = editableVideoClip?.transform ?? project.videoTransform;
  useEffect(() => {
    workspaceMountedRef.current = true;
    editorSession.activate();
    return () => {
      workspaceMountedRef.current = false;
      editorSession.dispose();
      void cancelProjectCaptionGeneration();
      void cancelProjectVideoExport();
    };
  }, [editorSession]);

  const selectEditorObject = (selection: EditorSelection) => {
    const next = editorSelectionState(selection);
    transport.pause();
    setSelectedCaptionId(next.captionId);
    setSelectedLayerId(next.layerId);
    setSelectedClipId(next.clipId);
    setSelectedAudioClipId(next.audioClipId);
    setSelectedTranslationTrackId(next.translationTrackId);
    openEditorTool(next.tool);
  };

  const selectEditorLayer = (layerId: string) => {
    const selection = editorLayerSelection(editorSession.current(), layerId, selectedCaptionId);
    if (selection) selectEditorObject(selection);
  };

  const refreshHistoryAvailability = () => {
    setHistoryAvailability({
      undo: undoStackRef.current.length > 0,
      redo: redoStackRef.current.length > 0,
    });
  };

  const pushUndo = (snapshot = editorSession.current()) => {
    const stack = undoStackRef.current;
    if (stack.at(-1) !== snapshot) stack.push(snapshot);
    trimHistoryStack(stack);
    redoStackRef.current = [];
    refreshHistoryAvailability();
  };

  useEffect(() => { editorSession.setHistoryRecorder(pushUndo); });

  const translationController = useProjectCaptionTranslation({
    getCurrentProject: () => editorSession.current(),
    commitProject: async (baseline, next) => {
      await commitEditorProject((current) => {
        if (current !== baseline) {
          throw new Error('The project changed while both languages were synchronizing. Save again to avoid overwriting newer edits.');
        }
        return next;
      });
    },
  });
  const translationProgress = translationController.progress;
  const translationCancelling = translationController.cancelling;

  const beginHistoryInteraction = () => {
    interactionStartRef.current ??= editorSession.current();
  };

  const finishHistoryInteraction = () => {
    const snapshot = interactionStartRef.current;
    interactionStartRef.current = undefined;
    if (snapshot && snapshot !== editorSession.current()) pushUndo(snapshot);
    persistProjectInBackground();
  };

  const undo = () => {
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    redoStackRef.current.push(editorSession.current());
    trimHistoryStack(redoStackRef.current);
    refreshHistoryAvailability();
    interactionStartRef.current = undefined;
    transport.synchronizeProject(previous);
    setProject(previous);
    setSelectedCaptionId((id) => previous.captions.some((caption) => caption.id === id) ? id : undefined);
    setSelectedLayerId((id) => projectHasEditorLayer(previous, id) ? id : undefined);
    setSelectedTranslationTrackId((id) => previous.captionTracks.translations.some((track) => track.id === id) ? id : undefined);
    persistProjectInBackground();
  };

  const redo = () => {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push(editorSession.current());
    trimHistoryStack(undoStackRef.current);
    refreshHistoryAvailability();
    interactionStartRef.current = undefined;
    transport.synchronizeProject(next);
    setProject(next);
    setSelectedCaptionId((id) => next.captions.some((caption) => caption.id === id) ? id : undefined);
    setSelectedLayerId((id) => projectHasEditorLayer(next, id) ? id : undefined);
    setSelectedTranslationTrackId((id) => next.captionTracks.translations.some((track) => track.id === id) ? id : undefined);
    persistProjectInBackground();
  };

  const generateCaptions = async (modelId: TranscriptionModelId) => {
    setError(undefined);
    setTranscriptionCancelling(false);
    try {
      const receipt = await commitEditorProject((before) => generateAndSaveProjectCaptions(
        before, modelId,
        (nextProgress) => { if (workspaceMountedRef.current) setProgress(nextProgress); },
      ), true);
      if (!receipt || !editorSession.isCurrent(receipt)) return;
      const { before, project: next } = receipt;
      selectEditorObject({ kind: 'captions', captionId: next.captions[0]?.id });
      if (before.captionTracks.translations.length > 0 && next.captionTracks.translations.length === 0) {
        Alert.alert(
          'Second language reset',
          'The detected source language changed, or the clips no longer share one caption language. Caption Studio removed the incompatible second-language track so it cannot show or export incorrect translations. Undo restores the previous caption script and track.',
        );
      } else {
        const visibleTranslation = next.captionTracks.translations.find((track) => track.visible);
        const refreshIds = visibleTranslation?.cues
          .filter((cue) => cue.status === 'pending' || cue.status === 'stale' || cue.status === 'failed')
          .map((cue) => cue.sourceCaptionId) ?? [];
        if (visibleTranslation && refreshIds.length > 0) requestTranslationRefresh(refreshIds, visibleTranslation);
      }
    } catch (caught) {
      if (workspaceMountedRef.current && !(caught instanceof CaptionGenerationCancelledError)) {
        const message = caught instanceof Error ? caught.message : 'Caption generation failed. Try again.';
        setError(message);
        Alert.alert('Caption generation failed', message);
      }
    } finally {
      if (workspaceMountedRef.current) {
        setTranscriptionCancelling(false);
        setProgress(undefined);
      }
    }
  };

  const captionForeground = useForegroundOperation({
    stage: progress?.stage,
    interrupt: cancelCaptionGeneration,
  });
  const captionInterruption = captionForeground.interruption;
  const captionInterruptionMessage = !captionInterruption
    ? undefined
    : captionInterruption.stage === 'downloading-model' && !captionInterruption.interruptionError
      ? 'The caption-model download paused because Caption Studio left the foreground. Downloaded model bytes were saved. Keep this screen open and the phone unlocked, then choose the same quality to resume.'
      : captionInterruption.interruptionError
        ? `Caption generation stopped when Caption Studio left the foreground, but Android could not preserve the active transfer: ${captionInterruption.interruptionError}`
        : 'Caption generation stopped because Caption Studio left the foreground. The project and previously saved captions were left unchanged. Keep this screen open and the phone unlocked, then try again.';

  useEffect(() => {
    if (!captionInterruptionMessage) return;
    Alert.alert('Caption generation paused', captionInterruptionMessage, [
      { text: 'OK', onPress: captionForeground.clearInterruption },
    ]);
  }, [captionForeground.clearInterruption, captionInterruptionMessage]);

  const chooseCaptionQuality = (replacingExisting: boolean) => {
    const modelDescription = TRANSCRIPTION_MODEL_OPTIONS
      .map((model) => `${model.label} · ${formatMegabytes(model.downloadBytes)} download\n${model.description}`)
      .join('\n\n');
    Alert.alert(
      replacingExisting ? 'Replace captions with which quality?' : 'Choose caption quality',
      `${replacingExisting ? 'This replaces the current caption text and timing. Styles and extra layers stay unchanged.\n\n' : ''}${modelDescription}\n\nKeep Caption Studio open and the phone unlocked until caption generation finishes. If Android interrupts a model download, downloaded bytes are saved and choosing the same quality resumes it.`,
      TRANSCRIPTION_MODEL_OPTIONS.map((model) => ({
        text: model.id === 'balanced' ? `${model.label} (recommended)` : model.label,
        onPress: () => { void generateCaptions(model.id); },
      })),
      { cancelable: true },
    );
  };

  const chooseStyleScope = async (scope: StyleScope) => {
    const change = pendingChange;
    if (!change) return;
    try {
      const receipt = await commitEditorProject((before) => change.translationTrackId
        ? scope === 'caption' && selectedCaptionId
          ? setTranslationCueStyle(before, change.translationTrackId, selectedCaptionId, change.patch, new Date().toISOString())
          : setTranslationTrackStyle(before, change.translationTrackId, change.patch, new Date().toISOString())
        : applyStylePatch(before, selectedCaptionId, scope, change.patch));
      if (editorSession.isCurrent(receipt)) setPendingChange(undefined);
    } catch (caught) {
      Alert.alert('Style change not saved', caught instanceof Error ? caught.message : 'The style change could not be saved. Try again.');
    }
  };

  const chooseFont = (choice: FontChoice, colors?: FontColors) => {
    setFontBrowserOpen(false);
    if (activeTool === 'stickers' && selectedTextLayer) {
      updateTextLayerStyle(selectedTextLayer.id, fontChoicePatch(choice, colors), true);
      return;
    }
    queueCaptionStyleChange(`Font: ${choice.name}`, fontChoicePatch(choice, colors));
  };

  const queueCaptionStyleChange = (label: string, patch: CaptionStylePatch) => {
    if (translationTrackSelected && selectedTranslationTrack) {
      const trackId = selectedTranslationTrack.id;
      void commitEditorProject((before) => setTranslationTrackStyle(before, trackId, patch, new Date().toISOString()))
        .catch((caught) => {
          if (workspaceMountedRef.current) setError(caught instanceof Error ? caught.message : 'The second-language style could not be saved.');
        });
      return;
    }
    setPendingChange({ label, patch });
  };

  const chooseAnimation = (id: CaptionAnimationId) => {
    const preset = findAnimationPreset(id);
    if (activeTool === 'stickers' && selectedTextLayer) {
      updateTextLayerStyle(selectedTextLayer.id, {
        animation: { id, intensity: preset.intensity, durationMs: preset.durationMs },
      }, true);
      return;
    }
    if (!selectedCaptionId && animationScope !== 'all') {
      Alert.alert(
        'Choose Text From The Timeline First',
        'Tap a caption or text layer in the timeline, or switch scope to All captions.',
      );
      return;
    }
    const scope = animationScope === 'caption' && selectedCaptionId ? 'caption' : 'all';
    if (translationTrackSelected && !TRANSLATION_PHRASE_ANIMATIONS.has(id)) {
      Alert.alert(
        'Choose a phrase animation',
        'Translated words do not have reliable word-by-word timing. Phrase animations stay synchronized to the primary subtitle without inventing word timing.',
      );
      return;
    }
    pushUndo();
    setProject((current) => {
      const patch = { animation: { id, intensity: preset.intensity, durationMs: preset.durationMs } };
      const next = translationTrackSelected && selectedTranslationTrack
        ? scope === 'caption' && selectedCaptionId
          ? setTranslationCueStyle(current, selectedTranslationTrack.id, selectedCaptionId, patch, new Date().toISOString())
          : setTranslationTrackStyle(current, selectedTranslationTrack.id, patch, new Date().toISOString())
        : applyStylePatch(current, selectedCaptionId, scope, patch);
      persistProjectInBackground();
      return next;
    });
  };

  const beginLineHeightChange = () => {
    if (activeTool !== 'stickers' && animationScope === 'caption' && !selectedCaptionId) return;
    pushUndo();
  };

  const changeLineHeight = (lineHeight: number) => {
    const scope = animationScope === 'caption' && selectedCaptionId ? 'caption' : 'all';
    setProject((current) => {
      const patch = { lineHeight };
      if (activeTool === 'stickers' && selectedTextLayer) return setTextLayerStyle(current, selectedTextLayer.id, patch);
      if (translationTrackSelected && selectedTranslationTrack) {
        return scope === 'caption' && selectedCaptionId
          ? setTranslationCueStyle(current, selectedTranslationTrack.id, selectedCaptionId, patch, new Date().toISOString())
          : setTranslationTrackStyle(current, selectedTranslationTrack.id, patch, new Date().toISOString());
      }
      return applyStylePatch(current, selectedCaptionId, scope, patch);
    });
  };

  const finishLineHeightChange = () => {
    persistProjectInBackground();
  };

  const beginEditCaption = () => {
    if (timelineCaptions.length === 0) return;
    transport.pause();
    setScriptDraftCaptions(null);
    setScriptKeyboardOpen(false);
    setScriptEditorOpen(true);
  };

  const commitTextLayerText = async () => {
    if (editingText == null || !editingLayerId) return;
    try {
      const receipt = await commitEditorProject((before) => setTextLayerText(before, editingLayerId, editingText));
      if (!editorSession.isCurrent(receipt)) return;
      setEditingLayerId(undefined);
      setEditingText(undefined);
    } catch {
      return;
    }
  };

  const commitCaptionScript = async (captions: CaptionProject['captions']) => {
    const receipt = await commitEditorProject((before) => replaceVisibleCaptionScript(before, captions));
    if (!receipt || !editorSession.isCurrent(receipt)) return false;
    const { before, project: next } = receipt;
    if (!next.captions.some((caption) => caption.id === selectedCaptionId && caption.timelineVisible !== false)) {
      setSelectedCaptionId(captions[0]?.id);
    }
    const changedCaptionIds = changedPrimaryCaptionTextIds(before, next);
    const visibleTranslation = next.captionTracks.translations.find((track) => track.visible);
    if (visibleTranslation && changedCaptionIds.length > 0) offerTranslationRefresh(changedCaptionIds, visibleTranslation);
    return true;
  };

  const openDualCaptionEditor = () => {
    if (timelineCaptions.length === 0) {
      Alert.alert('Generate captions first', 'Dual subtitles need a primary caption script to translate.');
      return;
    }
    try {
      projectPrimaryCaptionLanguage(editorSession.current());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'This caption language is not ready for dual subtitles.');
      return;
    }
    const existing = editorSession.current().captionTracks.translations.find((track) => track.visible)
      ?? editorSession.current().captionTracks.translations[0];
    if (existing) {
      transport.pause();
      setSelectedTranslationTrackId(existing.id);
      setDualCaptionEditorOpen(true);
      // Opening an editor is not permission to replace text or restart inference.
      return;
    }
    Alert.alert(
      'Finish spoken subtitles first',
      'Every language in the picker can be generated privately on this phone. Add missed words and fix splits in the spoken language first. Changing those captions later marks translations for an explicit refresh.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Edit captions first', onPress: beginEditCaption },
        { text: 'Choose language', onPress: () => setDualLanguagePickerOpen(true) },
      ],
    );
  };

  const enableDualCaptions = async (targetLanguage: CaptionLanguageTag) => {
    let prepared: ReturnType<typeof prepareOptionalDualCaptionTrack> | undefined;
    try {
      const receipt = await commitEditorProject((before) => {
        prepared = prepareOptionalDualCaptionTrack(before, targetLanguage);
        return prepared.project;
      });
      if (!prepared || !receipt || !editorSession.isCurrent(receipt)) return;
      setSelectedTranslationTrackId(prepared.trackId);
      transport.pause();
      setDualLanguagePickerOpen(false);
      setDualCaptionEditorOpen(true);
      if (!prepared.automatic) return;
      const translationBaseline = receipt.project;
      const track = translationBaseline.captionTracks.translations.find((candidate) => candidate.id === prepared?.trackId);
      const pendingIds = (track?.cues ?? [])
        .filter((cue) => !cue.text.trim() && !cue.translationSkipped)
        .map((cue) => cue.sourceCaptionId);
      if (pendingIds.length > 0) void translationController.refresh(prepared.trackId, pendingIds, translationBaseline);
    } catch (caught) {
      throw new Error(caught instanceof Error ? caught.message : 'Dual subtitles could not be enabled.');
    }
  };

  const requestTranslationRefresh = (
    sourceCaptionIds: string[],
    requestedTrack = selectedTranslationTrack,
  ) => {
    const track = requestedTrack;
    if (!track) return;
    let sourceLanguage;
    try {
      sourceLanguage = projectPrimaryCaptionLanguage(editorSession.current());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Dual subtitles could not refresh.');
      return;
    }
    if (!canAutomaticallyTranslatePair(sourceLanguage, track.languageTag)) {
      Alert.alert(
        'Translation unavailable',
        `${track.displayName} cannot be generated from the current caption language. Choose a different source or target language.`,
      );
      return;
    }
    const refresh = () => {
      setSelectedTranslationTrackId(track.id);
      setDualCaptionEditorOpen(true);
      void translationController.refresh(track.id, sourceCaptionIds);
    };
    const reviewed = track.cues.filter((cue) => sourceCaptionIds.includes(cue.sourceCaptionId) && cue.reviewed);
    if (reviewed.length > 0) {
      Alert.alert(
        'Replace reviewed translation?',
        `${reviewed.length} selected subtitle${reviewed.length === 1 ? ' was' : 's were'} edited by a person. Refresh will replace the second-language text, and Undo can restore it.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Replace + refresh', style: 'destructive', onPress: refresh },
        ],
      );
      return;
    }
    refresh();
  };

  const saveDualCaptionEdits = async (edits: DualCaptionTextEdit[]) => {
    const track = selectedTranslationTrack;
    if (!track || edits.length === 0) return false;
    const committedById = new Map(track.cues.map((cue) => [cue.sourceCaptionId, cue.text.trim()]));
    const resolved = edits.flatMap((edit) => {
      const committedTranslation = committedById.get(edit.sourceCaptionId) ?? '';
      const primaryText = edit.primaryText.trim();
      const translatedText = edit.translatedText.trim() || committedTranslation;
      const primaryChanged = edit.primaryChanged;
      const translatedChanged = translatedText !== committedTranslation;
      return primaryChanged || translatedChanged ? [{
        ...edit,
        primaryText,
        translatedText,
        primaryChanged,
        translatedChanged,
      }] : [];
    });
    if (resolved.length === 0) return true;
    if (resolved.some((edit) => edit.primaryChanged && !edit.primaryText)) {
      Alert.alert('Primary subtitle is empty', 'Enter primary text, or delete that subtitle. The second language may stay empty.');
      return false;
    }
    const saved = await translationController.synchronize(track.id, resolved);
    if (saved) {
      offerTranslationRefresh(resolved.map((edit) => edit.sourceCaptionId), track);
    }
    return saved;
  };

  const offerTranslationRefresh = (sourceCaptionIds: string[], track: NonNullable<typeof selectedTranslationTrack>) => {
    const ids = sourceCaptionIds.filter((id) => !track.cues.find((cue) => cue.sourceCaptionId === id)?.translationSkipped);
    if (!ids.length) return;
    Alert.alert('Check the matching translation',
      `Text changed in ${ids.length} subtitle${ids.length === 1 ? '' : 's'}. The other language was not rewritten. You may keep it, review it, or refresh these ${track.displayName} lines. Refresh replaces second-language text, including typed edits. Export remains available.`,
      [
        { text: 'Keep current text', style: 'cancel' },
        { text: 'Review lines', onPress: () => { setSelectedTranslationTrackId(track.id); setDualCaptionEditorOpen(true); } },
        { text: 'Refresh these lines', onPress: () => requestTranslationRefresh(ids, track) },
      ], { cancelable: true });
  };

  const setSelectedTranslationSkipped = async (sourceCaptionId: string, skipped: boolean) => {
    const trackId = selectedTranslationTrack?.id;
    if (!trackId || translationController.busy) return;
    try {
      await commitEditorProject((before) => setTranslationCueSkipped(before, trackId, sourceCaptionId, skipped, new Date().toISOString()));
    } catch (caught) {
      Alert.alert('Subtitle choice not saved', caught instanceof Error ? caught.message : 'Try again. Saved text is unchanged.');
    }
  };

  const toggleSelectedTranslationTrack = async () => {
    const trackId = selectedTranslationTrack?.id;
    if (!trackId) return;
    try {
      await commitEditorProject((before) => {
        const track = before.captionTracks.translations.find((candidate) => candidate.id === trackId);
        if (!track) return before;
        const updatedAt = new Date().toISOString();
        let next = before;
        if (!track.visible) {
          for (const candidate of before.captionTracks.translations) {
            if (candidate.visible) next = setTranslationTrackVisibility(next, candidate.id, false, updatedAt);
          }
        }
        return setTranslationTrackVisibility(next, track.id, !track.visible, updatedAt);
      });
    } catch (caught) {
      Alert.alert('Second language visibility not saved', caught instanceof Error ? caught.message : 'The second language visibility could not be saved. Try again.');
    }
  };

  const confirmRemoveSelectedTranslationTrack = () => {
    const track = selectedTranslationTrack;
    if (!track) return;
    Alert.alert('Remove second language?', track.displayName + ' text will be removed from this project. The primary captions stay unchanged.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: () => {
          void commitEditorProject((before) => removeTranslationCaptionTrack(before, track.id, new Date().toISOString()))
            .then((receipt) => {
              if (!editorSession.isCurrent(receipt)) return;
              setSelectedTranslationTrackId(undefined);
              setDualCaptionEditorOpen(false);
            }).catch((caught) => {
              Alert.alert('Second language not removed', caught instanceof Error ? caught.message : 'The second language could not be removed. Try again.');
            });
        },
      },
    ]);
  };

  const cancelDualCaptionTranslation = async () => {
    await translationController.cancel();
  };

  const updateTextLayerStyle = (layerId: string, patch: CaptionStylePatch, persist = false) => {
    if (persist) pushUndo();
    setProject((current) => {
      const next = setTextLayerStyle(current, layerId, patch);
      if (persist) persistProjectInBackground();
      return next;
    });
  };

  const updateSharedCaptionTransform = (patch: CaptionStylePatch) => {
    setProject((current) => applyStylePatch(current, selectedCaptionId, 'all', patch));
  };

  const commitTranslationTrackPatch = (operation: EditorProjectOperation) => {
    void commitEditorProject(operation).catch(() => undefined);
  };

  const adjustTranslationGap = (delta: number) => {
    const trackId = selectedTranslationTrack?.id;
    if (!trackId) return;
    commitTranslationTrackPatch((before) => {
      const track = before.captionTracks.translations.find((candidate) => candidate.id === trackId);
      return track ? setTranslationStackGap(before, trackId, (track.stackGap ?? DEFAULT_TRANSLATION_STACK_GAP) + delta) : before;
    });
  };

  const adjustTranslationFontSize = (delta: number) => {
    const trackId = selectedTranslationTrack?.id;
    if (!trackId) return;
    commitTranslationTrackPatch((before) => {
      const track = before.captionTracks.translations.find((candidate) => candidate.id === trackId);
      if (!track) return before;
      const pair = resolveCaptionPairs(before, trackId).find((candidate) => candidate.source.id === selectedCaptionId);
      const currentSize = pair?.style.fontSize ?? track.styleOverride?.fontSize ?? 34;
      return setTranslationTrackStyle(before, trackId, { fontSize: Math.min(96, Math.max(14, currentSize + delta)) });
    });
  };

  const updateVideoTransform = (patch: VideoTransformPatch, ownerClipId = editableVideoClip?.id) => {
    const clipId = ownerClipId;
    if (!clipId) return;
    setProject((current) => {
      const next = setVideoClipTransform(current, clipId, patch);
      return next;
    });
  };

  const updateTimelineItemTiming = (item: TimelineItemReference, edge: TimelineTimingEdge, startMs: number, endMs: number) => {
    setProject((current) => {
      const next = applyTimelineItemTiming(current, item, edge, startMs, endMs, timelineDurationMs);
      return next;
    });
  };

  const addTextLayer = () => {
    pushUndo();
    const id = uniqueId('text');
    const duration = Math.max(500, timelineDurationMs);
    const result = createTextLayer(editorSession.current(), id, currentMs, duration);
    setProject((current) => {
      const next = current === editorSession.current() ? result.project : createTextLayer(current, id, currentMs, duration).project;
      persistProjectInBackground();
      return next;
    });
    selectEditorObject({ kind: 'text', id });
    setEditingLayerId(id);
    setEditingText(result.layer.text);
  };

  const addWatermark = (text: string) => {
    const id = uniqueId('watermark');
    const result = createWatermarkLayer(editorSession.current(), id, Math.max(500, timelineDurationMs), text);
    if (!result) {
      Alert.alert('Watermark limit reached', `A project can have up to ${MAX_PROJECT_WATERMARKS} watermarks.`);
      return;
    }
    pushUndo();
    setProject(result.project);
    persistProjectInBackground();
    setWatermarkOpen(false);
    selectEditorObject({ kind: 'text', id });
  };

  const removeWatermark = (layerId: string) => {
    pushUndo();
    setProject((current) => deleteVisualLayer(current, layerId));
    persistProjectInBackground();
  };

  const addImageLayer = async () => {
    const id = uniqueId('image');
    try {
      const receipt = await commitEditorProject(async (before) => {
        const stored = await pickAndStoreImage(before.id, id);
        if (!stored) return null;
        ownedAssetLedgerRef.current = trackProjectOwnedAssets(ownedAssetLedgerRef.current, [stored.uri]);
        return addImageLayerToProject(before, {
          id, name: stored.name, uri: stored.uri, currentMs,
          durationMs: Math.max(500, projectTimelineDuration(before)),
        }).project;
      });
      if (editorSession.isCurrent(receipt)) selectEditorObject({ kind: 'image', id });
    } catch (caught) {
      if (workspaceMountedRef.current) Alert.alert('Could not add image', caught instanceof Error ? caught.message : 'The selected image could not be saved.');
    }
  };

  const moveLayer = (layerId: string, direction: -1 | 1) => {
    pushUndo();
    setProject((current) => {
      const next = moveVisualLayer(current, layerId, direction);
      persistProjectInBackground();
      return next;
    });
  };

  const deleteLayer = (layerId: string) => {
    if (layerId === 'captions') return;
    pushUndo();
    setProject((current) => {
      const next = deleteVisualLayer(current, layerId);
      persistProjectInBackground();
      return next;
    });
    setSelectedLayerId('captions');
  };

  const splitSelectedVisualAtPlayhead = () => {
    if (!selectedLayer || selectedLayer.kind === 'captions') return;
    const result = splitVisualLayer(
      editorSession.current(),
      selectedLayer.id,
      currentMs,
      uniqueId(selectedLayer.kind),
      uniqueId(selectedLayer.kind),
    );
    if (!result) {
      Alert.alert('Move the playhead inside this item', 'A split needs a little room on both sides of the playhead.');
      return;
    }
    transport.pause();
    pushUndo();
    setProject(result.project);
    persistProjectInBackground();
    setSelectedLayerId(result.right.id);
  };

  const addVideosToTimeline = async () => {
    setError(undefined);
    try {
      const receipt = await commitEditorProject((before) => appendVideosToProject(before, setMediaProgress), true);
      if (!receipt || !editorSession.isCurrent(receipt)) return;
      const { before, project: next } = receipt;
      transport.synchronizeProject(next);
      const firstAdded = next.clips[before.clips.length];
      setSelectedClipId(firstAdded?.id);
      setSelectedCaptionId(undefined);
      openEditorTool('video');
      if (firstAdded) seekTimeline(totalClipDuration(before.clips));
    } catch (caught) {
      if (workspaceMountedRef.current) Alert.alert('Could not add videos', caught instanceof Error ? caught.message : 'The selected videos could not be added.');
    } finally {
      if (workspaceMountedRef.current) setMediaProgress(undefined);
    }
  };

  const updateSelectedClip = (patch: Partial<Pick<VideoClip, 'volume' | 'muted' | 'fadeInMs' | 'fadeOutMs'>>) => {
    if (!selectedClipId) return;
    const before = editorSession.current();
    pushUndo(before);
    const next = updateVideoClip(before, selectedClipId, patch);
    transport.synchronizeProject(next);
    setProject(next);
    persistProjectInBackground();
    const entry = buildClipTimeline(next.clips).find((candidate) => candidate.clip.id === selectedClipId);
    if (entry) transport.seek(clamp(currentMs, entry.startMs, entry.endMs));
  };

  const updateSelectedClipRate = (rate: number) => {
    if (!selectedClipId) return;
    const before = editorSession.current();
    const oldEntry = buildClipTimeline(before.clips).find((entry) => entry.clip.id === selectedClipId);
    if (!oldEntry) return;
    pushUndo(before);
    const next = setClipPlaybackRate(before, selectedClipId, rate);
    transport.synchronizeProject(next);
    setProject(next);
    persistProjectInBackground();
    const entry = buildClipTimeline(next.clips).find((candidate) => candidate.clip.id === selectedClipId);
    if (entry) {
      const relativeProgress = clamp((currentMs - oldEntry.startMs) / Math.max(1, oldEntry.endMs - oldEntry.startMs), 0, 1);
      const nextTime = entry.startMs + relativeProgress * (entry.endMs - entry.startMs);
      transport.seek(nextTime);
    }
  };

  const splitClipAtPlayhead = () => {
    const entry = timelineEntryAt(clipTimeline, currentMs);
    if (!entry) return;
    const result = splitVideoClip(editorSession.current(), entry.clip.id, currentMs, uniqueId('clip'), uniqueId('clip'));
    if (!result) return;
    pushUndo();
    transport.synchronizeProject(result.project);
    setProject(result.project);
    persistProjectInBackground();
    setSelectedClipId(result.rightClipId);
  };

  const deleteSelectedClip = () => {
    if (!selectedClipId) return;
    const result = deleteVideoClip(editorSession.current(), selectedClipId);
    if (!result) return;
    pushUndo();
    const next = result.project;
    transport.synchronizeProject(next);
    setProject(next);
    setSelectedClipId(next.clips[0]?.id);
    persistProjectInBackground();
    queueMicrotask(() => seekTimeline(result.seekMs));
  };

  const trimClipEdge = (clipId: string, edge: 'start' | 'end', targetSourceMs: number) => {
    const current = editorSession.current();
    const result = trimVideoClip(current, clipId, edge, targetSourceMs);
    if (!result) return;
    pushUndo();
    const next = result.project;
    transport.synchronizeProject(next);
    setProject(next);
    persistProjectInBackground();
    transport.pause();
    queueMicrotask(() => seekTimeline(Math.min(result.seekMs, Math.max(0, projectTimelineDuration(next) - 1))));
  };

  const setClipGap = (clipId: string, gapMs: number, edge: 'before' | 'after' = 'before') => {
    const result = setVideoClipGap(editorSession.current(), clipId, gapMs, edge);
    if (!result) return;
    pushUndo();
    transport.synchronizeProject(result.project);
    setProject(result.project);
    persistProjectInBackground();
    transport.pause();
  };

  const setClipLeadingGap = (clipId: string, gapMs: number) => {
    const result = setVideoClipLeadingGap(editorSession.current(), clipId, gapMs);
    if (!result) return;
    pushUndo();
    transport.synchronizeProject(result.project);
    setProject(result.project);
    persistProjectInBackground();
    transport.pause();
  };

  const addAudio = async (origin: 'audio-file' | 'video-audio') => {
    transport.pause();
    setError(undefined);
    if (origin === 'video-audio') {
      setExtractAudioOpen(true);
      return;
    }
    setExtractAudioBusy(true);
    try {
      const receipt = await commitEditorProject(async (before) => {
        const result = await appendAudioToProject(before, currentMs, origin);
        return result?.project ?? null;
      }, true);
      if (!receipt || !editorSession.isCurrent(receipt)) return;
      const added = receipt.project.audioClips.find((clip) => !receipt.before.audioClips.some((previous) => previous.id === clip.id));
      if (added) selectEditorObject({ kind: 'audio', id: added.id });
    } catch (caught) {
      if (workspaceMountedRef.current) Alert.alert('Could not add audio', caught instanceof Error ? caught.message : 'The selected media could not be added.');
    } finally {
      if (workspaceMountedRef.current) setExtractAudioBusy(false);
    }
  };

  const addProjectVideoAudio = async (sourceId?: string) => {
    transport.pause();
    setError(undefined);
    const markExtractBusy = () => { if (workspaceMountedRef.current) setExtractAudioBusy(true); };
    if (sourceId) markExtractBusy();
    try {
      const receipt = await commitEditorProject(async (before) => {
        const result = sourceId
          ? await appendProjectVideoAudioToProject(before, currentMs, sourceId)
          : await appendAudioToProject(before, currentMs, 'video-audio', markExtractBusy);
        return result?.project ?? null;
      }, true);
      if (!receipt || !editorSession.isCurrent(receipt)) return;
      const added = receipt.project.audioClips.find((clip) => !receipt.before.audioClips.some((previous) => previous.id === clip.id));
      if (added) selectEditorObject({ kind: 'audio', id: added.id });
      setExtractAudioOpen(false);
    } catch (caught) {
      if (workspaceMountedRef.current) Alert.alert('Could not extract audio', caught instanceof Error ? caught.message : 'The selected video could not be used.');
    } finally {
      if (workspaceMountedRef.current) setExtractAudioBusy(false);
    }
  };

  const startVoiceover = async () => {
    if (voiceoverSaving || voiceoverRecorderState.isRecording) return;
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Microphone permission needed', 'Allow microphone access to record a voice-over. Your project has not changed.');
        return;
      }
      await AudioModule.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, interruptionMode: 'mixWithOthers', shouldRouteThroughEarpiece: false });
      await voiceoverRecorder.prepareToRecordAsync(VOICEOVER_RECORDING_OPTIONS);
      setVoiceoverStartMs(currentMs);
      voiceoverRecorder.record();
      if (!isPlaying && runtimePolicy.mediaAdmitted) transport.play();
    } catch (caught) {
      Alert.alert('Could not start voice-over', caught instanceof Error ? caught.message : 'The microphone could not start.');
    }
  };

  const stopVoiceover = async (closeWhenSaved = false) => {
    if (voiceoverSaving) return;
    if (!voiceoverRecorderState.isRecording) {
      if (closeWhenSaved) setVoiceoverOpen(false);
      return;
    }
    setVoiceoverSaving(true);
    try {
      transport.pause();
      await voiceoverRecorder.stop();
      const recordingUri = voiceoverRecorder.uri;
      if (!recordingUri) throw new Error('The phone did not provide a recording file.');
      const receipt = await commitEditorProject(async (before) => {
        const result = await appendRecordedAudioToProject(before, voiceoverStartMs ?? currentMs, recordingUri);
        return result.project;
      }, true);
      if (!receipt || !editorSession.isCurrent(receipt)) return;
      const added = receipt.project.audioClips.find((clip) => !receipt.before.audioClips.some((previous) => previous.id === clip.id));
      if (added) selectEditorObject({ kind: 'audio', id: added.id });
      if (closeWhenSaved) setVoiceoverOpen(false);
    } catch (caught) {
      Alert.alert('Could not save voice-over', caught instanceof Error ? caught.message : 'The recorded take was not added to the project.');
    } finally {
      setVoiceoverStartMs(undefined);
      setVoiceoverSaving(false);
      await AudioModule.setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true, interruptionMode: 'mixWithOthers', shouldRouteThroughEarpiece: false }).catch(() => undefined);
    }
  };

  useEffect(() => {
    const closeVoiceover = () => {
      if (voiceoverRecorderState.isRecording) void stopVoiceover(true);
      else setVoiceoverOpen(false);
    };
    voiceoverBackRequestRef.current = closeVoiceover;
    return () => {
      if (voiceoverBackRequestRef.current === closeVoiceover) voiceoverBackRequestRef.current = undefined;
    };
  });

  const commitAudioProject = (next: CaptionProject) => {
    transport.synchronizeProject(next);
    setProject(next);
    persistProjectInBackground();
  };

  const updateSelectedAudio = (patch: Partial<Pick<AudioClip, 'volume' | 'muted' | 'fadeInMs' | 'fadeOutMs'>>) => {
    if (!selectedAudioClipId) return;
    pushUndo();
    commitAudioProject(updateAudioClip(editorSession.current(), selectedAudioClipId, patch));
  };

  const shiftSelectedAudio = (deltaMs: number) => {
    if (!selectedAudioClip) return;
    pushUndo();
    commitAudioProject(moveAudioClip(editorSession.current(), selectedAudioClip.id, selectedAudioClip.startMs + deltaMs, timelineDurationMs));
  };

  const removeSelectedAudio = () => {
    if (!selectedAudioClipId) return;
    pushUndo();
    commitAudioProject(deleteAudioClip(editorSession.current(), selectedAudioClipId));
    setSelectedAudioClipId(undefined);
  };

  const copySelectedAudio = () => {
    if (!selectedAudioClipId) return;
    const result = duplicateAudioClip(editorSession.current(), selectedAudioClipId, uniqueId('audio-clip'), timelineDurationMs);
    if (!result) return;
    pushUndo();
    commitAudioProject(result.project);
    setSelectedAudioClipId(result.clip.id);
  };

  const splitSelectedAudioAtPlayhead = () => {
    if (!selectedAudioClipId) return;
    const result = splitAudioClip(
      editorSession.current(),
      selectedAudioClipId,
      currentMs,
      uniqueId('audio-clip'),
      uniqueId('audio-clip'),
    );
    if (!result) {
      Alert.alert('Move the playhead inside this audio', 'A split needs a little room on both sides of the playhead.');
      return;
    }
    transport.pause();
    pushUndo();
    commitAudioProject(result.project);
    setSelectedAudioClipId(result.right.id);
  };

  const applyTransition = (type: VideoClip['transitionAfter']['type'], durationMs = 500) => {
    if (!selectedClipId) return;
    pushUndo();
    const next = setVideoTransition(editorSession.current(), selectedClipId, type, durationMs);
    setProject(next);
    persistProjectInBackground();
  };

  const reorderSelectedVideo = (direction: -1 | 1) => {
    if (!selectedClipId) return;
    pushUndo();
    const next = moveVideoClip(editorSession.current(), selectedClipId, direction);
    transport.synchronizeProject(next);
    setProject(next);
    persistProjectInBackground();
  };

  const reorderClipToIndex = (clipId: string, toIndex: number) => {
    const result = reorderVideoClip(editorSession.current(), clipId, toIndex);
    if (!result) return;
    pushUndo();
    transport.synchronizeProject(result.project);
    setProject(result.project);
    persistProjectInBackground();
    transport.pause();
    queueMicrotask(() => seekTimeline(Math.min(result.seekMs, Math.max(0, projectTimelineDuration(result.project) - 1))));
  };

  const exportVideo = async () => {
    if (exporting) return;
    const snapshot = editorSession.current();
    transport.pause();
    setError(undefined);
    setExportKind('video');
    setExportProgress({ stage: 'preparing', percent: 0 });
    setExporting(true);
    try {
      if (!await confirmOptionalTranslationExport(snapshot, true)) return;
      const result = await exportProjectVideo(snapshot, true);
      Alert.alert('Export complete', `Saved to Movies/Caption Studio.\n${result.width} × ${result.height}`);
    } catch (caught) {
      if (!(caught instanceof VideoExportCancelledError)) {
        const message = userFacingExportError(caught);
        setError(message);
        Alert.alert('Export failed', message);
      }
    } finally {
      setExporting(false);
    }
  };

  const exportSubtitles = async (format: 'srt' | 'ass') => {
    if (exporting) return;
    const snapshot = editorSession.current();
    transport.pause();
    setError(undefined);
    setExportKind('subtitle');
    setExportProgress(undefined);
    setExporting(true);
    try {
      if (!await confirmOptionalTranslationExport(snapshot, false)) return;
      await exportSubtitleFile(snapshot, format, true);
    } catch (caught) {
      const message = userFacingExportError(caught, 'The subtitle file could not be exported.');
      setError(message);
      Alert.alert('Subtitle export failed', message);
    } finally {
      setExporting(false);
      setExportProgress(undefined);
    }
  };

  const showExportMenu = () => {
    if (exporting) return;
    Alert.alert('Export project', 'Choose what to create.', [
      { text: 'Rendered MP4', onPress: () => { void exportVideo(); } },
      {
        text: 'Subtitle file',
        onPress: () => Alert.alert('Subtitle format', 'SRT works almost everywhere. ASS preserves advanced styling.', [
          { text: 'SRT', onPress: () => { void exportSubtitles('srt'); } },
          { text: 'ASS', onPress: () => { void exportSubtitles('ass'); } },
          { text: 'Cancel', style: 'cancel' },
        ]),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const deleteCaption = (captionId: string) => {
    const current = editorSession.current();
    const index = current.captions.findIndex((caption) => caption.id === captionId);
    if (index < 0) return;
    pushUndo();
    const next = deleteCaptionBlock(current, captionId);
    setProject(next);
    setSelectedCaptionId(next.captions[Math.min(index, next.captions.length - 1)]?.id);
    persistProjectInBackground();
  };

  const confirmDeleteCaption = (captionId: string) => {
    Alert.alert('Delete this subtitle?', 'Only this caption block will be removed. The source video is unchanged.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteCaption(captionId) },
    ]);
  };

  const setCanvasPreset = (preset: CaptionProject['canvas']['preset']) => {
    void commitEditorProject((before) => applyCanvasPreset(before, preset)).catch((caught) => {
      if (workspaceMountedRef.current) Alert.alert('Canvas size not saved', caught instanceof Error ? caught.message : 'The canvas size could not be saved. Try again.');
    });
  };

  const previewSceneTargets: PreviewSceneTarget<EditorSelection>[] = [];
  let previewOrder = 0;
  for (const layer of timelineLayers) {
    if (!layer.visible) continue;
    if (layer.kind === 'captions') {
      for (const caption of scriptEditorOpen ? (displayCaption ? [displayCaption] : []) : activeCaptions) previewSceneTargets.push({
        key: `caption:${caption.id}`,
        transformKey: 'captions',
        selection: { kind: 'captions', captionId: caption.id },
        geometry: resolveCaptionStyle(project.projectStyle, caption),
        order: previewOrder++,
        deletable: true,
      });
      for (const pair of displayTranslationPairs) previewSceneTargets.push({
        key: `translation:${pair.trackId}:${pair.source.id}`,
        transformKey: `translation:${pair.trackId}`,
        selection: { kind: 'translation', id: pair.trackId, captionId: pair.source.id },
        geometry: pair.style,
        order: previewOrder++,
      });
      continue;
    }
    if (!visualLayerVisibleAtTime(layer, currentMs)) continue;
    previewSceneTargets.push({
      key: `layer:${layer.id}`,
      selection: { kind: layer.kind, id: layer.id },
      geometry: layer.kind === 'text' ? layer.style : layer,
      order: previewOrder++,
      deletable: true,
    });
  }
  const selectedPreviewObjectKey = selectedLayerId === 'captions' && selectedCaption
    ? `caption:${selectedCaption.id}`
    : selectedTranslationPair
      ? `translation:${selectedTranslationPair.trackId}:${selectedTranslationPair.source.id}`
      : selectedTextLayer || selectedImageLayer
        ? `layer:${selectedLayerId}`
        : undefined;
  const {
    canvasRef: previewCanvasRef,
    onLayout: onPreviewCanvasLayout,
    responders: previewSceneResponders,
    geometryFor: previewGeometryFor,
    selectedKey: sceneSelectedKey,
  } = usePreviewSceneGesture({
    targets: previewSceneTargets,
    selectedKey: selectedPreviewObjectKey,
    enabled: activeTool !== 'video' && !blockingUi && !finishingSession,
    contextKey: `${project.id}:${scriptCropActive}:${canvasWidth}:${canvasHeight}`,
    onSelect: selectEditorObject,
    onClearSelection: clearEditorSelection,
    onChange: (target, geometry) => {
      if (!editorSession.editable()) return;
      const before = editorSession.current();
      const next = applyPreviewSceneGeometry(before, target, geometry);
      if (next === before) return;
      pushUndo(before);
      setProject(next);
      persistProjectInBackground();
    },
    onDelete: (target) => {
      const selection = target.selection;
      if (selection.kind === 'captions' && selection.captionId) confirmDeleteCaption(selection.captionId);
      else if ((selection.kind === 'text' || selection.kind === 'image') && selection.id) deleteLayer(selection.id);
    },
    onInteractionStart: () => transport.pause(),
    onInteractionEnd: () => {},
  });
  const selectedPreviewTarget = previewSceneTargets.find((target) => target.key === sceneSelectedKey);

  return (
    <PersistedHorizontalScrollScope id={project.id}>
    <View
      pointerEvents={finishingSession ? 'none' : 'auto'}
      onLayout={(event) => setWorkspaceHeight(event.nativeEvent.layout.height)}
      style={{ flex: 1, backgroundColor: palette.background }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Clear editor selection"
        onPress={(event) => {
          if (event.target === event.currentTarget) clearEditorSelection();
        }}
        style={{ height: previewHeight, flexShrink: 0, overflow: scriptEditorOpen ? 'hidden' : 'visible', alignItems: 'center', justifyContent: 'center', paddingTop: 8 }}>
        <View
          style={{
            width: scriptCropActive ? width - 24 : canvasWidth,
            height: scriptCropActive ? scriptCrop.viewport.height : canvasHeight,
            overflow: 'hidden',
            borderRadius: 20,
          }}>
          <View
            testID="script-preview-viewport"
            style={{
              width: scriptCropActive ? scriptCrop.viewport.width : canvasWidth,
              height: scriptCropActive ? scriptCrop.viewport.height : canvasHeight,
              overflow: 'hidden',
              borderRadius: 20,
            }}>
          <Animated.View
          testID="script-preview-canvas"
          // Keep the native transform attached through exit. React owns canvas
          // dimensions on the child; native animation owns only translation.
          style={{ transform: cropOffset.getTranslateTransform() }}>
          <View
          testID="editor-preview-layout"
          style={{
            width: canvasWidth,
            height: canvasHeight,
            overflow: 'hidden',
            backgroundColor: project.canvas.backgroundColor,
          }}>
          <View
            style={{
              position: 'absolute',
              inset: 0,
              transform: [
                { translateX: (currentVideoTransform.position.x - 0.5) * canvasSize.width },
                { translateY: (currentVideoTransform.position.y - 0.5) * canvasSize.height },
                { scale: currentVideoTransform.scale },
                { rotate: `${currentVideoTransform.rotation}deg` },
              ],
            }}>
          </View>
          {transport.isGap ? (
            <View pointerEvents="none" style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: project.canvas.backgroundColor }}>
            </View>
          ) : null}
          <VideoTransitionOverlay
            entries={clipTimeline}
            sources={project.sources}
            timelineMs={currentMs}
            isPlaying={isPlaying}
            transportReady={transport.phase === 'ready'}
            width={canvasWidth}
            height={canvasHeight}
            backgroundColor={project.canvas.backgroundColor}
            admitted={runtimePolicy.videoSurfacesAdmitted}
            visible={!transport.isGap}
            players={transport.players}
            slots={transport.slots}
            activeSlot={transport.activeSlot}
            currentTransform={currentVideoTransform}
            onFirstFrameRender={transport.markFirstFrame}
          />
          {activeTool === 'video' && currentClipEntry ? (
            <VideoTransformOverlay
              id={currentClipEntry.clip.id}
              transform={currentVideoTransform}
              onInteractionStart={() => { transport.pause(); beginHistoryInteraction(); }}
              onChange={(patch) => updateVideoTransform(patch, currentClipEntry.clip.id)}
              onEnd={finishHistoryInteraction}
            />
          ) : null}
          {timelineLayers.map((layer) => {
            if (!layer.visible) return null;
            if (layer.kind === 'captions') {
              return (
                <View key={layer.id} pointerEvents="box-none" style={{ position: 'absolute', inset: 0 }}>
                  <CaptionOverlay
                    caption={displayCaption}
                    captions={scriptEditorOpen ? undefined : activeCaptions}
                    geometry={displayCaption
                      ? previewGeometryFor(`caption:${displayCaption.id}`, resolveCaptionStyle(project.projectStyle, displayCaption))
                      : undefined}
                    geometryForCaption={(caption) => previewGeometryFor(`caption:${caption.id}`, resolveCaptionStyle(project.projectStyle, caption))}
                    selectionCaption={selectedLayerId === 'captions' && selectedCaption
                      && (scriptEditorOpen || activeCaptions.some((caption) => caption.id === selectedCaption.id))
                      ? selectedCaption : undefined}
                    preserveLineBreaks={scriptEditorOpen && !isPlaying}
                    editingPreview={scriptEditorOpen && !isPlaying}
                    words={project.transcription.words}
                    projectStyle={project.projectStyle}
                    currentMs={currentMs}
                    selected={activeTool !== 'video' && selectedLayerId === 'captions' && Boolean(selectedCaption)
                      && (scriptEditorOpen || activeCaptions.some((caption) => caption.id === selectedCaption?.id))}
                    deletable={Boolean(selectedCaptionId)}
                  />
                  {translationTimelineTracks.filter((track) => track.visible).map((track) => {
                    const active = displayTranslationPairs.filter((pair) => pair.trackId === track.id);
                    const selected = selectedTranslationPair?.trackId === track.id
                      && active.some((pair) => pair.source.id === selectedTranslationPair.source.id)
                      ? selectedTranslationPair : undefined;
                    if (!active.length && !selected) return null;
                    return active.map((pair) => <CaptionOverlay
                      key={pair.translation.id}
                      caption={{ id: pair.translation.id, text: pair.translation.text,
                        startMs: pair.startMs, endMs: pair.endMs, wordIds: [], styleOverride: pair.style }}
                      selectionCaption={selected?.source.id === pair.source.id ? { id: pair.translation.id, text: pair.translation.text,
                        startMs: pair.startMs, endMs: pair.endMs, wordIds: [] } : undefined}
                      selectionStyle={selected?.source.id === pair.source.id ? selected.style : undefined}
                      geometry={previewGeometryFor(`translation:${pair.trackId}:${pair.source.id}`, pair.style)}
                      words={[]}
                      projectStyle={pair.style}
                      currentMs={currentMs}
                      selected={activeTool !== 'video' && selected?.source.id === pair.source.id}
                    />);
                  })}
                </View>
              );
            }
        if (!visualLayerVisibleAtTime(layer, currentMs)) return null;
            if (layer.kind === 'text') {
              return (
                  <CaptionOverlay
                    key={layer.id}
                  caption={{ id: layer.id, text: layer.text, startMs: layer.startMs, endMs: layer.endMs, wordIds: [] }}
                  words={[]}
                    projectStyle={layer.style}
                    geometry={previewGeometryFor(`layer:${layer.id}`, layer.style)}
                    currentMs={currentMs}
                    selected={activeTool !== 'video' && selectedLayerId === layer.id}
                    deletable
                    preserveLineBreaks
                  />
              );
            }
            return (
              <ImageLayerOverlay
                key={layer.id}
                layer={layer}
                geometry={previewGeometryFor(`layer:${layer.id}`, layer)}
                selected={activeTool !== 'video' && selectedLayerId === layer.id}
                deletable
              />
            );
          })}
          {activeTool !== 'video' && selectedPreviewTarget ? <LayerTransformOverlay
            geometry={previewGeometryFor(selectedPreviewTarget.key, selectedPreviewTarget.geometry)}
            selected deletable={selectedPreviewTarget.deletable} /> : null}
          <View
            testID="preview-scene-input"
            ref={previewCanvasRef}
            collapsable={false}
            pointerEvents={activeTool !== 'video' && !blockingUi && !finishingSession ? 'auto' : 'none'}
            onLayout={onPreviewCanvasLayout}
            {...previewSceneResponders}
            style={{ position: 'absolute', inset: 0 }}
          />
          </View>
          </Animated.View>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={isPlaying ? 'Pause video' : 'Play video'}
            disabled={!runtimePolicy.mediaAdmitted}
            onPress={() => {
              if (isPlaying || !runtimePolicy.mediaAdmitted) {
                transport.pause();
              } else {
                clearEditorSelection();
                transport.play();
              }
            }}
            style={{
              position: 'absolute',
              right: scriptCropActive ? 0 : 12,
              bottom: scriptCropActive ? Math.max(0, (scriptCrop.viewport.height - 48) / 2) : 12,
              width: 48,
              height: 48,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 24,
              backgroundColor: 'rgba(7,9,12,0.76)',
            }}>
            <Text style={{ color: '#FFF', fontSize: 20 }}>{isPlaying ? 'Ⅱ' : '▶'}</Text>
          </Pressable>
        </View>
      </Pressable>

      {transport.sourceFailure ? (
        <View accessibilityLiveRegion="polite" style={{ padding: 12, gap: 6, backgroundColor: palette.surfaceRaised }}>
          <Text style={{ color: palette.text, fontWeight: '800' }}>
            Video unavailable: {transport.sourceFailure.displayName}
          </Text>
          <Text style={{ color: palette.text }}>{transport.sourceFailure.message}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try loading source video again"
            disabled={transport.phase === 'loading' || !runtimePolicy.mediaAdmitted}
            onPress={transport.retrySource}
            style={{ minHeight: 44, justifyContent: 'center' }}>
            <Text style={{ color: palette.accent, fontWeight: '800' }}>
              {transport.phase === 'loading' ? 'Loading video...' : 'Try loading video again'}
            </Text>
          </Pressable>
        </View>
      ) : null}

      <View style={{ flex: 1, display: scriptEditorOpen ? 'none' : 'flex' }}>
        <ScrollView
          ref={editorScrollRef}
          onLayout={scriptExit.onScrollLayout}
          onScroll={scriptExit.onScroll}
          onContentSizeChange={scriptExit.onContentSizeChange}
          scrollEventThrottle={16}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          style={{ flex: 1 }}
          contentContainerStyle={{ gap: 12, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 18 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 10 }}>
          <HistoryButton label="↶  Undo" disabled={!historyAvailability.undo} onPress={undo} />
          <HistoryButton label="Redo  ↷" disabled={!historyAvailability.redo} onPress={redo} />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={{ color: palette.text, fontSize: 16, fontWeight: '700' }}>
              {project.name}
            </Text>
            <Text style={{ color: palette.muted, fontSize: 12 }}>
              {formatTime(currentMs)} / {formatTime(timelineDurationMs)}
            </Text>
          </View>
          {project.captions.length === 0 ? (
            <Pressable
              onPress={() => chooseCaptionQuality(false)}
              style={{ paddingHorizontal: 16, paddingVertical: 11, borderRadius: chrome.radius.pill, backgroundColor: palette.accent }}>
              <Text style={{ color: chrome.accentInk, fontWeight: '700' }}>Generate captions</Text>
            </Pressable>
          ) : (
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
              <Text style={{ color: palette.accent, fontSize: 12, fontWeight: '700' }}>
                {project.captions.length} CAPTIONS
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Generate captions again"
                onPress={() => chooseCaptionQuality(true)}
                hitSlop={10}>
                <Text style={{ color: palette.text, fontSize: 12, fontWeight: '700', textDecorationLine: 'underline' }}>
                  Generate again
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open optional dual subtitles"
                onPress={openDualCaptionEditor}
                hitSlop={8}>
                <Text style={{ color: '#64D2FF', fontSize: 13, fontWeight: '700' }}>
                  {project.captionTracks.translations.length > 0 ? 'Dual subtitles' : 'Add dual subtitles'}
                </Text>
              </Pressable>
            </View>
          )}
        </View>

        {voiceoverOpen ? <VoiceoverControls
          recording={voiceoverRecorderState.isRecording}
          saving={voiceoverSaving}
          playing={isPlaying}
          onTogglePlayback={() => { if (isPlaying) transport.pause(); else transport.play(); }}
          onStart={() => void startVoiceover()}
          onStop={() => void stopVoiceover(true)}
          onClose={() => voiceoverBackRequestRef.current?.()}
        /> : null}
        <View onLayout={scriptExit.onTimelineLayout}>
        <LayerTimeline
          projectId={project.id}
          durationMs={timelineDurationMs}
          clips={project.clips}
          sources={project.sources}
          layers={timelineLayers}
          captions={timelineCaptions}
          translationTracks={translationTimelineTracks}
          selectedLayerId={selectedLayerId}
          selectedCaptionId={selectedCaptionId}
          selectedClipId={selectedClipId}
          audioSources={project.audioSources}
          audioClips={project.audioClips}
          selectedAudioClipId={selectedAudioClipId}
          currentMs={currentMs}
          onSeek={seekTimeline}
          onScrubStart={transport.pause}
          onClearSelection={clearEditorSelection}
          onSelectLayer={selectEditorLayer}
          onSelectCaption={(caption) => selectEditorObject({ kind: 'captions', captionId: caption.id })}
          onSelectTranslationCaption={(trackId, pair) => selectEditorObject({ kind: 'translation', id: trackId, captionId: pair.source.id })}
          onSelectClip={(clipId) => selectEditorObject({ kind: 'video', id: clipId })}
          onTrimClip={trimClipEdge}
          onSetClipGap={setClipGap}
          onSetClipLeadingGap={setClipLeadingGap}
          onReorderClip={reorderClipToIndex}
          onItemTimingChange={updateTimelineItemTiming}
          onTimingChangeStart={beginHistoryInteraction}
          onTimingChangeEnd={finishHistoryInteraction}
          onMoveLayer={moveLayer}
          onDeleteLayer={deleteLayer}
          onAddVideos={() => { void addVideosToTimeline(); }}
          onSelectAudioClip={(clipId) => selectEditorObject({ kind: 'audio', id: clipId })}
          voiceoverMode={voiceoverOpen}
          voiceoverDraft={voiceoverRecorderState.isRecording && voiceoverStartMs != null ? {
            startMs: voiceoverStartMs,
            endMs: Math.max(voiceoverStartMs + 80, currentMs),
            meterLevel: voiceoverMeterLevel,
          } : undefined}
        />
        </View>
        {selectedCaption || selectedTranslationPair || selectedAudioClip || selectedTextLayer || selectedImageLayer ? (
          <Text style={{ color: palette.muted, fontSize: 11 }}>Drag the selected block to move it. Drag either white edge to trim it.</Text>
        ) : null}

        {activeTool === 'video' ? (
          <View style={{ gap: 8 }}>
            {selectedClip ? (
              <View style={{ gap: 7 }}>
                <Text numberOfLines={1} style={{ color: palette.accent, fontSize: 12, fontWeight: '900' }}>
                  SELECTED CLIP · {project.sources.find((source) => source.id === selectedClip.sourceId)?.displayName ?? 'Video'}
                </Text>
                <PersistedHorizontalScroll id="tool:video:clip-actions" contentContainerStyle={{ gap: 8 }}>
                  <Action label="Split at playhead" onPress={splitClipAtPlayhead} />
                  <Action label="Delete + close gap" danger onPress={deleteSelectedClip} />
                  <Action label="Gap −0.5s" disabled={selectedClip.gapBeforeMs <= 0} onPress={() => setClipGap(selectedClip.id, Math.max(0, selectedClip.gapBeforeMs - 500))} />
                  <Action label={selectedClip.gapBeforeMs > 0 ? `Remove ${formatSeconds(selectedClip.gapBeforeMs)} gap` : 'No gap'} color={selectedClip.gapBeforeMs > 0 ? '#FF7C8D' : '#64E8FF'} disabled={selectedClip.gapBeforeMs <= 0} onPress={() => setClipGap(selectedClip.id, 0)} />
                  <Action label="Gap +0.5s" onPress={() => setClipGap(selectedClip.id, selectedClip.gapBeforeMs + 500)} />
                  <Action label={selectedClip.muted ? 'Unmute' : 'Mute'} onPress={() => updateSelectedClip({ muted: !selectedClip.muted })} />
                  <Action label="Volume −" disabled={selectedClip.muted || selectedClip.volume <= 0} onPress={() => updateSelectedClip({ volume: clamp(selectedClip.volume - 0.1, 0, 1) })} />
                  <Action label={`${Math.round(selectedClip.volume * 100)}% volume`} color="#64E8FF" onPress={() => updateSelectedClip({ volume: 1, muted: false })} />
                  <Action label="Volume +" disabled={selectedClip.volume >= 1} onPress={() => updateSelectedClip({ volume: clamp(selectedClip.volume + 0.1, 0, 1) })} />
                  <Action label={selectedClip.fadeInMs ? 'Remove fade in' : 'Fade in'} onPress={() => updateSelectedClip({ fadeInMs: selectedClip.fadeInMs ? 0 : 500 })} />
                  <Action label={selectedClip.fadeOutMs ? 'Remove fade out' : 'Fade out'} onPress={() => updateSelectedClip({ fadeOutMs: selectedClip.fadeOutMs ? 0 : 500 })} />
                  <Action label="Move clip left" onPress={() => reorderSelectedVideo(-1)} />
                  <Action label="Move clip right" onPress={() => reorderSelectedVideo(1)} />
                </PersistedHorizontalScroll>
                <PersistedHorizontalScroll id="tool:video:speed" contentContainerStyle={{ gap: 8 }}>
                  {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((rate) => (
                    <Action key={rate} label={`${rate}× speed`} color={selectedClip.playbackRate === rate ? chrome.accent : undefined} onPress={() => updateSelectedClipRate(rate)} />
                  ))}
                </PersistedHorizontalScroll>
                <View style={{ alignItems: 'flex-start' }}>
                  <Action label="Transition timing…" color={selectedClip.transitionAfter.type !== 'none' ? chrome.accent : undefined} disabled={!transitionBoundaryAvailable || selectedClip.transitionAfter.type === 'none'} onPress={() => setTransitionTimingOpen(true)} />
                </View>
                <PersistedHorizontalScroll id="tool:video:transitions" contentContainerStyle={{ gap: 8 }}>
                  {VIDEO_TRANSITION_PRESETS.map((preset) => <Action key={preset.id} label={preset.name} color={selectedClip.transitionAfter.type === preset.id ? chrome.accent : undefined} disabled={preset.id !== 'none' && !transitionBoundaryAvailable} onPress={() => applyTransition(preset.id, preset.durationMs)} />)}
                </PersistedHorizontalScroll>
                {!transitionBoundaryAvailable ? <Text style={{ color: palette.muted, fontSize: 11 }}>Transitions need another clip touching this clip with no empty gap.</Text> : null}
              </View>
            ) : <Text style={{ color: palette.muted, fontSize: 12 }}>Tap a video clip in the timeline to edit that clip.</Text>}
            <VideoTools
              canvas={project.canvas}
              transform={editableVideoTransform}
              onCanvasPreset={setCanvasPreset}
              onFit={(fit) => {
                beginHistoryInteraction();
                updateVideoTransform({ fit });
                queueMicrotask(finishHistoryInteraction);
              }}
              onScale={(scale) => { beginHistoryInteraction(); updateVideoTransform({ scale }); }}
              onRotation={(rotation) => { beginHistoryInteraction(); updateVideoTransform({ rotation }); }}
              onReset={() => {
                beginHistoryInteraction();
                updateVideoTransform({ fit: 'fit', position: { x: 0.5, y: 0.5 }, scale: 1, rotation: 0 });
                queueMicrotask(finishHistoryInteraction);
              }}
              onTransformEnd={finishHistoryInteraction}
            />
            <PersistedHorizontalScroll id="tool:video:add" contentContainerStyle={{ gap: 8 }}>
              <Action label="Add videos" onPress={() => { void addVideosToTimeline(); }} />
              <Action label="Add text layer" onPress={addTextLayer} />
              <Action label="Add sticker/image" onPress={() => void addImageLayer()} />
            </PersistedHorizontalScroll>
          </View>
        ) : activeTool === 'audio' ? (
          <View style={{ gap: 8 }}>
            <PersistedHorizontalScroll id="tool:audio:add" contentContainerStyle={{ gap: 8 }}>
              <Action label="Record voice over" color="#FF4D6D" onPress={() => { transport.pause(); setVoiceoverOpen(true); }} />
              <Action label={selectedClip?.muted ? 'Unmute selected video audio' : 'Mute selected video audio'} disabled={!selectedClip} onPress={() => selectedClip && updateSelectedClip({ muted: !selectedClip.muted })} />
              <Action label="Add audio file" onPress={() => void addAudio('audio-file')} />
              <Action label="Extract from video" onPress={() => void addAudio('video-audio')} />
            </PersistedHorizontalScroll>
            {selectedClip ? <>
              <Text numberOfLines={1} style={{ color: chrome.accent, fontSize: 12, fontWeight: '900' }}>
                VIDEO CLIP AUDIO · {project.sources.find((source) => source.id === selectedClip.sourceId)?.displayName ?? 'Video'}
              </Text>
              <PersistedHorizontalScroll id="tool:audio:clip" contentContainerStyle={{ gap: 8 }}>
                <Action label="Volume −" disabled={selectedClip.muted || selectedClip.volume <= 0} onPress={() => updateSelectedClip({ volume: clamp(selectedClip.volume - 0.1, 0, 1) })} />
                <Action label={`${Math.round(selectedClip.volume * 100)}% volume`} color="#64E8FF" onPress={() => updateSelectedClip({ volume: 1, muted: false })} />
                <Action label="Volume +" disabled={selectedClip.volume >= 1} onPress={() => updateSelectedClip({ volume: clamp(selectedClip.volume + 0.1, 0, 1) })} />
                <Action label={selectedClip.fadeInMs ? 'Remove fade in' : 'Fade in'} onPress={() => updateSelectedClip({ fadeInMs: selectedClip.fadeInMs ? 0 : 500 })} />
                <Action label={selectedClip.fadeOutMs ? 'Remove fade out' : 'Fade out'} onPress={() => updateSelectedClip({ fadeOutMs: selectedClip.fadeOutMs ? 0 : 500 })} />
              </PersistedHorizontalScroll>
            </> : null}
            {selectedAudioClip ? <>
              <Text numberOfLines={1} style={{ color: '#64E8FF', fontSize: 12, fontWeight: '900' }}>SELECTED AUDIO · {project.audioSources.find((source) => source.id === selectedAudioClip.sourceId)?.displayName ?? 'Audio'}</Text>
              <PersistedHorizontalScroll id="tool:audio:selected" contentContainerStyle={{ gap: 8 }}>
                <Action label="Split at playhead" onPress={splitSelectedAudioAtPlayhead} />
                <Action label="Delete audio" danger onPress={removeSelectedAudio} />
                <Action label="Duplicate" onPress={copySelectedAudio} />
                <Action label={selectedAudioClip.muted ? 'Unmute audio' : 'Mute audio'} onPress={() => updateSelectedAudio({ muted: !selectedAudioClip.muted })} />
                <Action label="Volume −" disabled={selectedAudioClip.volume <= 0} onPress={() => updateSelectedAudio({ volume: clamp(selectedAudioClip.volume - 0.1, 0, 1) })} />
                <Action label={`${Math.round(selectedAudioClip.volume * 100)}% volume`} color="#64E8FF" onPress={() => updateSelectedAudio({ volume: 1, muted: false })} />
                <Action label="Volume +" disabled={selectedAudioClip.volume >= 1} onPress={() => updateSelectedAudio({ volume: clamp(selectedAudioClip.volume + 0.1, 0, 1) })} />
                <Action label="Move −0.5s" onPress={() => shiftSelectedAudio(-500)} />
                <Action label="Move +0.5s" onPress={() => shiftSelectedAudio(500)} />
                <Action label={selectedAudioClip.fadeInMs ? 'Remove fade in' : 'Fade in'} onPress={() => updateSelectedAudio({ fadeInMs: selectedAudioClip.fadeInMs ? 0 : 500 })} />
                <Action label={selectedAudioClip.fadeOutMs ? 'Remove fade out' : 'Fade out'} onPress={() => updateSelectedAudio({ fadeOutMs: selectedAudioClip.fadeOutMs ? 0 : 500 })} />
              </PersistedHorizontalScroll>
            </> : null}
            {!selectedClip && !selectedAudioClip ? <Text style={{ color: palette.muted, fontSize: 12 }}>Select a video clip for its embedded audio, add audio, or tap an audio block in the timeline.</Text> : null}
          </View>
        ) : activeTool === 'stickers' ? (
          <View style={{ gap: 12 }}>
            <Text style={{ color: palette.text, fontSize: 13, fontWeight: '700' }}>STICKERS & SCREEN TEXT</Text>
            {selectedTextLayer ? (
              <PersistedHorizontalScroll id="tool:stickers:text" contentContainerStyle={{ gap: 8 }}>
                <Action label="Split at playhead" onPress={splitSelectedVisualAtPlayhead} />
                <Action label="Edit text" onPress={() => { setEditingLayerId(selectedTextLayer.id); setEditingText(selectedTextLayer.text); }} />
                <Action label="Fonts" onPress={() => setFontBrowserOpen(true)} />
                <Action label="Delete text layer" danger onPress={() => deleteLayer(selectedTextLayer.id)} />
                <Action label="Add text layer" onPress={addTextLayer} />
                <Action label="Add sticker/image" onPress={() => void addImageLayer()} />
              </PersistedHorizontalScroll>
            ) : selectedImageLayer ? (
              <PersistedHorizontalScroll id="tool:stickers:image" contentContainerStyle={{ gap: 8 }}>
                <Action label="Split at playhead" onPress={splitSelectedVisualAtPlayhead} />
                <Action label="Delete sticker" danger onPress={() => deleteLayer(selectedImageLayer.id)} />
                <Action label="Add text layer" onPress={addTextLayer} />
                <Action label="Add sticker/image" onPress={() => void addImageLayer()} />
              </PersistedHorizontalScroll>
            ) : (
              <PersistedHorizontalScroll id="tool:stickers:empty" contentContainerStyle={{ gap: 8 }}>
                <Action label="Add text layer" onPress={addTextLayer} />
                <Action label="Add sticker/image" onPress={() => void addImageLayer()} />
              </PersistedHorizontalScroll>
            )}
            {selectedTextLayer ? (
              <View style={{ gap: 9, borderTopWidth: 1, borderTopColor: chrome.hairline, paddingTop: 12 }}>
                <Text style={{ color: palette.text, fontSize: 13, fontWeight: '700' }}>TEXT ANIMATION</Text>
                <AnimationBrowser selected={selectedAnimationId} textLayerSelected scope={animationScope} hasSelectedCaption={false} lineHeight={selectedLineHeight} onScopeChange={setAnimationScope} onSelect={chooseAnimation} onLineHeightStart={beginLineHeightChange} onLineHeightChange={changeLineHeight} onLineHeightEnd={finishLineHeightChange} />
              </View>
            ) : null}
          </View>
        ) : (
          <View style={{ gap: 12 }}>
            <Text style={{ color: palette.text, fontSize: 13, fontWeight: '700' }}>CAPTION CONTROLS</Text>
            {translationTrackSelected && selectedTranslationTrack ? (
              <PersistedHorizontalScroll id="tool:captions:translation" contentContainerStyle={{ gap: 8 }}>
                <Action label="Edit both languages" color={chrome.accent} onPress={() => setDualCaptionEditorOpen(true)} />
                <Action label="Closer together" disabled={(selectedTranslationTrack.stackGap ?? DEFAULT_TRANSLATION_STACK_GAP) <= MIN_TRANSLATION_STACK_GAP} onPress={() => adjustTranslationGap(-0.016)} />
                <Action
                  label={`Distance ${Math.round((selectedTranslationTrack.stackGap ?? DEFAULT_TRANSLATION_STACK_GAP) * 100)}`}
                  color="#64E8FF"
                  onPress={() => {
                    commitTranslationTrackPatch((before) =>
                      setTranslationStackGap(before, selectedTranslationTrack.id, DEFAULT_TRANSLATION_STACK_GAP));
                  }}
                />
                <Action label="Farther apart" disabled={(selectedTranslationTrack.stackGap ?? DEFAULT_TRANSLATION_STACK_GAP) >= MAX_TRANSLATION_STACK_GAP} onPress={() => adjustTranslationGap(0.016)} />
                <Action label="Smaller type" onPress={() => adjustTranslationFontSize(-4)} />
                <Action label={`${Math.round(selectedTranslationPair?.style.fontSize ?? 34)} pt`} color="#64E8FF" onPress={() => setFontBrowserOpen(true)} />
                <Action label="Larger type" onPress={() => adjustTranslationFontSize(4)} />
                <Action label="Fonts" onPress={() => setFontBrowserOpen(true)} />
                <Action label="White" color="#FFFFFF" onPress={() => queueCaptionStyleChange('Translated text color: white', { textColor: '#FFFFFF' })} />
                <Action label="Lime" color="#DFFF35" onPress={() => queueCaptionStyleChange('Translated text color: lime', { textColor: '#DFFF35' })} />
                <Action label="Cyan" color="#64D2FF" onPress={() => queueCaptionStyleChange('Translated text color: cyan', { textColor: '#64D2FF' })} />
                <Action label="Yellow" color="#FFE566" onPress={() => queueCaptionStyleChange('Translated text color: yellow', { textColor: '#FFE566' })} />
                <Action label="Pink" color="#FF8AD4" onPress={() => queueCaptionStyleChange('Translated text color: pink', { textColor: '#FF8AD4' })} />
                <Action label="Uppercase" onPress={() => queueCaptionStyleChange('Uppercase translated captions', { textTransform: 'uppercase' })} />
                {selectedTranslationPair ? <Action label="Refresh this translation" onPress={() => requestTranslationRefresh([selectedTranslationPair.source.id])} /> : null}
                <Action label={selectedTranslationTrack.visible ? 'Hide second language' : 'Show second language'} onPress={() => { void toggleSelectedTranslationTrack(); }} />
                <Action label="Remove second language" danger onPress={confirmRemoveSelectedTranslationTrack} />
              </PersistedHorizontalScroll>
            ) : (
              <PersistedHorizontalScroll id="tool:captions:caption" contentContainerStyle={{ gap: 8 }}>
                <Action label="Edit captions" disabled={timelineCaptions.length === 0} onPress={beginEditCaption} />
                <Action label="Dual subtitles" color={chrome.accent} onPress={openDualCaptionEditor} />
                {selectedCaption ? <Action label="Delete subtitle" danger onPress={() => confirmDeleteCaption(selectedCaption.id)} /> : null}
                <Action label="Fonts" onPress={() => setFontBrowserOpen(true)} />
                <Action label="White" color="#FFFFFF" onPress={() => queueCaptionStyleChange('Text color: white', { textColor: '#FFFFFF' })} />
                <Action label="Lime" color="#DFFF35" onPress={() => queueCaptionStyleChange('Text color: lime', { textColor: '#DFFF35' })} />
                <Action label="Active word" color="#FFC247" onPress={() => queueCaptionStyleChange('Active-word color: amber', { activeWordColor: '#FFC247' })} />
                <Action label="Uppercase" onPress={() => queueCaptionStyleChange('Uppercase captions', { textTransform: 'uppercase' })} />
                <Action
                  label="Reset all caption boxes"
                  onPress={() => {
                    beginHistoryInteraction();
                    updateSharedCaptionTransform({ position: { x: 0.5, y: 0.78 }, box: { width: 0.86, height: 0.2 }, fontSize: 48, rotation: 0, scale: 1, scaleX: 1, scaleY: 1 });
                    queueMicrotask(finishHistoryInteraction);
                  }}
                />
              </PersistedHorizontalScroll>
            )}
            <View style={{ gap: 9, borderTopWidth: 1, borderTopColor: chrome.hairline, paddingTop: 12 }}>
              <Text style={{ color: palette.text, fontSize: 13, fontWeight: '700' }}>CAPTION ANIMATION</Text>
              <AnimationBrowser
                selected={selectedAnimationId}
                scope={animationScope}
                hasSelectedCaption={Boolean(selectedCaptionId)}
                lineHeight={selectedLineHeight}
                onScopeChange={setAnimationScope}
                onSelect={chooseAnimation}
                onLineHeightStart={beginLineHeightChange}
                onLineHeightChange={changeLineHeight}
                onLineHeightEnd={finishLineHeightChange}
              />
            </View>
          </View>
        )}

        {captionInterruptionMessage || error || persistenceError || translationController.error ? (
          <View style={{ padding: 12, borderRadius: 13, backgroundColor: '#351D24' }}>
            <Text selectable accessibilityRole="alert" style={{ color: '#FFBBC8', fontSize: 13 }}>{captionInterruptionMessage ?? error ?? persistenceError ?? translationController.error}</Text>
          </View>
        ) : null}

        </ScrollView>

        <View
          style={{
            flexDirection: 'row',
            gap: 6,
            paddingHorizontal: 12,
            paddingVertical: 10,
            paddingBottom: Math.max(14, insets.bottom),
            borderTopWidth: 1,
            borderTopColor: '#20262D',
          }}>
          <ToolbarItem label="Stickers" active={activeTool === 'stickers'} onPress={() => openEditorTool('stickers')} />
          <ToolbarItem label="Fonts" active={fontBrowserOpen} onPress={() => setFontBrowserOpen(true)} />
          <ToolbarItem label="Captions" active={activeTool === 'captions'} onPress={() => openEditorTool('captions')} />
          <ToolbarItem label="Video" active={activeTool === 'video'} onPress={() => openEditorTool('video')} />
          <ToolbarItem label="Audio" active={activeTool === 'audio'} onPress={() => openEditorTool('audio')} />
          <ToolbarItem label="Watermark" active={watermarkOpen} onPress={() => setWatermarkOpen(true)} />
          <ToolbarItem label="Export" disabled={exporting} onPress={showExportMenu} />
        </View>
      </View>

      <ScopeSheet
        visible={Boolean(pendingChange)}
        changeLabel={pendingChange?.label ?? ''}
        hasSelectedCaption={Boolean(selectedCaptionId)}
        onChoose={chooseStyleScope}
        onClose={() => setPendingChange(undefined)}
      />
      <ExtractAudioSourceSheet
        visible={extractAudioOpen}
        sources={project.sources}
        busy={extractAudioBusy}
        onChoose={(sourceId) => { void addProjectVideoAudio(sourceId); }}
        onChooseAnother={() => { void addProjectVideoAudio(); }}
        onClose={() => { if (!extractAudioBusy) setExtractAudioOpen(false); }}
      />
      <WatermarkSheet
        visible={watermarkOpen}
        watermarks={project.layers.filter((layer): layer is TextVisualLayer => layer.kind === 'text' && Boolean(layer.watermark))}
        maxWatermarks={MAX_PROJECT_WATERMARKS}
        onAdd={addWatermark}
        onSelect={(layerId) => { setWatermarkOpen(false); selectEditorObject({ kind: 'text', id: layerId }); }}
        onRemove={removeWatermark}
        onClose={() => setWatermarkOpen(false)}
      />
      <TransitionTimingSheet
        visible={transitionTimingOpen}
        durationMs={selectedClip?.transitionAfter.durationMs ?? 0}
        onChoose={(durationMs) => {
          if (selectedClip && selectedClip.transitionAfter.type !== 'none') applyTransition(selectedClip.transitionAfter.type, durationMs);
          setTransitionTimingOpen(false);
        }}
        onClose={() => setTransitionTimingOpen(false)}
      />
      <ExtractAudioBusyOverlay visible={extractAudioBusy} />
      <FontBrowser
        visible={fontBrowserOpen}
        previewText={selectedTextLayer?.text ?? selectedTranslationPair?.translation.text ?? selectedCaption?.text ?? activeCaption?.text ?? 'Make every word count'}
        onClose={() => setFontBrowserOpen(false)}
        onSelect={chooseFont}
        onBackRequestChange={registerFontBrowserBackRequest}
      />
      <ScriptEditor
        visible={scriptEditorOpen}
        projectId={project.id}
        baseRevision={project.updatedAt}
        captions={timelineCaptions}
        words={project.transcription.words}
        initialCaptionId={selectedCaptionId ?? activeCaption?.id}
        currentMs={currentMs}
        isPlaying={isPlaying}
        onSeekTimeline={seekTimeline}
        onBackRequestChange={registerScriptBackRequest}
        onDraftChange={setScriptDraftCaptions}
        onKeyboardChange={setScriptKeyboardOpen}
        onEditingCaptionChange={setScriptEditingCaptionId}
        onSelectCaption={(caption) => {
          transport.pause();
          setSelectedLayerId('captions');
          setSelectedCaptionId(caption.id);
          setSelectedClipId(undefined);
          openEditorTool('captions');
        }}
        onCancel={scriptExit.close}
        onSave={commitCaptionScript}
      />
      <DualCaptionEditor
        key={selectedTranslationTrack?.id ?? 'none'}
        visible={dualCaptionEditorOpen && Boolean(selectedTranslationTrack)}
        projectId={project.id}
        baseRevision={project.updatedAt}
        trackId={selectedTranslationTrack?.id ?? 'none'}
        sourceLanguageLabel={captionLanguageLabel(primaryCaptionLanguage)}
        targetLanguageLabel={selectedTranslationTrack?.displayName ?? 'Second language'}
        pairs={selectedTranslationTrack ? resolveCaptionPairs(project, selectedTranslationTrack.id).filter((pair) => pair.timelineVisible || (pair.translation.translationSkipped && (pair.translation.timelineVisible ?? pair.source.timelineVisible !== false))) : []}
        trackVisible={selectedTranslationTrack?.visible ?? false}
        automaticTranslation={Boolean(
          selectedTranslationTrack
          && canAutomaticallyTranslatePair(primaryCaptionLanguage, selectedTranslationTrack.languageTag),
        )}
        busy={Boolean(translationProgress) || translationCancelling}
        progressLabel={translationCancelling ? 'Cancelling local translation…' : translationProgressLabel(translationProgress)}
        errorMessage={translationController.error}
        retryErrorAvailable={translationController.retryAvailable}
        onDismissError={translationController.clearError}
        onRetryError={() => { void translationController.retry(); }}
        onBackRequestChange={registerDualCaptionBackRequest}
        onClose={() => {
          if (!translationProgress && !translationCancelling) setDualCaptionEditorOpen(false);
        }}
        onSave={saveDualCaptionEdits}
        onRefresh={requestTranslationRefresh}
        onSkip={(id, skipped) => { void setSelectedTranslationSkipped(id, skipped); }}
        onToggleVisibility={() => { void toggleSelectedTranslationTrack(); }}
        onRemove={confirmRemoveSelectedTranslationTrack}
        onCancelBusy={() => { void cancelDualCaptionTranslation(); }}
      />
      <DualLanguagePicker
        visible={dualLanguagePickerOpen}
        sourceLanguageTag={primaryCaptionLanguage}
        sourceLanguageLabel={captionLanguageLabel(primaryCaptionLanguage)}
        automaticModelLabel={NATURAL_TRANSLATION_MODEL_LABEL}
        onBackRequestChange={registerLanguagePickerBackRequest}
        onClose={() => setDualLanguagePickerOpen(false)}
        onChoose={(choice) => enableDualCaptions(choice.tag)}
      />
      <EditTextLayerModal
        visible={Boolean(editingLayerId)}
        originalValue={selectedTextLayer?.text ?? ''}
        value={editingText ?? ''}
        onBackRequestChange={registerTextLayerBackRequest}
        onChange={setEditingText}
        onCancel={() => {
          setEditingLayerId(undefined);
          setEditingText(undefined);
        }}
        onSave={commitTextLayerText}
      />
      <ProgressOverlay
        progress={progress}
        cancelling={transcriptionCancelling}
        onCancel={() => { void cancelCaptionGeneration(); }}
      />
      <MediaLoadingOverlay progress={mediaProgress} />
      <PlaybackLoadingOverlay phase={transport.phase} hasPresentedFrame={transport.hasPresentedFrame} admitted={runtimePolicy.mediaAdmitted} />
      {exporting ? (
        <Modal visible transparent animationType="fade" onRequestClose={() => {
          if (exportKind === 'video') void cancelProjectVideoExport();
        }}>
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, backgroundColor: 'rgba(0,0,0,0.78)' }}>
            <View style={{ width: '100%', maxWidth: 380, gap: 14, padding: 22, borderRadius: 20, backgroundColor: palette.surfaceRaised }}>
              <ActivityIndicator color={palette.accent} size="large" />
              <Text style={{ color: palette.text, textAlign: 'center', fontSize: 18, fontWeight: '900' }}>
                {exportKind === 'video' ? 'Rendering on this phone' : 'Preparing subtitle file'}
              </Text>
              <Text style={{ color: palette.muted, textAlign: 'center', lineHeight: 20 }}>
                {exportKind === 'video'
                  ? 'Compositing clips, captions, layers, transitions, audio, and any replacement background into the final MP4. Keep Caption Studio open.'
                  : 'Creating the subtitle file and opening Android’s save or share choices.'}
              </Text>
              {exportKind === 'video' && exportProgress ? (
                <View style={{ gap: 7 }}>
                  <View style={{ height: 8, overflow: 'hidden', borderRadius: chrome.radius.pill, backgroundColor: chrome.fill }}>
                    <View style={{ width: `${exportProgress.percent ?? 0}%`, height: '100%', backgroundColor: palette.accent }} />
                  </View>
                  <Text style={{ color: palette.text, textAlign: 'center', fontVariant: ['tabular-nums'] }}>
                    {exportProgressLabel(exportProgress)}
                  </Text>
                </View>
              ) : null}
              {exportKind === 'video' ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Cancel video export"
                  onPress={() => { void cancelProjectVideoExport(); }}
                  style={{ minHeight: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 13, backgroundColor: '#2A3038' }}>
                  <Text style={{ color: '#FFBBC8', fontWeight: '800' }}>Cancel export</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
    </PersistedHorizontalScrollScope>
  );
}

function Action(props: { label: string; color?: string; danger?: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      disabled={props.disabled}
      onPress={props.onPress}
      style={{
        minHeight: 44,
        paddingHorizontal: 14,
        flexDirection: 'row',
        gap: 7,
        alignItems: 'center',
        borderRadius: chrome.radius.md,
        borderWidth: props.danger ? 1 : 0,
        borderColor: props.danger ? chrome.dangerFill : 'transparent',
        backgroundColor: props.danger ? chrome.dangerFill : palette.surfaceRaised,
        opacity: props.disabled ? 0.35 : 1,
      }}>
      {props.color ? <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: props.color }} /> : null}
      <Text style={{ color: props.danger ? '#FFBBC8' : palette.text, fontSize: 12, fontWeight: '700' }}>{props.label}</Text>
    </Pressable>
  );
}

function TransitionTimingSheet(props: { visible: boolean; durationMs: number; onChoose: (durationMs: number) => void; onClose: () => void }) {
  const options = [200, 350, 500, 650, 800, 1_000, 1_250, 1_500, 2_000];
  return (
    <Modal visible={props.visible} transparent animationType="slide" onRequestClose={props.onClose}>
      <Pressable onPress={props.onClose} style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.58)' }}>
        <Pressable onPress={(event) => event.stopPropagation()} style={{ gap: 12, padding: 18, paddingBottom: 34, borderTopLeftRadius: chrome.radius.xl, borderTopRightRadius: chrome.radius.xl, backgroundColor: chrome.surface }}>
          <Text style={{ color: chrome.text, fontSize: 20, fontWeight: '800' }}>Transition timing</Text>
          <Text style={{ color: chrome.muted, fontSize: 12, lineHeight: 17 }}>Choose how long the selected transition plays.</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {options.map((durationMs) => (
              <Pressable key={durationMs} onPress={() => props.onChoose(durationMs)} style={{ minWidth: '30%', minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: chrome.radius.md, borderWidth: durationMs === props.durationMs ? 2 : 1, borderColor: durationMs === props.durationMs ? chrome.accent : chrome.hairline, backgroundColor: chrome.surfaceRaised }}>
                <Text style={{ color: durationMs === props.durationMs ? chrome.accent : chrome.text, fontSize: 13, fontWeight: '800' }}>{durationMs < 1_000 ? `${durationMs} ms` : `${durationMs / 1_000} sec`}</Text>
              </Pressable>
            ))}
          </View>
          <Action label="Cancel" onPress={props.onClose} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function HistoryButton(props: { label: string; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label.replace(/[↶↷]/g, '').trim()}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{ minWidth: 108, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: chrome.radius.md, borderWidth: 0, backgroundColor: props.disabled ? chrome.surface : chrome.purpleFill, opacity: props.disabled ? 0.45 : 1 }}>
      <Text style={{ color: props.disabled ? chrome.muted : chrome.purpleText, fontSize: 15, fontWeight: '600' }}>{props.label}</Text>
    </Pressable>
  );
}

function ExtractAudioBusyOverlay(props: { visible: boolean }) {
  if (!props.visible) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => {}}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, backgroundColor: chrome.overlay }}>
        <View style={{ width: '100%', maxWidth: 360, alignItems: 'center', gap: 14, padding: 24, borderRadius: chrome.radius.xl, backgroundColor: chrome.surface }}>
          <ActivityIndicator size="large" color={chrome.accent} />
          <Text style={{ color: chrome.text, fontSize: 20, fontWeight: '700', textAlign: 'center' }}>Preparing audio locally</Text>
          <Text style={{ color: chrome.muted, fontSize: 15, lineHeight: 21, textAlign: 'center' }}>
            Extracting, validating, and building the waveform on this phone. Playback starts when the audio is ready. Keep Caption Studio open.
          </Text>
        </View>
      </View>
    </Modal>
  );
}

function ToolbarItem(props: { label: string; active?: boolean; disabled?: boolean; onPress?: () => void }) {
  return (
    <Pressable
      disabled={props.disabled}
      onPress={props.onPress}
      style={{ flex: 1, alignItems: 'center', gap: 4, opacity: props.disabled ? 0.35 : 1 }}>
      <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: props.active ? palette.accent : 'transparent' }} />
      <Text style={{ color: props.active ? palette.accent : palette.text, fontSize: 10, fontWeight: '600' }}>{props.label}</Text>
    </Pressable>
  );
}

function ProgressOverlay(props: {
  progress?: TranscriptionProgress;
  cancelling: boolean;
  onCancel: () => void;
}) {
  if (!props.progress) return null;
  const percent = Math.round(props.progress.progress * 100);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => { if (!props.cancelling) props.onCancel(); }}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 26, backgroundColor: 'rgba(0,0,0,0.82)' }}>
        <View style={{ width: '100%', maxWidth: 380, gap: 16, padding: 24, borderRadius: chrome.radius.xl, backgroundColor: chrome.surface }}>
          <ActivityIndicator color={palette.accent} size="large" />
          <Text style={{ color: palette.text, textAlign: 'center', fontSize: 20, fontWeight: '800' }}>
            {stageTitle(props.progress.stage)}
          </Text>
          <Text style={{ color: palette.muted, textAlign: 'center', fontSize: 14 }}>{props.progress.detail}</Text>
          <Text style={{ color: palette.text, textAlign: 'center', lineHeight: 20 }}>
            {props.progress.stage === 'downloading-model'
              ? 'take a little breath — your local AI is settling onto this phone; it can take a bit, and that’s okay; you only wait through this once.'
              : 'Keep Caption Studio open and the phone unlocked until this finishes.'}
          </Text>
          <View style={{ height: 8, overflow: 'hidden', borderRadius: chrome.radius.pill, backgroundColor: chrome.fill }}>
            <View style={{ width: `${percent}%`, height: '100%', backgroundColor: palette.accent }} />
          </View>
          <Text style={{ color: palette.text, textAlign: 'center', fontVariant: ['tabular-nums'] }}>{percent}%</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel caption generation"
            disabled={props.cancelling}
            onPress={props.onCancel}
            style={{ minHeight: 46, alignItems: 'center', justifyContent: 'center', borderRadius: chrome.radius.md, backgroundColor: chrome.fill, opacity: props.cancelling ? 0.55 : 1 }}>
            <Text style={{ color: '#FFBBC8', fontWeight: '800' }}>
              {props.cancelling ? 'Stopping…' : 'Cancel'}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function EditTextLayerModal(props: {
  visible: boolean;
  originalValue: string;
  value: string;
  onBackRequestChange: (request: (() => void) | undefined) => void;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { onBackRequestChange, onCancel, originalValue, value, visible } = props;
  const requestClose = useCallback(() => {
    if (value === originalValue) {
      onCancel();
      return;
    }
    Alert.alert('Discard unsaved text edits?', 'The text layer will keep its previous wording.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: onCancel },
    ]);
  }, [onCancel, originalValue, value]);
  useEffect(() => {
    onBackRequestChange(visible ? requestClose : undefined);
    return () => onBackRequestChange(undefined);
  }, [onBackRequestChange, requestClose, visible]);
  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={requestClose}>
      <View style={{ flex: 1, justifyContent: 'center', padding: 24, backgroundColor: 'rgba(0,0,0,0.72)' }}>
        <View style={{ gap: 14, padding: 20, borderRadius: chrome.radius.xl, backgroundColor: chrome.surface }}>
          <Text style={{ color: palette.text, fontSize: 20, fontWeight: '800' }}>Edit text layer</Text>
          <TextInput
            autoFocus
            multiline
            value={props.value}
            onChangeText={props.onChange}
            style={{ minHeight: 110, padding: 14, borderRadius: chrome.radius.md, color: palette.text, backgroundColor: chrome.surfaceRaised, textAlignVertical: 'top' }}
          />
          <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'flex-end' }}>
            <Pressable onPress={requestClose} style={{ padding: 12 }}>
              <Text style={{ color: palette.muted }}>Cancel</Text>
            </Pressable>
            <Pressable onPress={props.onSave} style={{ paddingHorizontal: 18, paddingVertical: 12, borderRadius: chrome.radius.pill, backgroundColor: palette.accent }}>
              <Text style={{ color: chrome.accentInk, fontWeight: '700' }}>Save</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function stageTitle(stage: TranscriptionProgress['stage']) {
  switch (stage) {
    case 'preparing-audio': return 'Preparing audio';
    case 'downloading-model': return 'Getting offline model';
    case 'detecting-speech': return 'Finding speech';
    case 'transcribing': return 'Generating captions';
    case 'grouping': return 'Building timeline';
  }
}

function formatTime(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

function formatSeconds(ms: number) {
  return `${(Math.max(0, ms) / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function formatMegabytes(bytes: number) {
  return `${Math.ceil(bytes / (1024 * 1024))} MB`;
}

const VOICEOVER_RECORDING_OPTIONS = {
  directory: 'cache' as const,
  extension: '.m4a',
  sampleRate: 44_100,
  numberOfChannels: 1,
  bitRate: 128_000,
  isMeteringEnabled: true,
  android: {
    outputFormat: 'mpeg4' as const,
    audioEncoder: 'aac' as const,
  },
};

function VoiceoverControls(props: {
  recording: boolean;
  saving: boolean;
  playing: boolean;
  onTogglePlayback: () => void;
  onStart: () => void;
  onStop: () => void;
  onClose: () => void;
}) {
  return <View style={{ gap: 8, padding: 10, borderRadius: 18, backgroundColor: '#15191E', borderWidth: 1, borderColor: '#FF6D83' }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
      <Text style={{ color: '#F7F8FA', fontSize: 11, fontWeight: '900' }}>VOICE-OVER · LIVE TIMELINE</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Exit voice-over recording" onPress={props.onClose} style={{ minHeight: 42, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 12, backgroundColor: '#FFE7EC', borderWidth: 1, borderColor: '#FF4D6D' }}><Text style={{ color: '#B7153A', fontSize: 12, fontWeight: '900' }}>Exit voice-over</Text></Pressable>
    </View>
    <Text style={{ color: '#B7C2CC', fontSize: 11 }}>Record on the live second track. The video timeline remains available for scrubbing and positioning.</Text>
    <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 10 }}>
      <Pressable accessibilityRole="button" onPress={props.onTogglePlayback} style={{ minWidth: 96, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20, backgroundColor: '#25313B' }}><Text style={{ color: '#FFFFFF', textAlign: 'center', fontSize: 12, fontWeight: '900' }}>{props.playing ? 'Pause video' : 'Play video'}</Text></Pressable>
      <Pressable accessibilityRole="button" disabled={props.saving} onPress={props.recording ? props.onStop : props.onStart} style={{ minWidth: 178, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20, backgroundColor: props.recording ? '#FFFFFF' : '#FF4D6D', opacity: props.saving ? 0.6 : 1 }}><Text style={{ color: props.recording ? '#D71345' : '#FFFFFF', textAlign: 'center', fontSize: 12, fontWeight: '900' }}>{props.saving ? 'Saving take…' : props.recording ? 'Stop, add take, and exit' : 'Start recording'}</Text></Pressable>
    </View>
  </View>;
}

function recordingMeterLevel(metering: number | undefined) {
  if (!Number.isFinite(metering)) return 0.05;
  return clamp(((metering ?? -120) + 120) / 120, 0.05, 1);
}

function translationProgressLabel(progress?: CaptionTranslationProgress) {
  if (!progress) return undefined;
  if (progress.progress == null) return progress.detail;
  return `${progress.detail} · ${Math.round(progress.progress * 100)}%`;
}

function exportProgressLabel(progress: ProjectVideoExportProgress) {
  if (progress.stage === 'publishing') return 'Saving to media library · 99%';
  if (progress.stage === 'preparing') return 'Preparing renderer';
  if (progress.percent == null) return 'Rendering video';
  return `Rendering video · ${progress.percent}%`;
}

const HISTORY_MAX_ENTRIES = 24;
const HISTORY_MAX_ESTIMATED_BYTES = 16 * 1024 * 1024;
const TRANSLATION_PHRASE_ANIMATIONS = new Set<CaptionAnimationId>([
  'none',
  'fade-in',
  'slide-up',
  'slide-left',
  'zoom-in',
  'spin-in',
  'elastic',
  'flip',
  'stomp',
  'drop-in',
  'swing',
  'heartbeat',
  'flicker',
  'tilt-in',
  'squash',
  'stretch',
]);
const historySizeCache = new WeakMap<CaptionProject, number>();

function estimatedHistoryBytes(project: CaptionProject) {
  const cached = historySizeCache.get(project);
  if (cached != null) return cached;
  const size = JSON.stringify(project).length * 2;
  historySizeCache.set(project, size);
  return size;
}

function trimHistoryStack(stack: CaptionProject[]) {
  if (stack.length > HISTORY_MAX_ENTRIES) stack.splice(0, stack.length - HISTORY_MAX_ENTRIES);
  let total = 0;
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    total += estimatedHistoryBytes(stack[index]);
    if (total > HISTORY_MAX_ESTIMATED_BYTES) {
      stack.splice(0, index + 1);
      break;
    }
  }
}

function captionPreviewCrop(
  aspect: number,
  viewportWidth: number,
  viewportHeight: number,
  position: { x: number; y: number },
) {
  aspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const viewport = {
    width: Math.max(0, Number.isFinite(viewportWidth) ? viewportWidth : 0),
    height: Math.max(0, Number.isFinite(viewportHeight) ? viewportHeight : 0),
  };
  // Cover the crop window at full width rather than containing the complete
  // canvas in the keyboard strip. Only the camera offset follows the caption.
  const canvas = { width: Math.max(viewport.width, viewport.height * aspect), height: 0 };
  canvas.height = canvas.width / aspect;
  const x = Number.isFinite(position.x) ? position.x : 0.5;
  const y = Number.isFinite(position.y) ? position.y : 0.5;
  return {
    canvas,
    viewport,
    x: -clamp(x * canvas.width - viewport.width / 2, 0, canvas.width - viewport.width),
    y: -clamp(y * canvas.height - viewport.height / 2, 0, canvas.height - viewport.height),
  };
}

function fitRect(aspect: number, maxWidth: number, maxHeight: number) {
  aspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  maxWidth = Math.max(0, maxWidth);
  maxHeight = Math.max(0, maxHeight);
  let width = maxWidth;
  let height = width / aspect;
  if (height > maxHeight) {
    height = maxHeight;
    width = height * aspect;
  }
  return { width, height };
}

function uniqueId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
