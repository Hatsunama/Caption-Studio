import { useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';

import { resolveEditorRuntimePolicy } from '@/lib/editor-runtime-policy';

export function useEditorRuntimePolicy(blockingUi: boolean) {
  const [appState, setAppState] = useState(AppState.currentState);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', setAppState);
    return () => subscription.remove();
  }, []);

  return useMemo(
    () => resolveEditorRuntimePolicy({ appState, blockingUi }),
    [appState, blockingUi],
  );
}
