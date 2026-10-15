import type { Gesture } from 'react-native-gesture-handler';
import { timelineTouchIntent, type TimelineTouchIntent } from '@/lib/timeline-touch-intent';

export type TimelineNativePanCallbacks = {
  begin: (dx: number, dy: number) => void;
  move: (dx: number, dy: number, touches: number) => void;
  finish: () => void;
  cancel: () => void;
  prepare?: () => void;
  shouldActivate?: () => boolean;
};

/** Native scroll recognizers wait for this directional decision, rather than
 * racing the JS responder against Android's own touch slop. Domain callbacks
 * still own all timing, history, feedback and cancellation. */
export function createTimelineNativePan(
  pan: ReturnType<typeof Gesture.Pan>, callbacks: TimelineNativePanCallbacks,
  scrollGestures: ReturnType<typeof Gesture.Native>[],
) {
  let origin: { x: number; y: number } | undefined;
  let intent: TimelineTouchIntent = 'pending';
  let active = false;
  const cancel = () => {
    if (!active) return;
    active = false;
    callbacks.cancel();
  };
  return pan.manualActivation(true).runOnJS(true).maxPointers(1)
    .blocksExternalGesture(...scrollGestures)
    .onTouchesDown((event, manager) => {
      if (event.numberOfTouches !== 1 || !event.allTouches[0]) { cancel(); manager.fail(); return; }
      const touch = event.allTouches[0];
      origin = { x: touch.absoluteX, y: touch.absoluteY };
      intent = 'pending';
      callbacks.prepare?.();
    })
    .onTouchesMove((event, manager) => {
      const touch = event.allTouches[0];
      if (event.numberOfTouches !== 1 || !origin || !touch) { cancel(); manager.fail(); return; }
      if (active) return;
      if (callbacks.shouldActivate?.()) { manager.activate(); return; }
      if (intent === 'pending') intent = timelineTouchIntent(touch.absoluteX - origin.x, touch.absoluteY - origin.y);
      if (intent === 'horizontal') manager.activate();
      else if (intent === 'vertical') manager.fail();
    })
    .onStart((event) => {
      active = true;
      callbacks.begin(event.translationX, event.translationY);
    })
    .onUpdate((event) => {
      if (!active) return;
      if (event.numberOfPointers !== 1) { cancel(); return; }
      callbacks.move(event.translationX, event.translationY, event.numberOfPointers);
    })
    .onEnd((_event, success) => {
      if (!active) return;
      active = false;
      if (success) callbacks.finish(); else callbacks.cancel();
    })
    .onFinalize(() => {
      cancel();
      origin = undefined;
      intent = 'pending';
    });
}
