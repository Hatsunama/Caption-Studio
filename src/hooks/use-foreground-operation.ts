import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

export type ForegroundOperationInterruption<Stage extends string> = {
  stage: Stage;
  interruptionError?: string;
};

export function useForegroundOperation<Stage extends string>(options: {
  stage?: Stage;
  interrupt: () => Promise<unknown> | unknown;
}) {
  const stageRef = useRef(options.stage);
  const interruptRef = useRef(options.interrupt);
  const pendingRef = useRef<ForegroundOperationInterruption<Stage> | undefined>(undefined);
  const stopPromiseRef = useRef<Promise<void> | undefined>(undefined);
  const [interruption, setInterruption] = useState<ForegroundOperationInterruption<Stage>>();

  useLayoutEffect(() => {
    stageRef.current = options.stage;
    interruptRef.current = options.interrupt;
  }, [options.interrupt, options.stage]);

  useEffect(() => {
    const onAppStateChange = (state: AppStateStatus) => {
      if (state !== 'active') {
        const stage = stageRef.current;
        if (!stage || pendingRef.current) return;
        const pending: ForegroundOperationInterruption<Stage> = { stage };
        pendingRef.current = pending;
        stopPromiseRef.current = Promise.resolve(interruptRef.current()).then(
          () => undefined,
          (error: unknown) => {
            pending.interruptionError = error instanceof Error ? error.message : 'The operation could not stop cleanly.';
          },
        );
        return;
      }
      const pending = pendingRef.current;
      if (!pending) return;
      void (stopPromiseRef.current ?? Promise.resolve()).then(() => {
        if (pendingRef.current === pending) setInterruption({ ...pending });
      });
    };
    const subscription = AppState.addEventListener('change', onAppStateChange);
    return () => subscription.remove();
  }, []);

  const clearInterruption = useCallback(() => {
    pendingRef.current = undefined;
    stopPromiseRef.current = undefined;
    setInterruption(undefined);
  }, []);

  return { interruption, clearInterruption };
}
