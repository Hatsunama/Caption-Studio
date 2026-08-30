import { useEffect, useMemo, useRef, useState } from 'react';
import type { NavigationAction } from '@react-navigation/native';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { VideoView } from 'expo-video';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { TimelineVideoExportProgress } from 'caption-media';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { AnimationBrowser } from '@/components/editor/animation-browser';
import { BackgroundTools } from '@/components/editor/background-tools';
import { CaptionOverlay } from '@/components/editor/caption-overlay';
import { DualCaptionEditor } from '@/components/editor/dual-caption-editor';
import { FontBrowser } from '@/components/editor/font-browser';
import { ExtractAudioSourceSheet } from '@/components/editor/extract-audio-source-sheet';
import { ImageLayerOverlay } from '@/components/editor/image-layer-overlay';
import { LayerTimeline } from '@/components/editor/layer-timeline';
import { MediaLoadingOverlay } from '@/components/media-loading-overlay';
import { ScopeSheet } from '@/components/editor/scope-sheet';
import { ScriptEditor } from '@/components/editor/script-editor';
import { VideoTools } from '@/components/editor/video-tools';
import { VideoTransformOverlay } from '@/components/editor/video-transform-overlay';
import { VideoTransitionOverlay } from '@/components/editor/video-transition-overlay';
import { useTimelineVideoController } from '@/hooks/use-timeline-video-controller';
import { useTimelineAudioController } from '@/hooks/use-timeline-audio-controller';
import { useProjectCaptionTranslation } from '@/hooks/use-project-caption-translation';
import { useEditorRuntimePolicy } from '@/hooks/use-editor-runtime-policy';
import { deleteAudioClip, duplicateAudioClip, moveAudioClip, trimAudioClip, updateAudioClip } from '@/lib/audio-timeline';
import { findAnimationPreset } from '@/lib/animation-presets';
import { normalizeEnglishChineseCaptionLanguage } from '@/lib/caption-languages';
import {
  projectEnglishChineseCaptionLanguage,
  removeTranslationCaptionTrack,
  resolveCaptionPairs,
  setTranslationCueStyle,
  setTranslationTrackStyle,
  setTranslationTrackVisibility,
} from '@/lib/caption-tracks';
import { deletePersonKeyframe, resolvePersonTransform, upsertPersonKeyframe } from '@/lib/person-motion';
import {
  collectLinkedMediaUris,
  collectProjectOwnedUris,
  createLinkedMediaPermissionLedger,
  createProjectOwnedAssetLedger,
  trackLinkedMediaPermissions,
  trackProjectOwnedAssets,
} from '@/lib/media-lifecycle';
import {
  mergeCaptionScriptBlock,
  splitCaptionScriptBlockAtTime,
  type CaptionScriptMutation,
} from '@/lib/caption-script';
import { fontChoicePatch, type FontChoice } from '@/lib/font-catalog';
import { TRANSCRIPTION_MODELS, type TranscriptionModel } from '@/lib/model-catalog';
import { canApplyVideoTransition, VIDEO_TRANSITION_PRESETS } from '@/lib/video-transitions';
import {
  addImageLayer as addImageLayerToProject,
  createTextLayer,
  deleteCaptionBlock,
  deleteVideoClip,
  deleteVisualLayer,
  moveVisualLayer,
  setCanvasPreset as applyCanvasPreset,
  setBackgroundReplacement as applyBackgroundReplacement,
  replaceVisibleCaptionScript,
  setCaptionTiming,
  setImageLayer,
  setLayerTiming,
  setTextLayerStyle,
  setTextLayerText,
  setVideoClipGap,
  setVideoClipTransform,
  setVideoTransition,
  moveVideoClip,
  splitVideoClip,
  trimVideoClip,
  updateVideoClip,
} from '@/lib/project-editor';
import { applyStylePatch, resolveCaptionStyle, type StyleScope } from '@/lib/style-resolver';
import {
  buildClipTimeline,
  setClipPlaybackRate,
  timelineEntryAt,
  sourceTimeAt,
  totalClipDuration,
  visibleTimelineCaptions,
} from '@/lib/video-timeline';
import {
  hasBackgroundProcessingConsent,
  setBackgroundProcessingConsent,
} from '@/services/background-processing-consent';
import { pickAndStoreImage, pickBackgroundMedia, type MediaImportProgress } from '@/services/media-import';
import { releasePersonPreview, renderPersonPreview } from '@/services/person-compositor';
import { cancelProjectVideoExport, exportProjectVideo, exportSubtitleFile, getProjectVideoExportProgress, userFacingExportError } from '@/services/project-export';
import { validateProjectSources } from '@/services/project-media';
import {
  appendVideosToProject,
  appendAudioToProject,
  appendProjectVideoAudioToProject,
  cancelProjectCaptionGeneration,
  checkpointEditorProject,
  discardEditorSession,
  generateAndSaveProjectCaptions,
  loadProjectForEditing,
  saveEditorDraft,
} from '@/services/project-workflows';
import { CaptionGenerationCancelledError } from '@/services/caption-generation-session';
import {
  NATURAL_TRANSLATION_MODEL,
  type CaptionTranslationProgress,
} from '@/services/caption-translation';
import {
  changedPrimaryCaptionTextIds,
  prepareOptionalDualCaptionTrack,
  type DualCaptionTextEdit,
} from '@/services/project-caption-translation';
import {
  ProjectPersistenceError,
  publishProjectAfterDurableSave,
} from '@/services/project-persistence';
import { VideoExportCancelledError } from '@/services/video-export-session';
import type { TranscriptionProgress } from '@/services/transcription';
import {
  type CaptionAnimationId,
  type CaptionProject,
  type CaptionStylePatch,
  type ImageVisualLayer,
  type VideoClip,
  type VideoTransformPatch,
  type AudioClip,
} from '@/types/project';

const palette = {
  background: '#090B0E',
  surface: '#151A20',
  surfaceRaised: '#20262E',
  text: '#F7F8FA',
  muted: '#939EAB',
  accent: '#DFFF35',
  purple: '#A985F8',
};

type PendingStyleChange = {
  label: string;
  patch: CaptionStylePatch;
  translationTrackId?: string;
};

type EditorTool = 'captions' | 'fonts' | 'animate' | 'video' | 'audio';

