import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent, View } from 'react-native';
import { createInputRevealController } from '@/lib/input-viewport';

export function useFocusedInputReveal(scrollToOffset: (offset: number) => void) {
  const viewportRef = useRef<View>(null);
  const scrollToRef = useRef(scrollToOffset);
  useLayoutEffect(() => { scrollToRef.current = scrollToOffset; }, [scrollToOffset]);
  const [controller] = useState(() => createInputRevealController({
    viewport: () => viewportRef.current,
    scrollToOffset: (offset) => scrollToRef.current(offset),
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (id) => cancelAnimationFrame(id),
  }));
  useLayoutEffect(() => {
    controller.attach();
    return () => controller.detach();
  }, [controller]);
  return useMemo(() => ({
    viewportRef,
    focus: controller.focus,
    blur: controller.blur,
    onViewportLayout: (_event?: unknown) => controller.reveal(),
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => controller.recordScroll(event.nativeEvent.contentOffset.y),
    onScrollBeginDrag: controller.beginDrag,
  }), [controller]);
}

export type FocusedInputReveal = ReturnType<typeof useFocusedInputReveal>;
