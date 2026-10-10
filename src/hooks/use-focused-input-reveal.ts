import { useLayoutEffect, useMemo, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { createInputRevealConnection } from '@/lib/input-viewport';

export function useFocusedInputReveal(scrollToOffset: (offset: number) => void) {
  const [controller] = useState(() => createInputRevealConnection({
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (id) => cancelAnimationFrame(id),
  }));
  useLayoutEffect(() => {
    controller.connectScrollToOffset(scrollToOffset);
    return () => controller.connectScrollToOffset(undefined);
  }, [controller, scrollToOffset]);
  useLayoutEffect(() => {
    controller.attach();
    return () => controller.detach();
  }, [controller]);
  return useMemo(() => ({
    viewportRef: controller.connectViewport,
    focus: controller.focus,
    blur: controller.blur,
    onViewportLayout: controller.reveal,
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => controller.recordScroll(event.nativeEvent.contentOffset.y),
    onScrollBeginDrag: controller.beginDrag,
  }), [controller]);
}

export type FocusedInputReveal = ReturnType<typeof useFocusedInputReveal>;