export default function EditorScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const [initialProject, setInitialProject] = useState<CaptionProject>();
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    let active = true;
    void loadProjectForEditing(projectId)
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
  const [project, setProject] = useState(initialProject);
  const projectRef = useRef(project);
  const ownedAssetLedgerRef = useRef(createProjectOwnedAssetLedger(initialProject));
  const linkedPermissionLedgerRef = useRef(createLinkedMediaPermissionLedger(initialProject));

  useEffect(() => {
    projectRef.current = project;
  }, [project]);
  const [selectedCaptionId, setSelectedCaptionId] = useState<string>();
  const [selectedLayerId, setSelectedLayerId] = useState('captions');
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
  const [dualCaptionEditorOpen, setDualCaptionEditorOpen] = useState(false);
  const [selectedTranslationTrackId, setSelectedTranslationTrackId] = useState<string>();
  const [personPreviewUri, setPersonPreviewUri] = useState<string>();
  const [personPreviewBusy, setPersonPreviewBusy] = useState(false);
  const [backgroundProcessingAllowed, setBackgroundProcessingAllowed] = useState<boolean>();
  const [activeTool, setActiveTool] = useState<EditorTool>('captions');
  const [exporting, setExporting] = useState(false);
  const [exportKind, setExportKind] = useState<'video' | 'subtitle'>('video');
  const [exportProgress, setExportProgress] = useState<TimelineVideoExportProgress>();
  const [animationScope, setAnimationScope] = useState<StyleScope>('all');
  const [extractAudioOpen, setExtractAudioOpen] = useState(false);
  const [extractAudioBusy, setExtractAudioBusy] = useState(false);
  const undoStackRef = useRef<CaptionProject[]>([]);
  const redoStackRef = useRef<CaptionProject[]>([]);
  const interactionStartRef = useRef<CaptionProject | undefined>(undefined);
  const [historyVersion, setHistoryVersion] = useState(0);
  const workspaceMountedRef = useRef(true);
  const exitApprovedRef = useRef(false);
  const exitPromptOpenRef = useRef(false);
  const pendingExitActionRef = useRef<NavigationAction | undefined>(undefined);
  const backgroundConsentRequestRef = useRef<Promise<boolean> | undefined>(undefined);
  const blockingUi = Boolean(
    fontBrowserOpen
    || pendingChange
    || editingLayerId
    || scriptEditorOpen
    || dualCaptionEditorOpen
    || progress
    || mediaProgress
    || exporting
    || extractAudioOpen,
  );
  const runtimePolicy = useEditorRuntimePolicy(blockingUi);

  useEffect(() => {
    let active = true;
    void hasBackgroundProcessingConsent()
      .then((granted) => { if (active) setBackgroundProcessingAllowed(granted); })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : 'The background-removal privacy choice could not be loaded.');
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!exporting || exportKind !== 'video') return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await getProjectVideoExportProgress();
        if (active) setExportProgress(next);
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

  const persistProject = async (next: CaptionProject) => {
    try {
      const persisted = await checkpointEditorProject(next);
      setPersistenceError(undefined);
      return persisted;
    } catch (caught) {
      const message = caught instanceof ProjectPersistenceError
        ? caught.message
        : 'Project changes were not saved. Check available storage and try again.';
      setPersistenceError(message);
      throw caught;
    }
  };

  const persistProjectInBackground = (next: CaptionProject) => {
    void persistProject(next).catch(() => undefined);
  };

  const commitPersistedProject = async (
    next: CaptionProject,
    publish: (persisted: CaptionProject) => void,
  ) => {
    try {
      const persisted = await publishProjectAfterDurableSave(next, publish);
      setPersistenceError(undefined);
      return persisted;
    } catch (caught) {
      if (caught instanceof ProjectPersistenceError) {
        setPersistenceError(caught.message);
      } else {
        setError(caught instanceof Error ? caught.message : 'The project view could not be updated after saving.');
      }
      throw caught;
    }
  };

  const transport = useTimelineVideoController(project, setError);
  const { player, currentMs, isPlaying } = transport;
  useTimelineAudioController(project, currentMs, isPlaying, runtimePolicy.mediaAdmitted);
  const pauseTransport = transport.pause;

  useEffect(() => {
    if (!runtimePolicy.mediaAdmitted) pauseTransport();
  }, [pauseTransport, runtimePolicy.mediaAdmitted]);

  useEffect(() => navigation.addListener('beforeRemove', (event) => {
    if (exitApprovedRef.current) return;
    event.preventDefault();
    if (exitPromptOpenRef.current) return;
    exitPromptOpenRef.current = true;
    pendingExitActionRef.current = event.data.action;
    pauseTransport();
    const finishExit = async (decision: 'save' | 'discard') => {
      try {
        if (decision === 'save') {
          const saved = await saveEditorDraft(projectRef.current, {
            owned: ownedAssetLedgerRef.current,
            linked: linkedPermissionLedgerRef.current,
          });
          projectRef.current = saved;
          setProject(saved);
        } else {
          await discardEditorSession(initialProject, projectRef.current, {
            owned: ownedAssetLedgerRef.current,
            linked: linkedPermissionLedgerRef.current,
          });
        }
        exitApprovedRef.current = true;
        const action = pendingExitActionRef.current;
        if (action) navigation.dispatch(action);
      } catch (caught) {
        exitPromptOpenRef.current = false;
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
  }), [initialProject, navigation, pauseTransport]);

  const clipTimeline = useMemo(() => buildClipTimeline(project.clips), [project.clips]);
  const timelineDurationMs = totalClipDuration(project.clips);
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
  const activeCaption = useMemo(
    () => timelineCaptions.find((caption) => currentMs >= caption.startMs && currentMs < caption.endMs),
    [currentMs, timelineCaptions],
  );
  const selectedCaption = timelineCaptions.find((caption) => caption.id === selectedCaptionId);
  const selectedClip = project.clips.find((clip) => clip.id === selectedClipId);
  const selectedClipIndex = project.clips.findIndex((clip) => clip.id === selectedClipId);
  const transitionBoundaryAvailable = canApplyVideoTransition(project.clips, selectedClipIndex);
  const selectedAudioClip = project.audioClips.find((clip) => clip.id === selectedAudioClipId);
  const selectedLayer = project.layers.find((layer) => layer.id === selectedLayerId);
  const selectedTextLayer = selectedLayer?.kind === 'text' ? selectedLayer : undefined;
  const selectedImageLayer = selectedLayer?.kind === 'image' ? selectedLayer : undefined;
  const translationTrackSelected = selectedTranslationTrack?.id === selectedLayerId;
  const selectedTranslationPair = translationTrackSelected
    ? selectedTranslationPairs.find((pair) => pair.source.id === selectedCaptionId)
    : undefined;
  const selectedAnimationId = selectedTextLayer
    ? selectedTextLayer.style.animation.id
    : selectedTranslationPair
      ? selectedTranslationPair.style.animation.id
    : selectedCaption
      ? resolveCaptionStyle(project.projectStyle, selectedCaption).animation.id
      : project.projectStyle.animation.id;
  const displayCaption = isPlaying ? activeCaption : selectedCaption ?? activeCaption;
  const displayTranslationPairs = useMemo(
    () => displayCaption
      ? translationTimelineTracks.flatMap((track) => track.visible
        ? track.pairs.filter((pair) => pair.source.id === displayCaption.id && pair.translation.text.trim())
        : [])
      : [],
    [displayCaption, translationTimelineTracks],
  );
  const previewHeight = Math.min(Math.max(280, height * 0.43), 500);
  const canvasSize = fitRect(
    Math.max(1, project.canvas.aspectWidth / project.canvas.aspectHeight),
    width - 24,
    previewHeight - 8,
  );
  const canvasWidth = canvasSize.width;
  const canvasHeight = canvasSize.height;
  const currentClipEntry = timelineEntryAt(clipTimeline, currentMs);
  const currentVideoTransform = currentClipEntry?.clip.transform ?? project.videoTransform;
  const editableVideoClip = currentClipEntry?.clip ?? selectedClip;
  const editableVideoTransform = editableVideoClip?.transform ?? project.videoTransform;
  const personPreviewTimeMs = Math.floor(currentMs / 250) * 250;
  const personProcessingActive = project.backgroundReplacement.enabled && backgroundProcessingAllowed === true;

  useEffect(() => {
    if (!runtimePolicy.mediaAdmitted || !personProcessingActive || !currentClipEntry) {
      return;
    }
    const source = project.sources.find((candidate) => candidate.id === currentClipEntry.clip.sourceId);
    if (!source) return;
    let active = true;
    const timer = setTimeout(() => {
      setPersonPreviewBusy(true);
      void renderPersonPreview({
        projectId: project.id,
        videoUri: source.uri,
        sourceTimeMs: sourceTimeAt(currentClipEntry, personPreviewTimeMs),
        timelineTimeMs: personPreviewTimeMs,
        background: project.backgroundReplacement,
        outputSize: { width: canvasWidth, height: canvasHeight },
        videoTransform: currentVideoTransform,
      }).then((uri) => {
        if (active) setPersonPreviewUri(uri);
      }).catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : 'Background preview failed.');
      }).finally(() => {
        if (active) setPersonPreviewBusy(false);
      });
    }, isPlaying ? 160 : 80);
    return () => { active = false; clearTimeout(timer); };
  }, [canvasHeight, canvasWidth, currentClipEntry, currentVideoTransform, isPlaying, personPreviewTimeMs, personProcessingActive, project.backgroundReplacement, project.id, project.sources, runtimePolicy.mediaAdmitted]);

  useEffect(() => {
    if (runtimePolicy.mediaAdmitted) return;
    let active = true;
    void releasePersonPreview(project.id).catch(() => undefined).finally(() => {
      if (!active) return;
      setPersonPreviewUri(undefined);
      setPersonPreviewBusy(false);
    });
    return () => { active = false; };
  }, [project.id, runtimePolicy.mediaAdmitted]);

  useEffect(() => () => {
    void releasePersonPreview(project.id).catch(() => undefined);
  }, [project.id]);

  useEffect(() => {
    workspaceMountedRef.current = true;
    return () => {
      workspaceMountedRef.current = false;
      void cancelProjectCaptionGeneration();
      void cancelProjectVideoExport();
    };
  }, []);

  const pushUndo = (snapshot = projectRef.current) => {
    const stack = undoStackRef.current;
    if (stack.at(-1) !== snapshot) stack.push(snapshot);
    trimHistoryStack(stack);
    redoStackRef.current = [];
    setHistoryVersion((value) => value + 1);
  };

  const translationController = useProjectCaptionTranslation({
    getCurrentProject: () => projectRef.current,
    commitProject: async (baseline, next) => {
      if (projectRef.current !== baseline) {
        throw new Error('The project changed while both languages were synchronizing. Save again to avoid overwriting newer edits.');
      }
      await commitPersistedProject(next, (persisted) => {
        pushUndo(baseline);
        projectRef.current = persisted;
        setProject(persisted);
      });
    },
  });
  const translationProgress = translationController.progress;
  const translationCancelling = translationController.cancelling;

  const beginHistoryInteraction = () => {
    interactionStartRef.current ??= projectRef.current;
  };

  const finishHistoryInteraction = () => {
    const snapshot = interactionStartRef.current;
    interactionStartRef.current = undefined;
    if (snapshot && snapshot !== projectRef.current) pushUndo(snapshot);
    persistProjectInBackground(projectRef.current);
  };

  const undo = () => {
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    redoStackRef.current.push(projectRef.current);
    trimHistoryStack(redoStackRef.current);
    interactionStartRef.current = undefined;
    projectRef.current = previous;
    transport.synchronizeProject(previous);
    setProject(previous);
    setSelectedCaptionId((id) => previous.captions.some((caption) => caption.id === id) ? id : previous.captions[0]?.id);
    setSelectedLayerId((id) => previous.layers.some((layer) => layer.id === id) ? id : 'captions');
    setHistoryVersion((value) => value + 1);
    persistProjectInBackground(previous);
  };

  const redo = () => {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push(projectRef.current);
    trimHistoryStack(undoStackRef.current);
    interactionStartRef.current = undefined;
    projectRef.current = next;
    transport.synchronizeProject(next);
    setProject(next);
    setSelectedCaptionId((id) => next.captions.some((caption) => caption.id === id) ? id : next.captions[0]?.id);
    setSelectedLayerId((id) => next.layers.some((layer) => layer.id === id) ? id : 'captions');
    setHistoryVersion((value) => value + 1);
    persistProjectInBackground(next);
  };

  const generateCaptions = async (modelId: TranscriptionModel['id']) => {
    setError(undefined);
    setTranscriptionCancelling(false);
    try {
      const before = projectRef.current;
      const next = await generateAndSaveProjectCaptions(
        before,
        modelId,
        (nextProgress) => { if (workspaceMountedRef.current) setProgress(nextProgress); },
      );
      if (!workspaceMountedRef.current) return;
      pushUndo(before);
      projectRef.current = next;
      setProject(next);
      setSelectedCaptionId(next.captions[0]?.id);
      if (before.captionTracks.translations.length > 0 && next.captionTracks.translations.length === 0) {
        Alert.alert(
          'Second language reset',
          'The detected source language changed or the timeline mixes English and Chinese clips. Caption Studio removed the incompatible second-language track so it cannot show or export incorrect translations. Undo restores the previous caption script and track.',
        );
      } else {
        const visibleTranslation = next.captionTracks.translations.find((track) => track.visible);
        const refreshIds = visibleTranslation?.cues
          .filter((cue) => cue.status === 'pending' || cue.status === 'stale')
          .map((cue) => cue.sourceCaptionId) ?? [];
        if (visibleTranslation && refreshIds.length > 0) {
          requestTranslationRefresh(refreshIds, visibleTranslation);
        }
      }
    } catch (caught) {
      if (workspaceMountedRef.current && !(caught instanceof CaptionGenerationCancelledError)) {
        setError(caught instanceof Error ? caught.message : 'Caption generation failed');
      }
    } finally {
      if (workspaceMountedRef.current) {
        setTranscriptionCancelling(false);
        setProgress(undefined);
      }
    }
  };

  const cancelCaptionGeneration = async () => {
    setTranscriptionCancelling(true);
    const cancelled = await cancelProjectCaptionGeneration();
    if (!cancelled) setTranscriptionCancelling(false);
  };

  const chooseCaptionQuality = (replacingExisting: boolean) => {
    const modelDescription = TRANSCRIPTION_MODELS
      .map((model) => `${model.label} · ${formatMegabytes(model.downloadBytes)} download\n${model.description}`)
      .join('\n\n');
    Alert.alert(
      replacingExisting ? 'Replace captions with which quality?' : 'Choose caption quality',
      `${replacingExisting ? 'This replaces the current caption text and timing. Styles and extra layers stay unchanged.\n\n' : ''}${modelDescription}`,
      TRANSCRIPTION_MODELS.map((model) => ({
        text: model.id === 'balanced' ? `${model.label} (recommended)` : model.label,
        onPress: () => { void generateCaptions(model.id); },
      })),
      { cancelable: true },
    );
  };

  const chooseStyleScope = async (scope: StyleScope) => {
    if (!pendingChange) return;
    const before = projectRef.current;
    const next = pendingChange.translationTrackId
      ? scope === 'caption' && selectedCaptionId
        ? setTranslationCueStyle(before, pendingChange.translationTrackId, selectedCaptionId, pendingChange.patch, new Date().toISOString())
        : setTranslationTrackStyle(before, pendingChange.translationTrackId, pendingChange.patch, new Date().toISOString())
      : applyStylePatch(before, selectedCaptionId ?? '', scope, pendingChange.patch);
    try {
      await commitPersistedProject(next, (persisted) => {
        pushUndo(before);
        projectRef.current = persisted;
        setProject(persisted);
        setPendingChange(undefined);
      });
    } catch {
      return;
    }
  };

  const chooseFont = (choice: FontChoice) => {
    setFontBrowserOpen(false);
    if (selectedTextLayer) {
      updateTextLayerStyle(selectedTextLayer.id, fontChoicePatch(choice), true);
      return;
    }
    queueCaptionStyleChange(`Font: ${choice.name}`, fontChoicePatch(choice));
  };

  const queueCaptionStyleChange = (label: string, patch: CaptionStylePatch) => {
    setPendingChange({
      label,
      patch,
      translationTrackId: translationTrackSelected ? selectedTranslationTrack?.id : undefined,
    });
  };

  const chooseAnimation = (id: CaptionAnimationId) => {
    const preset = findAnimationPreset(id);
    if (selectedTextLayer) {
      updateTextLayerStyle(selectedTextLayer.id, {
        animation: { id, intensity: preset.intensity, durationMs: preset.durationMs },
      }, true);
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
        : applyStylePatch(current, selectedCaptionId ?? '', scope, patch);
      projectRef.current = next;
      persistProjectInBackground(next);
      return next;
    });
  };

  const beginEditCaption = () => {
    if (!selectedCaption) return;
    transport.pause();
    setScriptEditorOpen(true);
  };

  const commitTextLayerText = async () => {
    if (editingText == null || !editingLayerId) return;
    const before = projectRef.current;
    const next = setTextLayerText(before, editingLayerId, editingText);
    try {
      await commitPersistedProject(next, (persisted) => {
        pushUndo(before);
        projectRef.current = persisted;
        setProject(persisted);
        setEditingLayerId(undefined);
        setEditingText(undefined);
      });
    } catch {
      return;
    }
  };

  const commitCaptionScript = async (captions: CaptionProject['captions']) => {
    const before = projectRef.current;
    const next = replaceVisibleCaptionScript(before, captions);
    if (next !== before) {
      const changedCaptionIds = changedPrimaryCaptionTextIds(before, next);
      await commitPersistedProject(next, (persisted) => {
        pushUndo(before);
        projectRef.current = persisted;
        setProject(persisted);
        if (!persisted.captions.some((caption) => caption.id === selectedCaptionId && caption.timelineVisible !== false)) {
          setSelectedCaptionId(captions[0]?.id);
        }
      });
      const visibleTranslation = next.captionTracks.translations.find((track) => track.visible);
      if (visibleTranslation && changedCaptionIds.length > 0) {
        requestTranslationRefresh(changedCaptionIds, visibleTranslation);
      }
    }
    setScriptEditorOpen(false);
  };

  const openDualCaptionEditor = () => {
    if (timelineCaptions.length === 0) {
      Alert.alert('Generate captions first', 'Dual subtitles need a primary caption script to translate.');
      return;
    }
    let sourceLanguage;
    try {
      sourceLanguage = projectEnglishChineseCaptionLanguage(projectRef.current);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'This caption language is not supported for dual subtitles.');
      return;
    }
    const existing = projectRef.current.captionTracks.translations.find((track) => track.visible)
      ?? projectRef.current.captionTracks.translations[0];
    if (existing) {
      transport.pause();
      setSelectedTranslationTrackId(existing.id);
      setDualCaptionEditorOpen(true);
      const pendingIds = existing.cues
        .filter((cue) => cue.status === 'pending' || cue.status === 'stale')
        .map((cue) => cue.sourceCaptionId);
      if (pendingIds.length > 0 && !translationController.busy) {
        void translationController.refresh(existing.id, pendingIds, projectRef.current);
      }
      return;
    }
    const downloadSize = formatMegabytes(NATURAL_TRANSLATION_MODEL.downloadBytes);
    const message = `Dual subtitles are optional. Natural translation runs on this phone after a one-time ${downloadSize} model download. Use clips spoken mainly in one language; code-switching inside one clip can need manual correction. AI translation can still need human review.`;
    if (sourceLanguage === 'en') {
      Alert.alert('Add English + Chinese', message, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Traditional Chinese', onPress: () => { void enableDualCaptions('zh-Hant'); } },
        { text: 'Simplified Chinese', onPress: () => { void enableDualCaptions('zh-Hans'); } },
      ]);
      return;
    }
    Alert.alert('Add Chinese + English', message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Add English', onPress: () => { void enableDualCaptions('en'); } },
    ]);
  };

  const enableDualCaptions = async (targetLanguage: 'en' | 'zh-Hans' | 'zh-Hant') => {
    const before = projectRef.current;
    try {
      const prepared = prepareOptionalDualCaptionTrack(before, targetLanguage);
      await commitPersistedProject(prepared.project, (persisted) => {
        pushUndo(before);
        projectRef.current = persisted;
        setProject(persisted);
        setSelectedTranslationTrackId(prepared.trackId);
        transport.pause();
        setDualCaptionEditorOpen(true);
      });
      const translationBaseline = projectRef.current;
      void translationController.refresh(
        prepared.trackId,
        visibleTimelineCaptions(translationBaseline.captions).map((caption) => caption.id),
        translationBaseline,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Dual subtitles could not be enabled.');
    }
  };

  const requestTranslationRefresh = (
    sourceCaptionIds: string[],
    requestedTrack = selectedTranslationTrack,
  ) => {
    const track = requestedTrack;
    if (!track) return;
    const reviewed = track.cues.filter((cue) => sourceCaptionIds.includes(cue.sourceCaptionId) && cue.reviewed);
    if (reviewed.length > 0) {
      Alert.alert(
        'Replace reviewed translation?',
        `${reviewed.length} selected subtitle${reviewed.length === 1 ? ' was' : 's were'} edited by a person. Refresh will replace the second-language text, and Undo can restore it.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Replace + refresh', style: 'destructive', onPress: () => { void translationController.refresh(track.id, sourceCaptionIds); } },
        ],
      );
      return;
    }
    void translationController.refresh(track.id, sourceCaptionIds);
  };

  const saveDualCaptionEdits = async (edits: DualCaptionTextEdit[]) => {
    const track = selectedTranslationTrack;
    if (!track || edits.length === 0) return false;
    if (edits.some((edit) => !edit.primaryText.trim() || !edit.translatedText.trim())) {
      Alert.alert('Both lines need text', 'Enter both the primary and translated subtitle before saving this row.');
      return false;
    }
    const reviewedById = new Map(track.cues.map((cue) => [cue.sourceCaptionId, cue.reviewed]));
    const overwritesReviewed = edits.some((edit) => edit.primaryChanged && !edit.translatedChanged && reviewedById.get(edit.sourceCaptionId));
    if (overwritesReviewed) {
      const confirmed = await confirmReviewedTranslationReplacement(track.displayName);
      if (!confirmed) return false;
    }
    return translationController.synchronize(track.id, edits);
  };

  const toggleSelectedTranslationTrack = async () => {
    const track = selectedTranslationTrack;
    if (!track) return;
    const before = projectRef.current;
    const updatedAt = new Date().toISOString();
    let next = before;
    if (!track.visible) {
      for (const candidate of before.captionTracks.translations) {
        if (candidate.visible) next = setTranslationTrackVisibility(next, candidate.id, false, updatedAt);
      }
    }
    next = setTranslationTrackVisibility(next, track.id, !track.visible, updatedAt);
    try {
      await commitPersistedProject(next, (persisted) => {
        pushUndo(before);
        projectRef.current = persisted;
        setProject(persisted);
      });
    } catch {
      return;
    }
  };

  const confirmRemoveSelectedTranslationTrack = () => {
    const track = selectedTranslationTrack;
    if (!track) return;
    Alert.alert('Remove second language?', `${track.displayName} text will be removed from this project. The primary captions stay unchanged.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          const before = projectRef.current;
          const next = removeTranslationCaptionTrack(before, track.id, new Date().toISOString());
          void commitPersistedProject(next, (persisted) => {
            pushUndo(before);
            projectRef.current = persisted;
            setProject(persisted);
            setSelectedTranslationTrackId(undefined);
            setDualCaptionEditorOpen(false);
          }).catch(() => undefined);
        },
      },
    ]);
  };

  const cancelDualCaptionTranslation = async () => {
    await translationController.cancel();
  };

  const commitCaptionStructure = async (mutation: CaptionScriptMutation) => {
    const before = projectRef.current;
    const next = replaceVisibleCaptionScript(before, mutation.captions);
    if (next === before) return;
    const changedCaptionIds = changedPrimaryCaptionTextIds(before, next);
    await commitPersistedProject(next, (persisted) => {
      pushUndo(before);
      projectRef.current = persisted;
      setProject(persisted);
      setSelectedCaptionId(mutation.focusedId);
    });
    const visibleTranslation = next.captionTracks.translations.find((track) => track.visible);
    if (visibleTranslation && changedCaptionIds.length > 0) {
      requestTranslationRefresh(changedCaptionIds, visibleTranslation);
    }
  };

  const splitSelectedCaptionAtPlayhead = () => {
    if (!selectedCaption) return;
    const mutation = splitCaptionScriptBlockAtTime(
      timelineCaptions,
      selectedCaption.id,
      currentMs,
      projectRef.current.transcription.words,
      uniqueId('caption'),
    );
    if (!mutation) {
      Alert.alert('Move the playhead inside this subtitle', 'A split needs a little room on both sides of the playhead.');
      return;
    }
    void commitCaptionStructure(mutation).catch(() => undefined);
  };

  const joinSelectedCaption = (direction: 'previous' | 'next') => {
    if (!selectedCaption) return;
    const mutation = mergeCaptionScriptBlock(timelineCaptions, selectedCaption.id, direction);
    if (!mutation) {
      Alert.alert('Nothing to join', `There is no subtitle immediately ${direction === 'previous' ? 'before' : 'after'} this one.`);
      return;
    }
    if ('blockedByVideoCut' in mutation) {
      Alert.alert('Cannot join across a video cut', 'Subtitles attached to different video clips stay separate so their timing remains correct.');
      return;
    }
    void commitCaptionStructure(mutation).catch(() => undefined);
  };

  const updateTextLayerStyle = (layerId: string, patch: CaptionStylePatch, persist = false) => {
    if (persist) pushUndo();
    setProject((current) => {
      const next = setTextLayerStyle(current, layerId, patch);
      projectRef.current = next;
      if (persist) persistProjectInBackground(next);
      return next;
    });
  };

  const updateSharedCaptionTransform = (patch: CaptionStylePatch) => {
    if (!selectedCaptionId) return;
    setProject((current) => {
      const next = applyStylePatch(current, selectedCaptionId, 'all', patch);
      projectRef.current = next;
      return next;
    });
  };

  const updateVideoTransform = (patch: VideoTransformPatch) => {
    const clipId = editableVideoClip?.id;
    if (!clipId) return;
    setProject((current) => {
      const next = setVideoClipTransform(current, clipId, patch);
      projectRef.current = next;
      return next;
    });
  };

  const updateCaptionTiming = (captionId: string, edge: 'start' | 'end', startMs: number, endMs: number) => {
    setProject((current) => {
      const next = setCaptionTiming(current, captionId, edge, startMs, endMs);
      projectRef.current = next;
      return next;
    });
  };

  const updateLayerTiming = (layerId: string, startMs: number, endMs: number) => {
    setProject((current) => {
      const next = setLayerTiming(current, layerId, startMs, endMs);
      projectRef.current = next;
      return next;
    });
  };

  const updateImageLayer = (layerId: string, patch: Partial<ImageVisualLayer>) => {
    setProject((current) => {
      const next = setImageLayer(current, layerId, patch);
      projectRef.current = next;
      return next;
    });
  };

  const addTextLayer = () => {
    pushUndo();
    const id = uniqueId('text');
    const duration = Math.max(500, timelineDurationMs);
    const result = createTextLayer(projectRef.current, id, currentMs, duration);
    setProject((current) => {
      const next = current === projectRef.current ? result.project : createTextLayer(current, id, currentMs, duration).project;
      projectRef.current = next;
      persistProjectInBackground(next);
      return next;
    });
    transport.pause();
    setSelectedLayerId(id);
    setSelectedCaptionId(undefined);
    setEditingLayerId(id);
    setEditingText(result.layer.text);
  };

  const addImageLayer = async () => {
    const id = uniqueId('image');
    let stored;
    try {
      stored = await pickAndStoreImage(projectRef.current.id, id);
    } catch (caught) {
      Alert.alert('Could not add image', caught instanceof Error ? caught.message : 'The selected image could not be saved.');
      return;
    }
    if (!stored) return;
    ownedAssetLedgerRef.current = trackProjectOwnedAssets(ownedAssetLedgerRef.current, [stored.uri]);
    pushUndo();
    const duration = Math.max(500, timelineDurationMs);
    const result = addImageLayerToProject(projectRef.current, {
      id,
      name: stored.name,
      uri: stored.uri,
      currentMs,
      durationMs: duration,
    });
    setProject((current) => {
      const next = current === projectRef.current ? result.project : addImageLayerToProject(current, { id, name: stored.name, uri: stored.uri, currentMs, durationMs: duration }).project;
      projectRef.current = next;
      persistProjectInBackground(next);
      return next;
    });
    transport.pause();
    setSelectedLayerId(id);
    setSelectedCaptionId(undefined);
  };

  const moveLayer = (layerId: string, direction: -1 | 1) => {
    pushUndo();
    setProject((current) => {
      const next = moveVisualLayer(current, layerId, direction);
      projectRef.current = next;
      persistProjectInBackground(next);
      return next;
    });
  };

  const deleteLayer = (layerId: string) => {
    if (layerId === 'captions') return;
    pushUndo();
    setProject((current) => {
      const next = deleteVisualLayer(current, layerId);
      projectRef.current = next;
      persistProjectInBackground(next);
      return next;
    });
    setSelectedLayerId('captions');
  };

  const addVideosToTimeline = async () => {
    setError(undefined);
    try {
      const before = projectRef.current;
      const beforeDuration = totalClipDuration(before.clips);
      const next = await appendVideosToProject(before, setMediaProgress);
      if (!next) return;
      trackSessionMedia(next);
      pushUndo(before);
      projectRef.current = next;
      transport.synchronizeProject(next);
      setProject(next);
      const firstAdded = next.clips[before.clips.length];
      setSelectedClipId(firstAdded?.id);
      setSelectedCaptionId(undefined);
      setActiveTool('video');
      if (firstAdded) seekTimeline(beforeDuration);
    } catch (caught) {
      Alert.alert('Could not add videos', caught instanceof Error ? caught.message : 'The selected videos could not be added.');
    } finally {
      setMediaProgress(undefined);
    }
  };

  const updateSelectedClip = (patch: Partial<Pick<VideoClip, 'volume' | 'muted' | 'fadeInMs' | 'fadeOutMs'>>) => {
    if (!selectedClipId) return;
    const before = projectRef.current;
    pushUndo(before);
    const next = updateVideoClip(before, selectedClipId, patch);
    projectRef.current = next;
    transport.synchronizeProject(next);
    setProject(next);
    persistProjectInBackground(next);
    const entry = buildClipTimeline(next.clips).find((candidate) => candidate.clip.id === selectedClipId);
    if (entry) transport.seek(clamp(currentMs, entry.startMs, entry.endMs));
  };

  const updateSelectedClipRate = (rate: number) => {
    if (!selectedClipId) return;
    const before = projectRef.current;
    const oldEntry = buildClipTimeline(before.clips).find((entry) => entry.clip.id === selectedClipId);
    if (!oldEntry) return;
    pushUndo(before);
    const next = setClipPlaybackRate(before, selectedClipId, rate);
    projectRef.current = next;
    transport.synchronizeProject(next);
    setProject(next);
    persistProjectInBackground(next);
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
    const result = splitVideoClip(projectRef.current, entry.clip.id, currentMs, uniqueId('clip'), uniqueId('clip'));
    if (!result) return;
    pushUndo();
    projectRef.current = result.project;
    transport.synchronizeProject(result.project);
    setProject(result.project);
    persistProjectInBackground(result.project);
    setSelectedClipId(result.rightClipId);
  };

  const deleteSelectedClip = () => {
    if (!selectedClipId || projectRef.current.clips.length <= 1) return;
    const result = deleteVideoClip(projectRef.current, selectedClipId);
    if (!result) return;
    pushUndo();
    const next = result.project;
    projectRef.current = next;
    transport.synchronizeProject(next);
    setProject(next);
    setSelectedClipId(next.clips[0]?.id);
    persistProjectInBackground(next);
    queueMicrotask(() => seekTimeline(result.seekMs));
  };

  const trimClipEdge = (clipId: string, edge: 'start' | 'end', targetSourceMs: number) => {
    const current = projectRef.current;
    const result = trimVideoClip(current, clipId, edge, targetSourceMs);
    if (!result) return;
    pushUndo();
    const next = result.project;
    projectRef.current = next;
    transport.synchronizeProject(next);
    setProject(next);
    persistProjectInBackground(next);
    transport.pause();
    queueMicrotask(() => seekTimeline(Math.min(result.seekMs, Math.max(0, totalClipDuration(next.clips) - 1))));
  };

  const setClipGap = (clipId: string, gapMs: number, edge: 'before' | 'after' = 'before') => {
    const result = setVideoClipGap(projectRef.current, clipId, gapMs, edge);
    if (!result) return;
    pushUndo();
    projectRef.current = result.project;
    transport.synchronizeProject(result.project);
    setProject(result.project);
    persistProjectInBackground(result.project);
    transport.pause();
    queueMicrotask(() => transport.seek(result.seekMs));
  };

  const addAudio = async (origin: 'audio-file' | 'video-audio') => {
    transport.pause();
    setError(undefined);
    if (origin === 'video-audio') {
      setExtractAudioOpen(true);
      return;
    }
    try {
      const before = projectRef.current;
      const result = await appendAudioToProject(before, currentMs, origin);
      if (!result) return;
      trackSessionMedia(result.project);
      pushUndo(before);
      projectRef.current = result.project;
      setProject(result.project);
      setSelectedAudioClipId(result.clip.id);
      setSelectedClipId(undefined);
      setSelectedCaptionId(undefined);
      setActiveTool('audio');
    } catch (caught) {
      Alert.alert('Could not add audio', caught instanceof Error ? caught.message : 'The selected media could not be added.');
    }
  };

  const addProjectVideoAudio = async (sourceId?: string) => {
    transport.pause();
    setExtractAudioBusy(true);
    setError(undefined);
    try {
      const before = projectRef.current;
      const result = sourceId
        ? await appendProjectVideoAudioToProject(before, currentMs, sourceId)
        : await appendAudioToProject(before, currentMs, 'video-audio');
      if (!result) return;
      trackSessionMedia(result.project);
      pushUndo(before);
      projectRef.current = result.project;
      setProject(result.project);
      setSelectedAudioClipId(result.clip.id);
      setSelectedClipId(undefined);
      setSelectedCaptionId(undefined);
      setActiveTool('audio');
      setExtractAudioOpen(false);
    } catch (caught) {
      Alert.alert('Could not extract audio', caught instanceof Error ? caught.message : 'The selected video could not be used.');
    } finally {
      setExtractAudioBusy(false);
    }
  };

  const commitAudioProject = (next: CaptionProject) => {
    projectRef.current = next;
    setProject(next);
    persistProjectInBackground(next);
  };

  const updateSelectedAudio = (patch: Partial<Pick<AudioClip, 'volume' | 'muted' | 'fadeInMs' | 'fadeOutMs'>>) => {
    if (!selectedAudioClipId) return;
    pushUndo();
    commitAudioProject(updateAudioClip(projectRef.current, selectedAudioClipId, patch));
  };

  const changeAudioTiming = (clipId: string, edge: 'start' | 'end', startMs: number, endMs: number) => {
    const next = edge === 'start'
      ? trimAudioClip(projectRef.current, clipId, 'start', startMs, timelineDurationMs)
      : trimAudioClip(projectRef.current, clipId, 'end', endMs, timelineDurationMs);
    projectRef.current = next;
    setProject(next);
  };

  const shiftSelectedAudio = (deltaMs: number) => {
    if (!selectedAudioClip) return;
    pushUndo();
    commitAudioProject(moveAudioClip(projectRef.current, selectedAudioClip.id, selectedAudioClip.startMs + deltaMs, timelineDurationMs));
  };

  const removeSelectedAudio = () => {
    if (!selectedAudioClipId) return;
    pushUndo();
    commitAudioProject(deleteAudioClip(projectRef.current, selectedAudioClipId));
    setSelectedAudioClipId(undefined);
  };

  const copySelectedAudio = () => {
    if (!selectedAudioClipId) return;
    const result = duplicateAudioClip(projectRef.current, selectedAudioClipId, uniqueId('audio-clip'), timelineDurationMs);
    if (!result) return;
    pushUndo();
    commitAudioProject(result.project);
    setSelectedAudioClipId(result.clip.id);
  };

  const applyTransition = (type: VideoClip['transitionAfter']['type'], durationMs = 500) => {
    if (!selectedClipId) return;
    pushUndo();
    const next = setVideoTransition(projectRef.current, selectedClipId, type, durationMs);
    projectRef.current = next;
    setProject(next);
    persistProjectInBackground(next);
  };

  const reorderSelectedVideo = (direction: -1 | 1) => {
    if (!selectedClipId) return;
    pushUndo();
    const next = moveVideoClip(projectRef.current, selectedClipId, direction);
    projectRef.current = next;
    transport.synchronizeProject(next);
    setProject(next);
    persistProjectInBackground(next);
  };

  const exportVideo = async () => {
    if (exporting) return;
    if (
      projectRef.current.backgroundReplacement.enabled
      && projectRef.current.backgroundReplacement.source
      && !await requestBackgroundProcessing()
    ) return;
    transport.pause();
    setError(undefined);
    setExportKind('video');
    setExportProgress({ stage: 'preparing', percent: 0 });
    setExporting(true);
    try {
      const result = await exportProjectVideo(projectRef.current);
      Alert.alert('Export complete', `Saved to your phone’s media library.\n${result.width} × ${result.height}`);
    } catch (caught) {
      if (!(caught instanceof VideoExportCancelledError)) {
        setError(userFacingExportError(caught));
      }
    } finally {
      setExporting(false);
    }
  };

  const exportSubtitles = async (format: 'srt' | 'ass') => {
    if (exporting) return;
    transport.pause();
    setError(undefined);
    setExportKind('subtitle');
    setExportProgress(undefined);
    setExporting(true);
    try {
      await exportSubtitleFile(projectRef.current, format);
    } catch (caught) {
      setError(userFacingExportError(caught, 'The subtitle file could not be exported.'));
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
    const current = projectRef.current;
    const index = current.captions.findIndex((caption) => caption.id === captionId);
    if (index < 0) return;
    pushUndo();
    const next = deleteCaptionBlock(current, captionId);
    projectRef.current = next;
    setProject(next);
    setSelectedCaptionId(next.captions[Math.min(index, next.captions.length - 1)]?.id);
    persistProjectInBackground(next);
  };

  const confirmDeleteCaption = (captionId: string) => {
    Alert.alert('Delete this subtitle?', 'Only this caption block will be removed. The source video is unchanged.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteCaption(captionId) },
    ]);
  };

  const setCanvasPreset = (preset: CaptionProject['canvas']['preset']) => {
    const before = projectRef.current;
    const next = applyCanvasPreset(before, preset);
    void commitPersistedProject(next, (persisted) => {
      pushUndo(before);
      projectRef.current = persisted;
      setProject(persisted);
    }).catch(() => undefined);
  };

  const updateBackgroundReplacement = (backgroundReplacement: CaptionProject['backgroundReplacement']) => {
    const before = projectRef.current;
    pushUndo(before);
    const next = applyBackgroundReplacement(before, backgroundReplacement);
    projectRef.current = next;
    setProject(next);
    persistProjectInBackground(next);
  };

  const requestBackgroundProcessing = async () => {
    if (backgroundProcessingAllowed === true || await hasBackgroundProcessingConsent()) {
      setBackgroundProcessingAllowed(true);
      return true;
    }
    if (backgroundConsentRequestRef.current) return backgroundConsentRequestRef.current;
    const request = new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (granted: boolean) => {
        if (settled) return;
        settled = true;
        resolve(granted);
      };
      Alert.alert(
        'Enable on-device background removal?',
        'Your video frames and masks stay on this phone. Google MediaPipe and ML Kit can send encrypted engagement, device/app, performance, configuration, input/output-size, event, and error metrics to Google. Caption Studio does not receive those metrics. You can turn future background-removal processing off in Privacy.',
        [
          { text: 'Not now', style: 'cancel', onPress: () => finish(false) },
          {
            text: 'Allow and enable',
            onPress: () => {
              void setBackgroundProcessingConsent(true)
                .then(() => {
                  setBackgroundProcessingAllowed(true);
                  finish(true);
                })
                .catch(() => {
                  Alert.alert('Could not save privacy choice', 'Background removal remains off. Try again.');
                  finish(false);
                });
            },
          },
        ],
        { cancelable: true, onDismiss: () => finish(false) },
      );
    });
    backgroundConsentRequestRef.current = request;
    try {
      return await request;
    } finally {
      if (backgroundConsentRequestRef.current === request) backgroundConsentRequestRef.current = undefined;
    }
  };

  const enableBackgroundProcessing = async () => {
    try {
      if (!await requestBackgroundProcessing()) return;
      updateBackgroundReplacement({ ...projectRef.current.backgroundReplacement, enabled: true });
    } catch (caught) {
      Alert.alert('Could not enable background removal', caught instanceof Error ? caught.message : 'Try again.');
    }
  };

  const chooseBackgroundMedia = async () => {
    try {
      if (!await requestBackgroundProcessing()) return;
      const source = await pickBackgroundMedia(projectRef.current.id);
      if (!source) return;
      const nextBackground = { ...projectRef.current.backgroundReplacement, enabled: true, source };
      const nextProject = applyBackgroundReplacement(projectRef.current, nextBackground);
      trackSessionMedia(nextProject);
      updateBackgroundReplacement(nextBackground);
    } catch (caught) {
      Alert.alert('Could not use this background', caught instanceof Error ? caught.message : 'The selected media could not be opened.');
    }
  };

  const addPersonPathPoint = () => {
    const background = projectRef.current.backgroundReplacement;
    const transform = resolvePersonTransform(background, currentMs);
    updateBackgroundReplacement({
      ...background,
      keyframes: upsertPersonKeyframe(background.keyframes, { id: uniqueId('person-point'), timeMs: currentMs, ...transform }),
    });
  };

  const removeNearestPersonPathPoint = () => {
    const background = projectRef.current.backgroundReplacement;
    const nearest = background.keyframes.reduce<typeof background.keyframes[number] | undefined>((best, frame) => !best || Math.abs(frame.timeMs - currentMs) < Math.abs(best.timeMs - currentMs) ? frame : best, undefined);
    if (!nearest) return;
    updateBackgroundReplacement({ ...background, keyframes: deletePersonKeyframe(background.keyframes, nearest.id) });
  };

  return (
    <View style={{ flex: 1, backgroundColor: palette.background }}>
      <View style={{ height: previewHeight, alignItems: 'center', justifyContent: 'center', paddingTop: 8 }}>
        <View
          style={{
            width: canvasSize.width,
            height: canvasSize.height,
            overflow: 'hidden',
            borderRadius: 20,
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
            <VideoView
              style={{ flex: 1, opacity: personProcessingActive ? 0 : 1 }}
              player={player}
              nativeControls={false}
              contentFit={currentVideoTransform.fit === 'fill' ? 'cover' : 'contain'}
              surfaceType="textureView"
              useExoShutter
            />
          </View>
          {personProcessingActive && currentClipEntry && personPreviewUri ? (
            <Image
              pointerEvents="none"
              source={{ uri: personPreviewUri }}
              cachePolicy="none"
              contentFit="fill"
              style={{ position: 'absolute', inset: 0 }}
            />
          ) : null}
          {personProcessingActive && personPreviewBusy && !personPreviewUri ? (
            <View pointerEvents="none" style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}>
              <ActivityIndicator color={palette.accent} />
              <Text style={{ marginTop: 7, color: '#D7DEE7', fontSize: 10, fontWeight: '800' }}>REMOVING BACKGROUND…</Text>
            </View>
          ) : null}
          {transport.isGap ? (
            <View pointerEvents="none" style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: project.canvas.backgroundColor }}>
              <Text style={{ color: '#7F8996', fontSize: 12, fontWeight: '800' }}>EMPTY TIMELINE GAP</Text>
            </View>
          ) : transport.phase === 'loading' ? (
            <View pointerEvents="none" style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: project.canvas.backgroundColor }}>
              <ActivityIndicator color={palette.accent} />
              <Text style={{ marginTop: 8, color: '#A8B1BC', fontSize: 10, fontWeight: '800' }}>LOADING CLIP…</Text>
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
            backgroundProcessingActive={personProcessingActive}
            admitted={runtimePolicy.mediaAdmitted}
          />
          {activeTool === 'video' && currentClipEntry ? (
            <VideoTransformOverlay
              transform={currentVideoTransform}
              onInteractionStart={beginHistoryInteraction}
              onChange={updateVideoTransform}
              onEnd={finishHistoryInteraction}
            />
          ) : null}
          {[...timelineLayers].reverse().map((layer) => {
            if (!layer.visible) return null;
            if (layer.kind === 'captions') {
              return (
                <View key={layer.id} pointerEvents="box-none" style={{ position: 'absolute', inset: 0 }}>
                  <CaptionOverlay
                    caption={displayCaption}
                    words={project.transcription.words}
                    projectStyle={project.projectStyle}
                    currentMs={currentMs}
                    interactive={activeTool !== 'video' && selectedLayerId === 'captions' && Boolean(selectedCaptionId) && displayCaption?.id === selectedCaptionId}
                    onInteractionStart={() => { transport.pause(); beginHistoryInteraction(); }}
                    onTransform={updateSharedCaptionTransform}
                    onTransformEnd={finishHistoryInteraction}
                    onDelete={selectedCaptionId ? () => confirmDeleteCaption(selectedCaptionId) : undefined}
                  />
                  {displayTranslationPairs.map((pair) => (
                    <CaptionOverlay
                      key={pair.translation.id}
                      caption={{
                        id: pair.translation.id,
                        text: pair.translation.text,
                        startMs: pair.startMs,
                        endMs: pair.endMs,
                        wordIds: [],
                      }}
                      words={[]}
                      projectStyle={pair.style}
                      currentMs={currentMs}
                    />
                  ))}
                </View>
              );
            }
            const visibleNow = currentMs >= layer.startMs && currentMs < layer.endMs;
            if (isPlaying && !visibleNow) return null;
            if (!isPlaying && !visibleNow && selectedLayerId !== layer.id) return null;
            if (layer.kind === 'text') {
              return (
                <CaptionOverlay
                  key={layer.id}
                  caption={{ id: layer.id, text: layer.text, startMs: layer.startMs, endMs: layer.endMs, wordIds: [] }}
                  words={[]}
                  projectStyle={layer.style}
                  currentMs={currentMs}
                  interactive={activeTool !== 'video' && selectedLayerId === layer.id}
                  onInteractionStart={() => { transport.pause(); beginHistoryInteraction(); }}
                  onTransform={(patch) => updateTextLayerStyle(layer.id, patch)}
                  onTransformEnd={finishHistoryInteraction}
                  onDelete={() => deleteLayer(layer.id)}
                />
              );
            }
            return (
              <ImageLayerOverlay
                key={layer.id}
                layer={layer}
                interactive={activeTool !== 'video' && selectedLayerId === layer.id}
                onInteractionStart={() => { transport.pause(); beginHistoryInteraction(); }}
                onChange={(patch) => updateImageLayer(layer.id, patch)}
                onEnd={finishHistoryInteraction}
                onDelete={() => deleteLayer(layer.id)}
              />
            );
          })}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={isPlaying ? 'Pause video' : 'Play video'}
            onPress={() => {
              if (isPlaying) {
                transport.pause();
              } else {
                setSelectedCaptionId(undefined);
                transport.play();
              }
            }}
            style={{
              position: 'absolute',
              right: 12,
              bottom: 12,
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
      </View>

      <View style={{ flex: 1 }}>
        <ScrollView
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          style={{ flex: 1 }}
          contentContainerStyle={{ gap: 12, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 18 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 10 }}>
          <HistoryButton label="↶  Undo" disabled={undoStackRef.current.length === 0} version={historyVersion} onPress={undo} />
          <HistoryButton label="Redo  ↷" disabled={redoStackRef.current.length === 0} version={historyVersion} onPress={redo} />
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
              style={{ paddingHorizontal: 16, paddingVertical: 11, borderRadius: 999, backgroundColor: palette.accent }}>
              <Text style={{ color: '#10130A', fontWeight: '800' }}>Generate captions</Text>
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
                <Text style={{ color: '#64E8FF', fontSize: 11, fontWeight: '800', textDecorationLine: 'underline' }}>
                  {project.captionTracks.translations.length > 0 ? 'Dual subtitles' : 'Add dual subtitles'}
                </Text>
              </Pressable>
            </View>
          )}
        </View>

        <LayerTimeline
          durationMs={timelineDurationMs}
          clips={project.clips}
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
          onSelectLayer={(layerId) => {
            transport.pause();
            setSelectedLayerId(layerId);
            setSelectedClipId(undefined);
            setSelectedAudioClipId(undefined);
            setActiveTool('captions');
            if (layerId !== 'captions') setSelectedCaptionId(undefined);
          }}
          onSelectCaption={(caption) => {
            transport.pause();
            setSelectedLayerId('captions');
            setSelectedCaptionId(caption.id);
            setSelectedClipId(undefined);
            setSelectedAudioClipId(undefined);
            setActiveTool('captions');
            seekTimeline(caption.startMs);
          }}
          onSelectTranslationCaption={(trackId, pair) => {
            transport.pause();
            setSelectedLayerId(trackId);
            setSelectedTranslationTrackId(trackId);
            setSelectedCaptionId(pair.source.id);
            setSelectedClipId(undefined);
            setSelectedAudioClipId(undefined);
            setActiveTool('captions');
            seekTimeline(pair.startMs);
            setDualCaptionEditorOpen(true);
          }}
          onSelectClip={(clipId, startMs) => {
            transport.pause();
            setSelectedClipId(clipId);
            setSelectedCaptionId(undefined);
            setSelectedAudioClipId(undefined);
            setActiveTool('video');
            seekTimeline(startMs);
          }}
          onTrimClip={trimClipEdge}
          onSetClipGap={setClipGap}
          onLayerTimingChange={updateLayerTiming}
          onCaptionTimingChange={updateCaptionTiming}
          onTimingChangeStart={beginHistoryInteraction}
          onTimingChangeEnd={finishHistoryInteraction}
          onMoveLayer={moveLayer}
          onDeleteLayer={deleteLayer}
          onAddVideos={() => { void addVideosToTimeline(); }}
          onSelectAudioClip={(clipId, startMs) => {
            transport.pause();
            setSelectedAudioClipId(clipId);
            setSelectedClipId(undefined);
            setSelectedCaptionId(undefined);
            setActiveTool('audio');
            seekTimeline(startMs);
          }}
          onAudioTimingChange={changeAudioTiming}
        />

        {activeTool === 'video' ? (
          <View style={{ gap: 8 }}>
            {selectedClip ? (
              <View style={{ gap: 7 }}>
                <Text numberOfLines={1} style={{ color: palette.accent, fontSize: 12, fontWeight: '900' }}>
                  SELECTED CLIP · {project.sources.find((source) => source.id === selectedClip.sourceId)?.displayName ?? 'Video'}
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                  <Action label="Split at playhead" onPress={splitClipAtPlayhead} />
                  <Action label="Delete + close gap" danger disabled={project.clips.length <= 1} onPress={deleteSelectedClip} />
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
                </ScrollView>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                  {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((rate) => (
                    <Action key={rate} label={`${rate}× speed`} color={selectedClip.playbackRate === rate ? '#DFFF35' : undefined} onPress={() => updateSelectedClipRate(rate)} />
                  ))}
                </ScrollView>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                  {VIDEO_TRANSITION_PRESETS.map((preset) => <Action key={preset.id} label={preset.name} color={selectedClip.transitionAfter.type === preset.id ? '#DFFF35' : undefined} disabled={preset.id !== 'none' && !transitionBoundaryAvailable} onPress={() => applyTransition(preset.id, preset.durationMs)} />)}
                  {[250, 500, 1000].map((duration) => <Action key={duration} label={`${duration} ms transition`} color={selectedClip.transitionAfter.durationMs === duration ? '#64E8FF' : undefined} disabled={!transitionBoundaryAvailable} onPress={() => applyTransition(selectedClip.transitionAfter.type === 'none' ? 'dip-black' : selectedClip.transitionAfter.type, duration)} />)}
                </ScrollView>
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
            <BackgroundTools
              value={project.backgroundReplacement}
              currentTimeMs={currentMs}
              processingAllowed={backgroundProcessingAllowed === true}
              onRequestProcessing={() => { void enableBackgroundProcessing(); }}
              onChooseMedia={() => { void chooseBackgroundMedia(); }}
              onChange={updateBackgroundReplacement}
              onAddKeyframe={addPersonPathPoint}
              onRemoveNearestKeyframe={removeNearestPersonPathPoint}
            />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              <Action label="Add videos" onPress={() => { void addVideosToTimeline(); }} />
              <Action label="Add text layer" onPress={addTextLayer} />
              <Action label="Add sticker/image" onPress={() => void addImageLayer()} />
            </ScrollView>
          </View>
        ) : activeTool === 'audio' ? (
          <View style={{ gap: 8 }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              <Action label="Add audio file" onPress={() => void addAudio('audio-file')} />
              <Action label="Extract from video" onPress={() => void addAudio('video-audio')} />
            </ScrollView>
            {selectedAudioClip ? <>
              <Text numberOfLines={1} style={{ color: '#64E8FF', fontSize: 12, fontWeight: '900' }}>SELECTED AUDIO · {project.audioSources.find((source) => source.id === selectedAudioClip.sourceId)?.displayName ?? 'Audio'}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                <Action label={selectedAudioClip.muted ? 'Unmute audio' : 'Mute audio'} onPress={() => updateSelectedAudio({ muted: !selectedAudioClip.muted })} />
                <Action label="Volume −" disabled={selectedAudioClip.volume <= 0} onPress={() => updateSelectedAudio({ volume: clamp(selectedAudioClip.volume - 0.1, 0, 1) })} />
                <Action label={`${Math.round(selectedAudioClip.volume * 100)}% volume`} color="#64E8FF" onPress={() => updateSelectedAudio({ volume: 1, muted: false })} />
                <Action label="Volume +" disabled={selectedAudioClip.volume >= 1} onPress={() => updateSelectedAudio({ volume: clamp(selectedAudioClip.volume + 0.1, 0, 1) })} />
                <Action label="Move −0.5s" onPress={() => shiftSelectedAudio(-500)} />
                <Action label="Move +0.5s" onPress={() => shiftSelectedAudio(500)} />
                <Action label={selectedAudioClip.fadeInMs ? 'Remove fade in' : 'Fade in'} onPress={() => updateSelectedAudio({ fadeInMs: selectedAudioClip.fadeInMs ? 0 : 500 })} />
                <Action label={selectedAudioClip.fadeOutMs ? 'Remove fade out' : 'Fade out'} onPress={() => updateSelectedAudio({ fadeOutMs: selectedAudioClip.fadeOutMs ? 0 : 500 })} />
                <Action label="Duplicate" onPress={copySelectedAudio} />
                <Action label="Delete audio" danger onPress={removeSelectedAudio} />
              </ScrollView>
            </> : <Text style={{ color: palette.muted, fontSize: 12 }}>Add audio, or tap an audio block in the timeline to edit it.</Text>}
          </View>
        ) : activeTool === 'animate' ? (
          <AnimationBrowser
            selected={selectedAnimationId}
            textLayerSelected={Boolean(selectedTextLayer)}
            scope={animationScope}
            hasSelectedCaption={Boolean(selectedCaptionId)}
            onScopeChange={setAnimationScope}
            onSelect={chooseAnimation}
          />
        ) : selectedTextLayer ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            <Action label="Edit text" onPress={() => { setEditingLayerId(selectedTextLayer.id); setEditingText(selectedTextLayer.text); }} />
            <Action label="Delete text layer" danger onPress={() => deleteLayer(selectedTextLayer.id)} />
            <Action label="Add text layer" onPress={addTextLayer} />
            <Action label="Add sticker/image" onPress={() => void addImageLayer()} />
          </ScrollView>
        ) : selectedImageLayer ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            <Action label="Delete sticker" danger onPress={() => deleteLayer(selectedImageLayer.id)} />
            <Action label="Add text layer" onPress={addTextLayer} />
            <Action label="Add sticker/image" onPress={() => void addImageLayer()} />
          </ScrollView>
        ) : translationTrackSelected && selectedTranslationPair ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            <Action label="Edit both languages" color="#64E8FF" onPress={() => setDualCaptionEditorOpen(true)} />
            <Action label="Refresh this translation" onPress={() => requestTranslationRefresh([selectedTranslationPair.source.id])} />
            <Action label={selectedTranslationTrack?.visible ? 'Hide second language' : 'Show second language'} onPress={() => { void toggleSelectedTranslationTrack(); }} />
            <Action label="Remove second language" danger onPress={confirmRemoveSelectedTranslationTrack} />
            <Action label="White" color="#FFFFFF" onPress={() => queueCaptionStyleChange('Translated text color: white', { textColor: '#FFFFFF' })} />
            <Action label="Lime" color="#DFFF35" onPress={() => queueCaptionStyleChange('Translated text color: lime', { textColor: '#DFFF35' })} />
            <Action label="Uppercase" onPress={() => queueCaptionStyleChange('Uppercase translated captions', { textTransform: 'uppercase' })} />
          </ScrollView>
        ) : selectedCaption ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            <Action label="Split at playhead" onPress={splitSelectedCaptionAtPlayhead} />
            <Action label="Join previous" onPress={() => joinSelectedCaption('previous')} />
            <Action label="Join next" onPress={() => joinSelectedCaption('next')} />
            <Action label="Edit captions" onPress={beginEditCaption} />
            <Action label="Dual subtitles" color="#64E8FF" onPress={openDualCaptionEditor} />
            <Action label="Delete subtitle" danger onPress={() => confirmDeleteCaption(selectedCaption.id)} />
            <Action label="Add text layer" onPress={addTextLayer} />
            <Action label="Add sticker/image" onPress={() => void addImageLayer()} />
            <Action
              label="White"
              color="#FFFFFF"
              onPress={() => queueCaptionStyleChange('Text color: white', { textColor: '#FFFFFF' })}
            />
            <Action
              label="Lime"
              color="#DFFF35"
              onPress={() => queueCaptionStyleChange('Text color: lime', { textColor: '#DFFF35' })}
            />
            <Action
              label="Active word"
              color="#FFC247"
              onPress={() => queueCaptionStyleChange('Active-word color: amber', { activeWordColor: '#FFC247' })}
            />
            <Action
              label="Uppercase"
              onPress={() => queueCaptionStyleChange('Uppercase captions', { textTransform: 'uppercase' })}
            />
            <Action
              label="Reset all caption boxes"
              onPress={() => {
                beginHistoryInteraction();
                updateSharedCaptionTransform({ position: { x: 0.5, y: 0.78 }, box: { width: 0.86, height: 0.2 }, fontSize: 48, rotation: 0 });
                queueMicrotask(finishHistoryInteraction);
              }}
            />
          </ScrollView>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            <Action label="Add text layer" onPress={addTextLayer} />
            <Action label="Add sticker/image" onPress={() => void addImageLayer()} />
          </ScrollView>
        )}

        {error || persistenceError || translationController.error ? (
          <View style={{ padding: 12, borderRadius: 13, backgroundColor: '#351D24' }}>
            <Text selectable accessibilityRole="alert" style={{ color: '#FFBBC8', fontSize: 13 }}>{error ?? persistenceError ?? translationController.error}</Text>
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
          <ToolbarItem label="Captions" active={activeTool === 'captions'} onPress={() => { setSelectedClipId(undefined); setActiveTool('captions'); }} />
          <ToolbarItem label="Fonts" active={activeTool === 'fonts'} onPress={() => { setSelectedClipId(undefined); setActiveTool('fonts'); setFontBrowserOpen(true); }} />
          <ToolbarItem label="Animate" active={activeTool === 'animate'} onPress={() => { setSelectedClipId(undefined); setActiveTool('animate'); }} />
          <ToolbarItem label="Video" active={activeTool === 'video'} onPress={() => setActiveTool('video')} />
          <ToolbarItem label="Audio" active={activeTool === 'audio'} onPress={() => { setSelectedClipId(undefined); setActiveTool('audio'); }} />
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
        onClose={() => setExtractAudioOpen(false)}
      />
      <FontBrowser
        visible={fontBrowserOpen}
        previewText={selectedTextLayer?.text ?? selectedCaption?.text ?? activeCaption?.text ?? 'Make every word count'}
        onClose={() => setFontBrowserOpen(false)}
        onSelect={chooseFont}
      />
      <ScriptEditor
        visible={scriptEditorOpen}
        projectId={project.id}
        baseRevision={project.updatedAt}
        captions={timelineCaptions}
        words={project.transcription.words}
        initialCaptionId={selectedCaptionId ?? activeCaption?.id}
        onSelectCaption={(caption) => {
          transport.pause();
          setSelectedLayerId('captions');
          setSelectedCaptionId(caption.id);
          setSelectedClipId(undefined);
          setActiveTool('captions');
        }}
        onCancel={() => setScriptEditorOpen(false)}
        onSave={commitCaptionScript}
      />
      <DualCaptionEditor
        key={selectedTranslationTrack?.id ?? 'none'}
        visible={dualCaptionEditorOpen && Boolean(selectedTranslationTrack)}
        projectId={project.id}
        baseRevision={project.updatedAt}
        trackId={selectedTranslationTrack?.id ?? 'none'}
        sourceLanguageLabel={captionLanguageLabel(project.transcription.language)}
        targetLanguageLabel={selectedTranslationTrack?.displayName ?? 'Second language'}
        pairs={selectedTranslationPairs}
        trackVisible={selectedTranslationTrack?.visible ?? false}
        busy={Boolean(translationProgress) || translationCancelling}
        progressLabel={translationCancelling ? 'Cancelling local translation…' : translationProgressLabel(translationProgress)}
        errorMessage={translationController.error}
        onClose={() => {
          if (!translationProgress && !translationCancelling) setDualCaptionEditorOpen(false);
        }}
        onSave={saveDualCaptionEdits}
        onRefresh={requestTranslationRefresh}
        onToggleVisibility={() => { void toggleSelectedTranslationTrack(); }}
        onRemove={confirmRemoveSelectedTranslationTrack}
        onCancelBusy={() => { void cancelDualCaptionTranslation(); }}
      />
      <EditTextLayerModal
        visible={Boolean(editingLayerId)}
        value={editingText ?? ''}
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
      {exporting ? (
        <Modal visible transparent animationType="fade">
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
                  <View style={{ height: 8, overflow: 'hidden', borderRadius: 4, backgroundColor: '#303640' }}>
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
  );
}

function Action(props: { label: string; color?: string; danger?: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      disabled={props.disabled}
      onPress={props.onPress}
      style={{
        minHeight: 42,
        paddingHorizontal: 13,
        flexDirection: 'row',
        gap: 7,
        alignItems: 'center',
        borderRadius: 13,
        borderWidth: props.danger ? 1 : 0,
        borderColor: props.danger ? '#7A2B38' : 'transparent',
        backgroundColor: props.danger ? '#351D24' : palette.surfaceRaised,
        opacity: props.disabled ? 0.35 : 1,
      }}>
      {props.color ? <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: props.color }} /> : null}
      <Text style={{ color: props.danger ? '#FFBBC8' : palette.text, fontSize: 12, fontWeight: '700' }}>{props.label}</Text>
    </Pressable>
  );
}

