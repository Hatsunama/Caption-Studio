import { commitTranslationAttempt, translationAttemptMessage } from '@/lib/translation-attempt';
import { automaticTranslationCueWrites } from '@/lib/caption-translation-commit';
import { canAutomaticallyTranslatePair, captionLanguageFamily } from '@/lib/caption-languages';
import { projectPrimaryCaptionLanguage, resolveCaptionPairs, setTranslationTrackProvider } from '@/lib/caption-tracks';
import { visibleTimelineCaptions } from '@/lib/video-timeline';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import {
  cancelNaturalCaptionTranslation,
  CaptionTranslationCancelledError,
  translateNaturalCaptionBatch,
  type CaptionTranslationProgress,
} from '@/services/caption-translation';
import {
  synchronizeProjectDualCaptionEdits,
  type DualCaptionTextEdit,
} from '@/services/project-caption-translation';
import type { CaptionProject } from '@/types/project';

type ControllerOptions = {
  getCurrentProject: () => CaptionProject;
  commitProject: (baseline: CaptionProject, next: CaptionProject) => Promise<void>;
  commitManualEdits: (baseline: CaptionProject, trackId: string, edits: readonly DualCaptionTextEdit[]) => Promise<void>;
};

type TranslationOperation = (
  onProgress: (next: CaptionTranslationProgress) => void,
  onAcceptedBatch: (apply: (current: CaptionProject) => CaptionProject) => Promise<boolean>,
) => Promise<CaptionProject>;

type TranslationRequest = {
  kind: 'translation' | 'manual-save';
  baseline: CaptionProject;
  operation: TranslationOperation;
  completionMessage?: (next: CaptionProject) => string | undefined;
  incremental?: boolean;
  manualEdits?: { trackId: string; edits: readonly DualCaptionTextEdit[] };
  retryWith?: (project: CaptionProject) => TranslationRequest;
};

function interruptedOperationLabel(stage: CaptionTranslationProgress['stage'] | undefined) {
  return stage === 'downloading-model' ? 'language-model download' : 'translation';
}

async function refreshIncremental(
  project: CaptionProject,
  trackId: string,
  sourceCaptionIds: readonly string[],
  onProgress: (progress: CaptionTranslationProgress) => void,
  onAcceptedBatch: (apply: (current: CaptionProject) => CaptionProject) => Promise<boolean>,
) {
  const track = project.captionTracks.translations.find((candidate) => candidate.id === trackId);
  if (!track) throw new Error('The second-language caption track no longer exists.');
  const sourceLanguage = projectPrimaryCaptionLanguage(project);
  if (captionLanguageFamily(track.sourceLanguageTag) !== captionLanguageFamily(sourceLanguage)
    || !canAutomaticallyTranslatePair(sourceLanguage, track.languageTag)) {
    throw new Error('The second-language track no longer matches an available translation direction.');
  }
  const context = visibleTimelineCaptions(project.captions);
  const eligible = new Set(resolveCaptionPairs(project, trackId)
    .filter((pair) => pair.timelineVisible).map((pair) => pair.source.id));
  const selected = new Set(sourceCaptionIds);
  const captions = project.captions.filter((caption) => selected.has(caption.id)
    && eligible.has(caption.id) && caption.text.trim());
  if (!captions.length) return project;
  const originalCues = new Map(track.cues.map((cue) => [cue.sourceCaptionId, cue]));
  await translateNaturalCaptionBatch({
    sourceLanguage,
    targetLanguage: track.languageTag,
    captions: captions.map(({ id, text }) => ({ id, text })),
    allCaptions: context.map(({ id, text }) => ({ id, text })),
    onProgress,
    onAcceptedBatch: async (batch) => {
      const batchCaptions = captions.filter((caption) => batch.captions.has(caption.id));
      if (batchCaptions.length !== batch.captions.size) {
        throw new Error('The translation batch no longer matches the selected subtitles. Refresh to retry.');
      }
      const committed = await onAcceptedBatch((current) => {
        const currentTrack = current.captionTracks.translations.find((candidate) => candidate.id === trackId);
        if (!currentTrack || currentTrack.languageTag !== track.languageTag
          || currentTrack.sourceLanguageTag !== track.sourceLanguageTag
          || projectPrimaryCaptionLanguage(current) !== sourceLanguage) return current;
        const currentContext = visibleTimelineCaptions(current.captions);
        if (currentContext.length !== context.length || context.some((caption, index) =>
          currentContext[index].id !== caption.id || currentContext[index].text !== caption.text)) return current;
        const currentCues = new Map(currentTrack.cues.map((cue) => [cue.sourceCaptionId, cue]));
        const safe = batchCaptions.filter((caption) => {
          const source = current.captions.find((candidate) => candidate.id === caption.id);
          const originalCue = originalCues.get(caption.id);
          const cue = currentCues.get(caption.id);
          return source?.text === caption.text && source.timelineVisible !== false
            && originalCue && cue && cue.text === originalCue.text
            && cue.status === originalCue.status && cue.reviewed === originalCue.reviewed
            && cue.sourceTextSnapshot === originalCue.sourceTextSnapshot;
        });
        if (safe.length !== batchCaptions.length) return current;
        const writes = automaticTranslationCueWrites({
          captions: safe,
          translatedById: batch.captions,
          previousById: new Map(currentTrack.cues.map((cue) => [cue.sourceCaptionId, cue.text])),
          needsReviewById: batch.needsReview,
          targetLanguage: track.languageTag,
        });
        const withProvider = setTranslationTrackProvider(current, trackId, batch.provider, sourceLanguage, new Date().toISOString());
        return commitTranslationAttempt(withProvider, trackId, safe, writes, batch.failureReasons);
      });
      if (!committed) throw new Error('The project changed before the translation batch was saved. Refresh to retry without overwriting newer edits.');
    },
  });
  return project;
}

