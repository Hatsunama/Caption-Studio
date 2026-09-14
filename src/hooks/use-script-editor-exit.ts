import { useCallback, useEffect, useRef, type RefObject } from 'react';
import {
  Keyboard,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView,
} from 'react-native';

// The workspace owns this vertical reveal. It never seeks the timeline or
// changes selection, project contents, or the active tool.
export function useScriptEditorExit(open: boolean, scrollRef: RefObject<ScrollView | null>, onClose: () => void) {
  const pendingRef = useRef(false);
  const timelineTopRef = useRef<number | undefined>(undefined);
  const scrollReadyRef = useRef(false);
  const viewportHeightRef = useRef(0);
  const contentHeightRef = useRef(0);
  const scrollOffsetRef = useRef(0);
  const frameRef = useRef<number | undefined>(undefined);

  const timelineRootOffset = useCallback(() => {
    if (!scrollReadyRef.current || timelineTopRef.current === undefined) return undefined;
    const maximumOffset = contentHeightRef.current > 0
      ? Math.max(0, contentHeightRef.current - viewportHeightRef.current)
      : timelineTopRef.current;
    return Math.max(0, Math.min(timelineTopRef.current, maximumOffset));
  }, []);

  const scheduleTimelineReveal = useCallback(() => {
    if (open || !pendingRef.current) return;
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    // Coalesce native viewport/content/anchor layout events. Hidden controls
    // have no usable scroll range, and keyboard dismissal may resize it again.
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = undefined;
      const rootOffset = timelineRootOffset();
      if (!pendingRef.current || Keyboard.isVisible() || rootOffset === undefined || !scrollRef.current) return;
      scrollRef.current.scrollTo({ y: rootOffset, animated: false });
      scrollOffsetRef.current = rootOffset;
      pendingRef.current = false;
    });
  }, [open, scrollRef, timelineRootOffset]);

  useEffect(() => {
    if (open) {
      pendingRef.current = false;
      return;
    }
    const hide = Keyboard.addListener('keyboardDidHide', scheduleTimelineReveal);
    scheduleTimelineReveal();
    return () => {
      hide.remove();
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
      frameRef.current = undefined;
    };
  }, [open, scheduleTimelineReveal]);

  const close = () => {
    pendingRef.current = true;
    Keyboard.dismiss();
    onClose();
  };

  const onScrollLayout = (event: LayoutChangeEvent) => {
    if (open) return;
    viewportHeightRef.current = Math.max(0, event.nativeEvent.layout.height);
    scrollReadyRef.current = viewportHeightRef.current > 0;
    scheduleTimelineReveal();
  };

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (open) return;
    scrollOffsetRef.current = Math.max(0, event.nativeEvent.contentOffset.y);
  };

  const onContentSizeChange = (_width: number, height: number) => {
    if (Number.isFinite(height) && height > 0) contentHeightRef.current = height;
    scheduleTimelineReveal();
  };

  const onTimelineLayout = (event: LayoutChangeEvent) => {
    if (open || event.nativeEvent.layout.height <= 0) return;
    timelineTopRef.current = event.nativeEvent.layout.y;
    scheduleTimelineReveal();
  };

  const timelineRooted = () => {
    const rootOffset = timelineRootOffset();
    return rootOffset !== undefined && !pendingRef.current
      && Math.abs(scrollOffsetRef.current - rootOffset) <= 2;
  };

  const revealTimeline = () => {
    pendingRef.current = true;
    scheduleTimelineReveal();
  };

  return {
    close,
    onScrollLayout,
    onScroll,
    onContentSizeChange,
    onTimelineLayout,
    scheduleTimelineReveal,
    timelineRooted,
    revealTimeline,
  };
}