function HistoryButton(props: { label: string; disabled: boolean; version: number; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label.replace(/[↶↷]/g, '').trim()}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{ minWidth: 108, minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 14, borderWidth: 1, borderColor: props.disabled ? '#29313A' : '#6A42A8', backgroundColor: props.disabled ? '#171C22' : '#2B1C42', opacity: props.disabled ? 0.45 : 1 }}>
      <Text style={{ color: props.disabled ? '#76818D' : '#DDBEFF', fontSize: 13, fontWeight: '900' }}>{props.label}</Text>
    </Pressable>
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
    <Modal visible transparent animationType="fade" onRequestClose={props.onCancel}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 26, backgroundColor: 'rgba(0,0,0,0.82)' }}>
        <View style={{ width: '100%', maxWidth: 380, gap: 16, padding: 22, borderRadius: 24, backgroundColor: '#171C22' }}>
          <ActivityIndicator color={palette.accent} size="large" />
          <Text style={{ color: palette.text, textAlign: 'center', fontSize: 20, fontWeight: '800' }}>
            {stageTitle(props.progress.stage)}
          </Text>
          <Text style={{ color: palette.muted, textAlign: 'center', fontSize: 14 }}>{props.progress.detail}</Text>
          <View style={{ height: 8, overflow: 'hidden', borderRadius: 4, backgroundColor: '#303640' }}>
            <View style={{ width: `${percent}%`, height: '100%', backgroundColor: palette.accent }} />
          </View>
          <Text style={{ color: palette.text, textAlign: 'center', fontVariant: ['tabular-nums'] }}>{percent}%</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel caption generation"
            disabled={props.cancelling}
            onPress={props.onCancel}
            style={{ minHeight: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 13, backgroundColor: '#2A3038', opacity: props.cancelling ? 0.55 : 1 }}>
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
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.onCancel}>
      <View style={{ flex: 1, justifyContent: 'center', padding: 24, backgroundColor: 'rgba(0,0,0,0.72)' }}>
        <View style={{ gap: 14, padding: 20, borderRadius: 22, backgroundColor: '#181D24' }}>
          <Text style={{ color: palette.text, fontSize: 20, fontWeight: '800' }}>Edit text layer</Text>
          <TextInput
            autoFocus
            multiline
            value={props.value}
            onChangeText={props.onChange}
            style={{ minHeight: 110, padding: 14, borderRadius: 14, color: palette.text, backgroundColor: '#252C35', textAlignVertical: 'top' }}
          />
          <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'flex-end' }}>
            <Pressable onPress={props.onCancel} style={{ padding: 12 }}>
              <Text style={{ color: palette.muted }}>Cancel</Text>
            </Pressable>
            <Pressable onPress={props.onSave} style={{ paddingHorizontal: 18, paddingVertical: 12, borderRadius: 999, backgroundColor: palette.accent }}>
              <Text style={{ color: '#11140C', fontWeight: '800' }}>Save</Text>
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

function captionLanguageLabel(languageTag: string) {
  try {
    const language = normalizeEnglishChineseCaptionLanguage(languageTag);
    if (language === 'en') return 'English';
    return language === 'zh-Hant' ? 'Chinese (Traditional)' : 'Chinese (Simplified)';
  } catch {
    return languageTag;
  }
}

function translationProgressLabel(progress?: CaptionTranslationProgress) {
  if (!progress) return undefined;
  if (progress.progress == null) return progress.detail;
  return `${progress.detail} · ${Math.round(progress.progress * 100)}%`;
}

function confirmReviewedTranslationReplacement(languageName: string) {
  return new Promise<boolean>((resolve) => {
    Alert.alert(
      'Replace reviewed translation?',
      `At least one ${languageName} line was edited by a person. Automatic sync will replace it; Undo can restore both languages.`,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Replace + sync', style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

function exportProgressLabel(progress: TimelineVideoExportProgress) {
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

function fitRect(aspect: number, maxWidth: number, maxHeight: number) {
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
