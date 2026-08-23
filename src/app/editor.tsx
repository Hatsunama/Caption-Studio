import { useEffect, useMemo, useRef, useState } from 'react';
import type { NavigationAction } from '@react-navigation/native';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { VideoView } from 'expo-video';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
import { FontBrowser } from '@/components/editor/font-browser';
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
import { deleteAudioClip, duplicateAudioClip, moveAudioClip, trimAudioClip, updateAudioClip } from '@/lib/audio-timeline';
import { findAnimationPreset } from '@/lib/animation-presets';
import { deletePersonKeyframe, resolvePersonTransform, upsertPersonKeyframe } from '@/lib/person-motion';
import {
  mergeCaptionScriptBlock,
  splitCaptionScriptBlockAtTime,
  type CaptionScriptMutation,
} from '@/lib/caption-script';
import { fontChoicePatch, type FontChoice } from '@/lib/font-catalog';
import { TRANSCRIPTION_MODELS, type TranscriptionModel } from '@/lib/model-catalog';
import { VIDEO_TRANSITION_PRESETS } from '@/lib/transition-presets';
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
  setVideoTransform,
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
  videoTransitionOverlay,
} from '@/lib/video-timeline';
import { pickAndStoreImage, pickBackgroundMedia, type MediaImportProgress } from '@/services/media-import';
import { renderPersonPreview } from '@/services/person-compositor';
import { validateProjectSources } from '@/services/project-media';
import {
  appendVideosToProject,
  appendAudioToProject,
  checkpointEditorProject,
  discardEditorSession,
  generateAndSaveProjectCaptions,
  loadProjectForEditing,
  saveEditorDraft,
} from '@/services/project-workflows';
import type { TranscriptionProgress } from '@/services/transcription';
import {
  type CaptionAnimationId,
  type CaptionProject,
  type CaptionStylePatch,
  type ImageVisualLayer,
  type VideoClip,
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

  useEffect(() => {
    projectRef.current = project;
  }, [project]);
  const [selectedCaptionId, setSelectedCaptionId] = useState<string>();
  const [selectedLayerId, setSelectedLayerId] = useState('captions');
  const [selectedClipId, setSelectedClipId] = useState<string>();
  const [selectedAudioClipId, setSelectedAudioClipId] = useState<string>();
  const [progress, setProgress] = useState<TranscriptionProgress>();
  const [mediaProgress, setMediaProgress] = useState<MediaImportProgress>();
  const [error, setError] = useState<string>();
  const [fontBrowserOpen, setFontBrowserOpen] = useState(false);
  const [pendingChange, setPendingChange] = useState<PendingStyleChange>();
  const [editingText, setEditingText] = useState<string>();
  const [editingLayerId, setEditingLayerId] = useState<string>();
  const [scriptEditorOpen, setScriptEditorOpen] = useState(false);
  const [personPreviewUri, setPersonPreviewUri] = useState<string>();
  const [personPreviewBusy, setPersonPreviewBusy] = useState(false);
  const [activeTool, setActiveTool] = useState<EditorTool>('captions');
  const [animationScope, setAnimationScope] = useState<StyleScope>('all');
  const undoStackRef = useRef<CaptionProject[]>([]);
  const redoStackRef = useRef<CaptionProject[]>([]);
  const interactionStartRef = useRef<CaptionProject | undefined>(undefined);
  const [historyVersion, setHistoryVersion] = useState(0);
  const exitApprovedRef = useRef(false);
  const exitPromptOpenRef = useRef(false);
  const pendingExitActionRef = useRef<NavigationAction | undefined>(undefined);

  const persistProject = async (next: CaptionProject) => {
    try {
      await checkpointEditorProject(next);
    } catch (caught) {
      setError(caught instanceof Error ? `Project could not be saved: ${caught.message}` : 'Project could not be saved.');
    }
  };

  const transport = useTimelineVideoController(project, setError);
  const { player, currentMs, isPlaying } = transport;
  useTimelineAudioController(project, currentMs, isPlaying);
  const pauseTransport = transport.pause;

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
          const saved = await saveEditorDraft(projectRef.current);
          projectRef.current = saved;
          setProject(saved);
        } else {
          await discardEditorSession(initialProject, projectRef.current);
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
  const activeCaption = useMemo(
    () => timelineCaptions.find((caption) => currentMs >= caption.startMs && currentMs < caption.endMs),
    [currentMs, timelineCaptions],
  );
  const selectedCaption = timelineCaptions.find((caption) => caption.id === selectedCaptionId);
  const selectedClip = project.clips.find((clip) => clip.id === selectedClipId);
  const selectedAudioClip = project.audioClips.find((clip) => clip.id === selectedAudioClipId);
  const selectedLayer = project.layers.find((layer) => layer.id === selectedLayerId);
  const selectedTextLayer = selectedLayer?.kind === 'text' ? selectedLayer : undefined;
  const selectedImageLayer = selectedLayer?.kind === 'image' ? selectedLayer : undefined;
  const selectedAnimationId = selectedTextLayer
    ? selectedTextLayer.style.animation.id
    : selectedCaption
      ? resolveCaptionStyle(project.projectStyle, selectedCaption).animation.id
      : project.projectStyle.animation.id;
  const displayCaption = isPlaying ? activeCaption : selectedCaption ?? activeCaption;
  const previewHeight = Math.min(Math.max(280, height * 0.43), 500);
  const canvasSize = fitRect(
    Math.max(1, project.canvas.aspectWidth / project.canvas.aspectHeight),
    width - 24,
    previewHeight - 8,
  );
  const transitionOverlay = videoTransitionOverlay(clipTimeline, currentMs);
  const currentClipEntry = timelineEntryAt(clipTimeline, currentMs);
  const personPreviewTimeMs = Math.floor(currentMs / 250) * 250;

  useEffect(() => {
    if (!project.backgroundReplacement.enabled || !currentClipEntry) {
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
      }).then((uri) => {
        if (active) setPersonPreviewUri(uri);
      }).catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : 'Background preview failed.');
      }).finally(() => {
        if (active) setPersonPreviewBusy(false);
      });
    }, isPlaying ? 160 : 80);
    return () => { active = false; clearTimeout(timer); };
  }, [currentClipEntry, isPlaying, personPreviewTimeMs, project.backgroundReplacement, project.id, project.sources]);

  const pushUndo = (snapshot = projectRef.current) => {
    const stack = undoStackRef.current;
    if (stack.at(-1) !== snapshot) stack.push(snapshot);
    if (stack.length > 50) stack.shift();
    redoStackRef.current = [];
    setHistoryVersion((value) => value + 1);
  };

  const beginHistoryInteraction = () => {
    interactionStartRef.current ??= projectRef.current;
  };

  const finishHistoryInteraction = () => {
    const snapshot = interactionStartRef.current;
    interactionStartRef.current = undefined;
    if (snapshot && snapshot !== projectRef.current) pushUndo(snapshot);
    persistProject(projectRef.current);
  };

  const undo = () => {
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    redoStackRef.current.push(projectRef.current);
    interactionStartRef.current = undefined;
    projectRef.current = previous;
    transport.synchronizeProject(previous);
    setProject(previous);
    setSelectedCaptionId((id) => previous.captions.some((caption) => caption.id === id) ? id : previous.captions[0]?.id);
    setSelectedLayerId((id) => previous.layers.some((layer) => layer.id === id) ? id : 'captions');
    setHistoryVersion((value) => value + 1);
    persistProject(previous);
  };

  const redo = () => {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push(projectRef.current);
    interactionStartRef.current = undefined;
    projectRef.current = next;
    transport.synchronizeProject(next);
    setProject(next);
    setSelectedCaptionId((id) => next.captions.some((caption) => caption.id === id) ? id : next.captions[0]?.id);
    setSelectedLayerId((id) => next.layers.some((layer) => layer.id === id) ? id : 'captions');
    setHistoryVersion((value) => value + 1);
    persistProject(next);
  };

  const generateCaptions = async (modelId: TranscriptionModel['id']) => {
    setError(undefined);
    try {
      const next = await generateAndSaveProjectCaptions(projectRef.current, modelId, setProgress);
      pushUndo();
      projectRef.current = next;
      setProject(next);
      setSelectedCaptionId(next.captions[0]?.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Caption generation failed');
    } finally {
      setProgress(undefined);
    }
  };

  const chooseCaptionQuality = (replacingExisting: boolean) => {
    const modelDescription = TRANSCRIPTION_MODELS
      .map((model) => `${model.label}: ${model.description}`)
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
    pushUndo();
    const next = applyStylePatch(
      projectRef.current,
      selectedCaptionId ?? '',
      scope,
      pendingChange.patch,
    );
    projectRef.current = next;
    setProject(next);
    setPendingChange(undefined);
    await persistProject(next);
  };

  const chooseFont = (choice: FontChoice) => {
    setFontBrowserOpen(false);
    if (selectedTextLayer) {
      updateTextLayerStyle(selectedTextLayer.id, fontChoicePatch(choice), true);
      return;
    }
    setPendingChange({
      label: `Font: ${choice.name}`,
      patch: fontChoicePatch(choice),
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
    pushUndo();
    setProject((current) => {
      const next = applyStylePatch(current, selectedCaptionId ?? '', scope, {
        animation: { id, intensity: preset.intensity, durationMs: preset.durationMs },
      });
      projectRef.current = next;
      persistProject(next);
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
    pushUndo();
    const next = setTextLayerText(projectRef.current, editingLayerId, editingText);
    projectRef.current = next;
    setProject(next);
    setEditingLayerId(undefined);
    setEditingText(undefined);
    await persistProject(next);
  };

  const commitCaptionScript = async (captions: CaptionProject['captions']) => {
    const before = projectRef.current;
    const next = replaceVisibleCaptionScript(before, captions);
    if (next !== before) {
      pushUndo(before);
      projectRef.current = next;
      setProject(next);
      if (!next.captions.some((caption) => caption.id === selectedCaptionId && caption.timelineVisible !== false)) {
        setSelectedCaptionId(captions[0]?.id);
      }
      await persistProject(next);
    }
    setScriptEditorOpen(false);
  };

  const commitCaptionStructure = (mutation: CaptionScriptMutation) => {
    const before = projectRef.current;
    const next = replaceVisibleCaptionScript(before, mutation.captions);
    if (next === before) return;
    pushUndo(before);
    projectRef.current = next;
    setProject(next);
    setSelectedCaptionId(mutation.focusedId);
    persistProject(next);
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
    commitCaptionStructure(mutation);
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
    commitCaptionStructure(mutation);
  };

  const updateTextLayerStyle = (layerId: string, patch: CaptionStylePatch, persist = false) => {
    if (persist) pushUndo();
    setProject((current) => {
      const next = setTextLayerStyle(current, layerId, patch);
      projectRef.current = next;
      if (persist) persistProject(next);
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

  const updateVideoTransform = (patch: Partial<CaptionProject['videoTransform']>) => {
    setProject((current) => {
      const next = setVideoTransform(current, patch);
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
      persistProject(next);
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
      persistProject(next);
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
      persistProject(next);
      return next;
    });
  };

  const deleteLayer = (layerId: string) => {
    if (layerId === 'captions') return;
    pushUndo();
    setProject((current) => {
      const next = deleteVisualLayer(current, layerId);
      projectRef.current = next;
      persistProject(next);
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
    persistProject(next);
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
    persistProject(next);
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
    persistProject(result.project);
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
    persistProject(next);
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
    persistProject(next);
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
    persistProject(result.project);
    transport.pause();
    queueMicrotask(() => transport.seek(result.seekMs));
  };

  const addAudio = async (origin: 'audio-file' | 'video-audio') => {
    transport.pause();
    setError(undefined);
    try {
      const before = projectRef.current;
      const result = await appendAudioToProject(before, currentMs, origin);
      if (!result) return;
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

  const commitAudioProject = (next: CaptionProject) => {
    projectRef.current = next;
    setProject(next);
    void persistProject(next);
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
    void persistProject(next);
  };

  const reorderSelectedVideo = (direction: -1 | 1) => {
    if (!selectedClipId) return;
    pushUndo();
    const next = moveVideoClip(projectRef.current, selectedClipId, direction);
    projectRef.current = next;
    transport.synchronizeProject(next);
    setProject(next);
    void persistProject(next);
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
    persistProject(next);
  };

  const confirmDeleteCaption = (captionId: string) => {
    Alert.alert('Delete this subtitle?', 'Only this caption block will be removed. The source video is unchanged.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteCaption(captionId) },
    ]);
  };

  const setCanvasPreset = async (preset: CaptionProject['canvas']['preset']) => {
    pushUndo();
    const next = applyCanvasPreset(projectRef.current, preset);
    projectRef.current = next;
    setProject(next);
    await persistProject(next);
  };

  const updateBackgroundReplacement = (backgroundReplacement: CaptionProject['backgroundReplacement']) => {
    const before = projectRef.current;
    pushUndo(before);
    const next = applyBackgroundReplacement(before, backgroundReplacement);
    projectRef.current = next;
    setProject(next);
    void persistProject(next);
  };

  const chooseBackgroundMedia = async () => {
    try {
      const source = await pickBackgroundMedia(projectRef.current.id);
      if (!source) return;
      updateBackgroundReplacement({ ...projectRef.current.backgroundReplacement, enabled: true, source });
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
                { translateX: (project.videoTransform.position.x - 0.5) * canvasSize.width },
                { translateY: (project.videoTransform.position.y - 0.5) * canvasSize.height },
                { scale: project.videoTransform.scale },
                { rotate: `${project.videoTransform.rotation}deg` },
              ],
            }}>
            <VideoView
              style={{ flex: 1, opacity: project.backgroundReplacement.enabled ? 0 : 1 }}
              player={player}
              nativeControls={false}
              contentFit={project.videoTransform.fit === 'fill' ? 'cover' : 'contain'}
              surfaceType="textureView"
              useExoShutter
            />
            {project.backgroundReplacement.enabled && currentClipEntry && personPreviewUri ? (
              <Image pointerEvents="none" source={personPreviewUri} cachePolicy="none" contentFit="contain" style={{ position: 'absolute', inset: 0 }} />
            ) : null}
            {project.backgroundReplacement.enabled && personPreviewBusy && !personPreviewUri ? (
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
          </View>
          <VideoTransitionOverlay overlay={transitionOverlay} />
          {activeTool === 'video' ? (
            <VideoTransformOverlay
              transform={project.videoTransform}
              onInteractionStart={beginHistoryInteraction}
              onChange={updateVideoTransform}
              onEnd={finishHistoryInteraction}
            />
          ) : null}
          {[...timelineLayers].reverse().map((layer) => {
            if (!layer.visible) return null;
            if (layer.kind === 'captions') {
              return (
                <CaptionOverlay
                  key={layer.id}
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
            </View>
          )}
        </View>

        <LayerTimeline
          durationMs={timelineDurationMs}
          clips={project.clips}
          layers={timelineLayers}
          captions={timelineCaptions}
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
                  {VIDEO_TRANSITION_PRESETS.map((preset) => <Action key={preset.id} label={preset.name} color={selectedClip.transitionAfter.type === preset.id ? '#DFFF35' : undefined} onPress={() => applyTransition(preset.id, preset.durationMs)} />)}
                  {[250, 500, 1000].map((duration) => <Action key={duration} label={`${duration} ms transition`} color={selectedClip.transitionAfter.durationMs === duration ? '#64E8FF' : undefined} onPress={() => applyTransition(selectedClip.transitionAfter.type === 'none' ? 'dip-black' : selectedClip.transitionAfter.type, duration)} />)}
                </ScrollView>
              </View>
            ) : <Text style={{ color: palette.muted, fontSize: 12 }}>Tap a video clip in the timeline to edit that clip.</Text>}
            <VideoTools
              project={project}
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
        ) : selectedCaption ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            <Action label="Split at playhead" onPress={splitSelectedCaptionAtPlayhead} />
            <Action label="Join previous" onPress={() => joinSelectedCaption('previous')} />
            <Action label="Join next" onPress={() => joinSelectedCaption('next')} />
            <Action label="Edit captions" onPress={beginEditCaption} />
            <Action label="Delete subtitle" danger onPress={() => confirmDeleteCaption(selectedCaption.id)} />
            <Action label="Add text layer" onPress={addTextLayer} />
            <Action label="Add sticker/image" onPress={() => void addImageLayer()} />
            <Action
              label="White"
              color="#FFFFFF"
              onPress={() => setPendingChange({ label: 'Text color: white', patch: { textColor: '#FFFFFF' } })}
            />
            <Action
              label="Lime"
              color="#DFFF35"
              onPress={() => setPendingChange({ label: 'Text color: lime', patch: { textColor: '#DFFF35' } })}
            />
            <Action
              label="Active word"
              color="#FFC247"
              onPress={() => setPendingChange({ label: 'Active-word color: amber', patch: { activeWordColor: '#FFC247' } })}
            />
            <Action
              label="Uppercase"
              onPress={() => setPendingChange({ label: 'Uppercase captions', patch: { textTransform: 'uppercase' } })}
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

        {error ? (
          <View style={{ padding: 12, borderRadius: 13, backgroundColor: '#351D24' }}>
            <Text selectable style={{ color: '#FFBBC8', fontSize: 13 }}>{error}</Text>
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
        </View>
      </View>

      <ScopeSheet
        visible={Boolean(pendingChange)}
        changeLabel={pendingChange?.label ?? ''}
        hasSelectedCaption={Boolean(selectedCaptionId)}
        onChoose={chooseStyleScope}
        onClose={() => setPendingChange(undefined)}
      />
      <FontBrowser
        visible={fontBrowserOpen}
        previewText={selectedTextLayer?.text ?? selectedCaption?.text ?? activeCaption?.text ?? 'Make every word count'}
        onClose={() => setFontBrowserOpen(false)}
        onSelect={chooseFont}
      />
      <ScriptEditor
        visible={scriptEditorOpen}
        captions={timelineCaptions}
        words={project.transcription.words}
        initialCaptionId={selectedCaptionId ?? activeCaption?.id}
        onSelectCaption={(caption) => {
          transport.pause();
          setSelectedLayerId('captions');
          setSelectedCaptionId(caption.id);
          setSelectedClipId(undefined);
          setActiveTool('captions');
          seekTimeline(caption.startMs);
        }}
        onCancel={() => setScriptEditorOpen(false)}
        onSave={commitCaptionScript}
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
      <ProgressOverlay progress={progress} />
      <MediaLoadingOverlay progress={mediaProgress} />
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

function ProgressOverlay(props: { progress?: TranscriptionProgress }) {
  if (!props.progress) return null;
  const percent = Math.round(props.progress.progress * 100);
  return (
    <Modal visible transparent animationType="fade">
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
          <Text style={{ color: '#6F7985', textAlign: 'center', fontSize: 11 }}>
            Keep the app open during this first device milestone.
          </Text>
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
