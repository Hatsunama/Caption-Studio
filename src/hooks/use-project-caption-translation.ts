import { translationAttemptMessage } from '@/lib/translation-attempt';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import {
  cancelNaturalCaptionTranslation,
  CaptionTranslationCancelledError,
  type CaptionTranslationProgress,
} from '@/services/caption-translation';
import {
  refreshProjectCaptionTranslation,
  synchronizeProjectDualCaptionEdits,
  type DualCaptionTextEdit,
} from '@/services/project-caption-translation';
import type { CaptionProject } from '@/types/project';

type ControllerOptions = {
  getCurrentProject: () => CaptionProject;
  commitProject: (baseline: CaptionProject, next: CaptionProject) => Promise<void>;
};

type TranslationOperation = (
  onProgress: (next: CaptionTranslationProgress) => void,
) => Promise<CaptionProject>;

type TranslationRequest = {
  kind: 'translation' | 'manual-save';
  baseline: CaptionProject;
  operation: TranslationOperation;
  completionMessage?: (next: CaptionProject) => string | undefined;
};

function interruptedOperationLabel(stage: CaptionTranslationProgress['stage'] | undefined) {
  return stage === 'downloading-model' ? 'language-model download' : 'translation';
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
      });
      if (!mountedRef.current || activeOperationRef.current !== operationId) return false;
      if (kind === 'translation' && interruptedRef.current) throw new CaptionTranslationCancelledError();
      if (optionsRef.current.getCurrentProject() !== baseline) {
        throw new Error('The project changed while both languages were synchronizing. Save again to avoid overwriting newer edits.');
      }
      // A durable commit is not a cancellable native translation operation.
      activeKindRef.current = 'manual-save';
      if (next !== baseline) await optionsRef.current.commitProject(baseline, next);
      const message = completionMessage?.(next);
      if (message && mountedRef.current) {
        setError(message);
        return false;
      }
      return true;
    } catch (caught) {
      if (mountedRef.current && activeOperationRef.current === operationId && interruptedRef.current) {
        const action = interruptedOperationLabel(activeStageRef.current);
        retryRequestRef.current = request;
        setRetryAvailable(true);
        setError(`The ${action} paused because Caption Studio left the foreground. Downloaded model bytes and completed translation checkpoints were kept.`);
      } else if (
        mountedRef.current
        && activeOperationRef.current === operationId
        && !(caught instanceof CaptionTranslationCancelledError)
      ) {
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

  const run = useCallback((
    baseline: CaptionProject,
    operation: TranslationOperation,
    completionMessage?: (next: CaptionProject) => string | undefined,
  ) => execute({ kind: 'translation', baseline, operation, completionMessage }), [execute]);

  const retry = useCallback(() => {
    const request = retryRequestRef.current;
    return request ? execute(request) : Promise.resolve(false);
  }, [execute]);

  const clearError = useCallback(() => {
    retryRequestRef.current = undefined;
    setRetryAvailable(false);
    setError(undefined);
  }, []);

  const refresh = useCallback((
    trackId: string,
    sourceCaptionIds: readonly string[],
    baseline = optionsRef.current.getCurrentProject(),
  ) => run(
    baseline,
    (onProgress) => refreshProjectCaptionTranslation({
      project: baseline,
      trackId,
      sourceCaptionIds,
      onProgress,
    }),
    (next) => translationAttemptMessage(next, trackId, sourceCaptionIds),
  ), [run]);

  const synchronize = useCallback((
    trackId: string,
    edits: readonly DualCaptionTextEdit[],
    baseline = optionsRef.current.getCurrentProject(),
  ) => execute({
    kind: 'manual-save',
    baseline,
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
    retryAvailable,
    clearError,
    retry,
    refresh,
    synchronize,
    cancel,
  };
}
