import { useCallback, useEffect, useMemo, useState } from 'react';
import { type GestureResponderEvent, PanResponder, type View } from 'react-native';
import { createGeometryFrameQueue, createLayerGesture, sameLayerGeometry, type LayerCanvas, type LayerGeometry, type LayerGeometryInput, type LayerGestureMode } from '@/lib/layer-geometry';

type GestureDraft = { id: string; source: LayerGeometryInput; geometry: LayerGeometry };
type GestureOwner = {
  source: LayerGeometryInput;
  onChange?: (geometry: LayerGeometry) => void;
  onEnd?: () => void;
};

function createGestureRuntime(
  id: string,
  initial: LayerGeometryInput,
  queue: ReturnType<typeof createGeometryFrameQueue<GestureDraft>>,
) {
  const session = createLayerGesture(initial);
  let canvas: LayerCanvas = { width: 1, height: 1, pageX: 0, pageY: 0 };
  let owner: GestureOwner | undefined;
  return {
    active: session.active,
    measure(width: number, height: number) {
      canvas = { ...canvas, width, height };
    },
    locate(pageX: number, pageY: number) {
      canvas = { ...canvas, pageX, pageY };
    },
    begin(mode: LayerGestureMode, points: ReturnType<typeof touches>, nextOwner: GestureOwner) {
      session.sync(nextOwner.source);
      if (!session.begin(mode, points, canvas)) return false;
      owner = nextOwner;
      return true;
    },
    update(points: ReturnType<typeof touches>) {
      if (owner && session.active()) queue.push({ id, source: owner.source, geometry: session.update(points) });
    },
    finish() {
      const value = session.end();
      const activeOwner = owner;
      owner = undefined;
      if (!value || !activeOwner) return;
      queue.clear();
      if (!sameLayerGeometry(activeOwner.source, value)) activeOwner.onChange?.(value);
      activeOwner.onEnd?.();
    },
  };
}

export function useLayerGesture(options: {
  id: string; geometry: LayerGeometryInput; interactive?: boolean; selectable?: boolean;
  onSelect?: () => void; onStart?: () => void; onChange?: (geometry: LayerGeometry) => void; onEnd?: () => void;
}) {
  const { id, geometry, interactive, selectable, onSelect, onStart, onChange, onEnd } = options;
  const [draft, setDraft] = useState<GestureDraft>();
  const queue = useMemo(() => createGeometryFrameQueue<GestureDraft>(requestAnimationFrame, cancelAnimationFrame, setDraft), []);
  const runtime = useMemo(() => createGestureRuntime(id, geometry, queue), [geometry, id, queue]);

  useEffect(() => () => {
    runtime.finish();
    queue.clear();
  }, [queue, runtime]);

  const measureCanvas = useCallback((width: number, height: number, view: View | null) => {
    runtime.measure(width, height);
    view?.measureInWindow(runtime.locate);
  }, [runtime]);

  const begin = useCallback((mode: LayerGestureMode, event: GestureResponderEvent) => {
    if (!interactive) {
      onSelect?.();
      return;
    }
    if (runtime.begin(mode, touches(event), {
      source: geometry,
      onChange,
      onEnd,
    })) {
      onStart?.();
    }
  }, [geometry, interactive, onChange, onEnd, onSelect, onStart, runtime]);

  const move = useCallback((event: GestureResponderEvent) => {
    runtime.update(touches(event));
  }, [runtime]);

  const endTouches = useCallback((event: GestureResponderEvent) => {
    if (event.nativeEvent.touches.length) runtime.update(touches(event));
  }, [runtime]);

  const finish = useCallback(() => {
    runtime.finish();
    setDraft(undefined);
  }, [runtime]);

  const responders = useMemo(() => Object.fromEntries(
    (['move', 'corner', 'left', 'right', 'top', 'bottom'] as const).map((mode) => [
      mode,
      PanResponder.create({
        onStartShouldSetPanResponder: () =>
          !runtime.active() && Boolean(interactive || (mode === 'move' && selectable)),
        onMoveShouldSetPanResponder: () => false,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (event) => begin(mode, event),
        onPanResponderMove: move,
        onPanResponderStart: move,
        onPanResponderEnd: endTouches,
        onPanResponderRelease: finish,
        onPanResponderTerminate: finish,
      }).panHandlers,
    ]),
  ) as Record<LayerGestureMode, ReturnType<typeof PanResponder.create>['panHandlers']>,
  [begin, endTouches, finish, interactive, move, runtime, selectable]);

  return {
    responders,
    measureCanvas,
    geometry: draft?.id === id ? draft.geometry : geometry,
  };
}

function touches(event: GestureResponderEvent) {
  return event.nativeEvent.touches.map((touch) => ({
    id: Number(touch.identifier),
    x: touch.pageX,
    y: touch.pageY,
  }));
}
