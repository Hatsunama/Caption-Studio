import { useLayoutEffect, useMemo, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { createInputRevealConnection } from '@/lib/input-viewport';

export function useFocusedInputReveal(scrollToOffset: (offset: number) => void) {
  const [controller] = useState(() => createInputRevealConnection({
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (id) => cancelAnimationFrame(id),
  }));
  useLayoutEffect(() => {
    controller.attach();
    return () => controller.detach();
  }, [controller]);
  useLayoutEffect(() => {
    controller.connectScrollToOffset(scrollToOffset);
    return () => controller.connectScrollToOffset(undefined);
  }, [controller, scrollToOffset]);
  const controls = useMemo(() => ({
    focus: controller.focus,
    blur: controller.blur,
    onViewportLayout: controller.reveal,
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => controller.recordScroll(event.nativeEvent.contentOffset.y),
    onScrollBeginDrag: controller.beginDrag,
  }), [controller]);
  return [controller.connectViewport, controls] as const;
}

export type FocusedInputReveal = ReturnType<typeof useFocusedInputReveal>[1];
