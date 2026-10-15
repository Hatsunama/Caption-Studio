import type { Gesture } from 'react-native-gesture-handler';
import { timelineTouchIntent } from '@/lib/timeline-touch-intent';

export type TimelineNativePanCallbacks = {
  begin: (dx: number, dy: number, reorder?: boolean, pageY?: number) => void;
  move: (dx: number, dy: number, touches: number, pageY?: number) => void;
  finish: () => void;
  cancel: () => void;
  prepare?: () => void;
  holdMilliseconds?: number;
  axis?: 'horizontal' | 'vertical';
};

export type TimelineNativePanState = {
  epoch: number;
  touchId: number;
  phase: 'idle' | 'pending' | 'recognized' | 'active' | 'failed';
  handlerTag: number;
  originX: number;
  originY: number;
  lastDx: number;
  lastDy: number;
  startedAt: number;
  holdEligible: boolean;
  reorder: boolean;
};

export function initialTimelineNativePanState(): TimelineNativePanState {
  return { epoch: 0, touchId: 0, phase: 'idle', handlerTag: 0, originX: 0, originY: 0,
    lastDx: 0, lastDy: 0, startedAt: 0, holdEligible: true, reorder: false };
}

type DeliveryEvent = 'prepare' | 'begin' | 'move' | 'finish' | 'cancel';
type Deliver = (kind: DeliveryEvent, epoch: number, touchId: number,
  dx?: number, dy?: number, touches?: number, reorder?: boolean, pageY?: number) => void;

/** Invalidate RN ownership before queued UI work arrives. The UI copy also
 * stops recognition, so neither side can revive an invalidated touch. */
export function createTimelineNativePanDelivery(callbacks: TimelineNativePanCallbacks) {
  let epoch = 0;
  let mounted = true;
  let preparedTouch = 0;
  let activeTouch = 0;
  const cancel = () => {
    const wasActive = activeTouch !== 0;
    activeTouch = 0;
    preparedTouch = 0;
    if (wasActive) callbacks.cancel();
  };
  const invalidate = () => { epoch += 1; cancel(); return epoch; };
  const dispatch: Deliver = (kind, eventEpoch, touchId, dx = 0, dy = 0, touches = 1, reorder = false, pageY) => {
    if (!mounted || eventEpoch !== epoch) return;
    if (kind === 'prepare') {
      cancel();
      preparedTouch = touchId;
      callbacks.prepare?.();
    } else if (kind === 'begin') {
      if (preparedTouch !== touchId || activeTouch) return;
      activeTouch = touchId;
      if (callbacks.axis === 'vertical') callbacks.begin(dx, dy, reorder, pageY);
      else callbacks.begin(dx, dy, reorder);
    } else if (kind === 'cancel') {
      if (preparedTouch === touchId) cancel();
    } else if (activeTouch === touchId) {
      if (kind === 'move') {
        if (callbacks.axis === 'vertical') callbacks.move(dx, dy, touches, pageY);
        else callbacks.move(dx, dy, touches);
      }
      else if (kind === 'finish') {
        activeTouch = 0;
        preparedTouch = 0;
        callbacks.finish();
      }
    }
  };
  return { dispatch, invalidate, epoch: () => epoch,
    mount: () => { mounted = true; },
    unmount: () => { mounted = false; return invalidate(); } };
}

type Runtime = {
  state: { value: TimelineNativePanState };
  deliver: Deliver;
  schedule: (callback: Deliver, ...args: Parameters<Deliver>) => void;
};

/** Recognition runs on UI. Absolute coordinates preserve the original touch
 * basis when Android rebases Pan translation on activation. */
