import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { Keyboard, type LayoutChangeEvent, type ScrollView } from 'react-native';

// The workspace owns this vertical reveal. It never seeks the timeline or
// changes selection, project contents, or the active tool.
export function useScriptEditorExit(open: boolean, scrollRef: RefObject<ScrollView | null>, onClose: () => void) {
  const pendingRef = useRef(false);
  const timelineTopRef = useRef<number | undefined>(undefined);
  const scrollReadyRef = useRef(false);
  const frameRef = useRef<number | undefined>(undefined);

  const scheduleTimelineReveal = useCallback(() => {
    if (open || !pendingRef.current) return;
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    // Coalesce native viewport/content/anchor layout events. Hidden controls
    // have no usable scroll range, and keyboard dismissal may resize it again.
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = undefined;
      if (!pendingRef.current || Keyboard.isVisible() || !scrollReadyRef.current
        || timelineTopRef.current === undefined || !scrollRef.current) return;
      scrollRef.current.scrollTo({ y: timelineTopRef.current, animated: false });
      pendingRef.current = false;
    });
  }, [open, scrollRef]);

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
    scrollReadyRef.current = event.nativeEvent.layout.height > 0;
    scheduleTimelineReveal();
  };

  const onTimelineLayout = (event: LayoutChangeEvent) => {
    if (open || event.nativeEvent.layout.height <= 0) return;
    timelineTopRef.current = event.nativeEvent.layout.y;
    scheduleTimelineReveal();
  };

  return { close, onScrollLayout, onTimelineLayout, scheduleTimelineReveal };
}