export function useProjectCaptionTranslation(options: ControllerOptions) {
  const optionsRef = useRef(options);
  const mountedRef = useRef(true);
  const activeOperationRef = useRef<symbol | undefined>(undefined);
  const activeKindRef = useRef<TranslationRequest['kind'] | undefined>(undefined);
  const activeStageRef = useRef<CaptionTranslationProgress['stage'] | undefined>(undefined);
  const interruptedRef = useRef(false);
  const retryRequestRef = useRef<TranslationRequest | undefined>(undefined);
  const [progress, setProgress] = useState<CaptionTranslationProgress>();
  const [cancelling, setCancelling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [warning, setWarning] = useState<string>();
  const [retryAvailable, setRetryAvailable] = useState(false);

  useLayoutEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (activeKindRef.current === 'translation') void cancelNaturalCaptionTranslation();
    };
  }, []);

  useEffect(() => {
    const onAppStateChange = (state: AppStateStatus) => {
      if (state === 'active' || activeKindRef.current !== 'translation') return;
      interruptedRef.current = true;
      void cancelNaturalCaptionTranslation();
    };
    const subscription = AppState.addEventListener('change', onAppStateChange);
    return () => subscription.remove();
  }, []);

  const execute = useCallback(async (request: TranslationRequest) => {
    if (!mountedRef.current) return false;
    if (activeOperationRef.current) {
      if (mountedRef.current) setError('Wait for the current subtitle operation to finish before starting another.');
      return false;
    }
    const { kind, baseline, operation, completionMessage } = request;
    const operationId = Symbol('project-caption-translation');
    activeOperationRef.current = operationId;
    activeKindRef.current = kind;
    activeStageRef.current = kind === 'translation' ? 'loading-model' : undefined;
    interruptedRef.current = false;
    retryRequestRef.current = undefined;
    setError(undefined);
    setWarning(undefined);
    setRetryAvailable(false);
    setCancelling(false);
    setSaving(kind === 'manual-save');
    setProgress(kind === 'translation'
      ? { stage: 'loading-model', progress: null, detail: 'Preparing local natural translation' }
      : undefined);
    try {
      const next = await operation((nextProgress) => {
        if (kind !== 'translation' || activeOperationRef.current !== operationId) return;
        activeStageRef.current = nextProgress.stage;
        if (mountedRef.current && activeOperationRef.current === operationId) setProgress(nextProgress);
      }, async (apply) => {
        const current = optionsRef.current.getCurrentProject();
        const updated = apply(current);
        if (updated === current) return false;
        await optionsRef.current.commitProject(current, updated);
        return true;
      });
      if (!mountedRef.current || activeOperationRef.current !== operationId) return false;
      if (kind === 'translation' && interruptedRef.current) throw new CaptionTranslationCancelledError();
      if (request.incremental) {
        const message = completionMessage?.(optionsRef.current.getCurrentProject());
        if (message) {
          setWarning(message);
          retryRequestRef.current = request.retryWith?.(optionsRef.current.getCurrentProject()) ?? request;
          setRetryAvailable(true);
          return false;
        }
        return true;
      }
      // A durable commit is not a cancellable native translation operation.
      activeKindRef.current = 'manual-save';
      if (request.manualEdits) {
        await optionsRef.current.commitManualEdits(baseline, request.manualEdits.trackId, request.manualEdits.edits);
      } else {
        if (optionsRef.current.getCurrentProject() !== baseline) {
          throw new Error('The project changed while both languages were synchronizing. Save again to avoid overwriting newer edits.');
        }
        if (next !== baseline) await optionsRef.current.commitProject(baseline, next);
      }
      const message = completionMessage?.(next);
      if (message && mountedRef.current) {
        setWarning(message);
        return false;
      }
      return true;
    } catch (caught) {
      if (mountedRef.current && activeOperationRef.current === operationId && interruptedRef.current) {
        const action = interruptedOperationLabel(activeStageRef.current);
        retryRequestRef.current = request.retryWith?.(optionsRef.current.getCurrentProject()) ?? request;
        setRetryAvailable(true);
        setError(`The ${action} paused because Caption Studio left the foreground. Downloaded model bytes and completed translation checkpoints were kept.`);
      } else if (
        mountedRef.current
        && activeOperationRef.current === operationId
        && !(caught instanceof CaptionTranslationCancelledError)
      ) {
        if (kind === 'translation') {
          retryRequestRef.current = request.retryWith?.(optionsRef.current.getCurrentProject()) ?? request;
          setRetryAvailable(true);
        }
        setError(caught instanceof Error ? caught.message
          : kind === 'manual-save' ? 'Dual-subtitle edits could not be saved.' : 'Natural caption translation failed.');
      }
      return false;
    } finally {
      if (activeOperationRef.current === operationId) {
        activeOperationRef.current = undefined;
        activeKindRef.current = undefined;
        activeStageRef.current = undefined;
        if (mountedRef.current) {
          setCancelling(false);
          setSaving(false);
          setProgress(undefined);
        }
      }
    }
  }, []);

  const retry = useCallback(() => {
    const request = retryRequestRef.current;
    return request ? execute(request) : Promise.resolve(false);
  }, [execute]);

  const clearError = useCallback(() => {
    retryRequestRef.current = undefined;
    setRetryAvailable(false);
    setError(undefined);
    setWarning(undefined);
  }, []);

  const refresh = useCallback((
    trackId: string,
    sourceCaptionIds: readonly string[],
    baseline = optionsRef.current.getCurrentProject(),
  ) => {
    const makeRequest = (project: CaptionProject): TranslationRequest => ({
      kind: 'translation',
      baseline: project,
      incremental: true,
      retryWith: (latest) => makeRequest(latest),
      operation: (onProgress, onAcceptedBatch) => refreshIncremental(
        project,
        trackId,
        sourceCaptionIds,
        onProgress,
        onAcceptedBatch,
      ),
      completionMessage: (next) => translationAttemptMessage(next, trackId, sourceCaptionIds),
    });
    return execute(makeRequest(baseline));
  }, [execute]);

  const synchronize = useCallback((
    trackId: string,
    edits: readonly DualCaptionTextEdit[],
    baseline = optionsRef.current.getCurrentProject(),
  ) => execute({
    kind: 'manual-save',
    baseline,
    manualEdits: { trackId, edits },
    operation: () => synchronizeProjectDualCaptionEdits({
      project: baseline,
      trackId,
      edits,
    }),
  }), [execute]);

  const cancel = useCallback(async () => {
    if (activeKindRef.current !== 'translation') return false;
    if (mountedRef.current) setCancelling(true);
    const cancelled = await cancelNaturalCaptionTranslation();
    if (!cancelled && mountedRef.current) setCancelling(false);
    return cancelled;
  }, []);

  return {
    busy: saving || Boolean(progress) || cancelling,
    saving,
    progress,
    cancelling,
    error,
    warning,
    retryAvailable,
    clearError,
    retry,
    refresh,
    synchronize,
    cancel,
  };
}