export function createTimelineNativePan(
  pan: ReturnType<typeof Gesture.Pan>, callbacks: TimelineNativePanCallbacks,
  scrollGestures: ReturnType<typeof Gesture.Native>[], runtime: Runtime,
) {
  const { state, deliver, schedule } = runtime;
  const holdMilliseconds = callbacks.holdMilliseconds ?? 0;
  const axis = callbacks.axis ?? 'horizontal';
  const cancel = () => {
    'worklet';
    const current = state.value;
    if (current.phase === 'idle' || current.phase === 'failed') return;
    state.value = { ...current, phase: 'failed' };
    schedule(deliver, 'cancel', current.epoch, current.touchId);
  };
  return pan.manualActivation(true).runOnJS(false).maxPointers(1)
    .blocksExternalGesture(...scrollGestures)
    .onTouchesDown((event, manager) => {
      'worklet';
      const touch = event.allTouches[0];
      if (event.numberOfTouches !== 1 || !touch || !Number.isFinite(touch.absoluteX) || !Number.isFinite(touch.absoluteY)) {
        cancel(); manager.fail(); return;
      }
      cancel();
      const current = state.value;
      state.value = { ...current, touchId: current.touchId + 1, phase: 'pending', handlerTag: event.handlerTag,
        originX: touch.absoluteX, originY: touch.absoluteY, lastDx: 0, lastDy: 0,
        startedAt: Date.now(), holdEligible: true, reorder: false };
      schedule(deliver, 'prepare', current.epoch, current.touchId + 1);
    })
    .onTouchesMove((event, manager) => {
      'worklet';
      const current = state.value;
      const touch = event.allTouches[0];
      if (event.numberOfTouches !== 1 || !touch) { cancel(); manager.fail(); return; }
      if (current.phase !== 'pending') return;
      const dx = touch.absoluteX - current.originX;
      const dy = touch.absoluteY - current.originY;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) { cancel(); manager.fail(); return; }
      const intent = timelineTouchIntent(dx, dy);
      if (intent !== 'pending' && intent !== axis) { cancel(); manager.fail(); return; }
      const held = axis === 'horizontal' && holdMilliseconds > 0 && current.holdEligible && Date.now() - current.startedAt >= holdMilliseconds;
      if (held || intent === axis) {
        state.value = { ...current, phase: 'recognized', reorder: held };
        manager.activate();
      } else if (Math.max(Math.abs(dx), Math.abs(dy)) > 8) {
        state.value = { ...current, holdEligible: false };
      }
    })
    .onStart((event) => {
      'worklet';
      const current = state.value;
      if (current.phase !== 'recognized') return;
      const dx = event.absoluteX - current.originX;
      const dy = event.absoluteY - current.originY;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) { cancel(); return; }
      state.value = { ...current, phase: 'active', lastDx: dx, lastDy: dy };
      schedule(deliver, 'begin', current.epoch, current.touchId, dx, dy, 1, current.reorder, axis === 'vertical' ? event.absoluteY : undefined);
    })
    .onUpdate((event) => {
      'worklet';
      const current = state.value;
      if (current.phase !== 'active') return;
      const dx = event.absoluteX - current.originX;
      const dy = event.absoluteY - current.originY;
      if (event.numberOfPointers !== 1 || !Number.isFinite(dx) || !Number.isFinite(dy)) { cancel(); return; }
      state.value = { ...current, lastDx: dx, lastDy: dy };
      schedule(deliver, 'move', current.epoch, current.touchId, dx, dy, 1, false, axis === 'vertical' ? event.absoluteY : undefined);
    })
    .onEnd((event, success) => {
      'worklet';
      const current = state.value;
      if (current.phase !== 'active') return;
      const dx = event.absoluteX - current.originX;
      const dy = event.absoluteY - current.originY;
      if (!success || !Number.isFinite(dx) || !Number.isFinite(dy)) { cancel(); return; }
      state.value = { ...current, phase: 'idle', lastDx: dx, lastDy: dy };
      if (dx !== current.lastDx || dy !== current.lastDy) schedule(deliver, 'move', current.epoch, current.touchId, dx, dy, 1, false, axis === 'vertical' ? event.absoluteY : undefined);
      schedule(deliver, 'finish', current.epoch, current.touchId);
    })
    .onTouchesCancelled((_event, manager) => {
      'worklet';
      cancel(); manager.fail();
    })
    .onFinalize(() => {
      'worklet';
      cancel();
      state.value = { ...state.value, phase: 'idle' };
    });
}
