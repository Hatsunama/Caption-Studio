import { useCallback, useEffect, useRef, useState } from 'react';
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

function interruptedOperationLabel(stage: CaptionTranslationProgress['stage'] | undefined) {
  return stage === 'downloading-model' ? 'language-model download' : 'translation';
}

export function useProjectCaptionTranslation(options: ControllerOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const mountedRef = useRef(true);
  const activeOperationRef = useRef<symbol | undefined>(undefined);
  const activeStageRef = useRef<CaptionTranslationProgress['stage'] | undefined>(undefined);
  const interruptedRef = useRef(false);
  const [progress, setProgress] = useState<CaptionTranslationProgress>();
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => () => {
    mountedRef.current = false;
    if (activeOperationRef.current) void cancelNaturalCaptionTranslation();
  }, []);

  useEffect(() => {
    const onAppStateChange = (state: AppStateStatus) => {
      if (state === 'active' || !activeOperationRef.current) return;
      interruptedRef.current = true;
      void cancelNaturalCaptionTranslation();
    };
    const subscription = AppState.addEventListener('change', onAppStateChange);
    return () => subscription.remove();
  }, []);

  const run = useCallback(async (
    baseline: CaptionProject,
    operation: (onProgress: (next: CaptionTranslationProgress) => void) => Promise<CaptionProject>,
  ) => {
    if (activeOperationRef.current) {
      if (mountedRef.current) setError('Finish or cancel the current local translation before starting another.');
      return false;
    }
    const operationId = Symbol('project-caption-translation');
    activeOperationRef.current = operationId;
    activeStageRef.current = 'loading-model';
    interruptedRef.current = false;
    setError(undefined);
    setCancelling(false);
    setProgress({ stage: 'loading-model', progress: 0, detail: 'Preparing local natural translation' });
    try {
      const next = await operation((nextProgress) => {
        activeStageRef.current = nextProgress.stage;
        if (mountedRef.current && activeOperationRef.current === operationId) setProgress(nextProgress);
      });
      if (!mountedRef.current || activeOperationRef.current !== operationId) return false;
      if (optionsRef.current.getCurrentProject() !== baseline) {
        throw new Error('The project changed while both languages were synchronizing. Save again to avoid overwriting newer edits.');
      }
      if (next !== baseline) await optionsRef.current.commitProject(baseline, next);
      return true;
    } catch (caught) {
      if (mountedRef.current && activeOperationRef.current === operationId && interruptedRef.current) {
        const action = interruptedOperationLabel(activeStageRef.current);
        setError(`The ${action} stopped because Caption Studio left the foreground. Keep this screen open and the phone unlocked, then tap Retry.`);
      } else if (
        mountedRef.current
        && activeOperationRef.current === operationId
        && !(caught instanceof CaptionTranslationCancelledError)
      ) {
        setError(caught instanceof Error ? caught.message : 'Natural caption translation failed.');
      }
      return false;
    } finally {
      if (activeOperationRef.current === operationId) {
        activeOperationRef.current = undefined;
        activeStageRef.current = undefined;
        if (mountedRef.current) {
          setCancelling(false);
          setProgress(undefined);
        }
      }
    }
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
  ), [run]);

  const synchronize = useCallback((
    trackId: string,
    edits: readonly DualCaptionTextEdit[],
    baseline = optionsRef.current.getCurrentProject(),
  ) => run(
    baseline,
    (onProgress) => synchronizeProjectDualCaptionEdits({
      project: baseline,
      trackId,
      edits,
      onProgress,
    }),
  ), [run]);

  const cancel = useCallback(async () => {
    if (!activeOperationRef.current) return false;
    if (mountedRef.current) setCancelling(true);
    const cancelled = await cancelNaturalCaptionTranslation();
    if (!cancelled && mountedRef.current) setCancelling(false);
    return cancelled;
  }, []);

  return {
    busy: Boolean(progress) || cancelling,
    progress,
    cancelling,
    error,
    clearError: () => setError(undefined),
    refresh,
    synchronize,
    cancel,
  };
}
