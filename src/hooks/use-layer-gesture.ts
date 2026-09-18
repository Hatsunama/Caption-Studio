import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type GestureResponderEvent, PanResponder, type View } from 'react-native';
import { createGeometryFrameQueue, createLayerGesture, sameLayerGeometry, type LayerCanvas, type LayerGeometry, type LayerGeometryInput, type LayerGestureMode } from '@/lib/layer-geometry';

type GestureDraft = { id: string; source: LayerGeometryInput; geometry: LayerGeometry };
type GestureOwner = {
  id: string;
  source: LayerGeometryInput;
  onChange?: (geometry: LayerGeometry) => void;
  onEnd?: () => void;
};
type TouchPoints = ReturnType<typeof touches>;
type PendingGrant = { token: number; mode: LayerGestureMode; points: TouchPoints; owner: GestureOwner; moves: TouchPoints[] };

function createGestureRuntime(
  queue: ReturnType<typeof createGeometryFrameQueue<GestureDraft>>,
) {
  let session: ReturnType<typeof createLayerGesture> | undefined;
  let size: { width: number; height: number } | undefined;
  let origin: { pageX: number; pageY: number } | undefined;
  let owner: GestureOwner | undefined;
  const canvas = (): LayerCanvas | undefined => size ? {
    width: size.width, height: size.height,
    pageX: origin?.pageX ?? 0, pageY: origin?.pageY ?? 0,
    located: origin !== undefined,
  } : undefined;
  return {
    active: () => session?.active() ?? false,
    located: () => origin !== undefined,
    measure(width: number, height: number) {
      if (width > 0 && height > 0) size = { width, height };
    },
    locate(pageX: number, pageY: number) {
      origin = { pageX, pageY };
    },
    begin(mode: LayerGestureMode, points: TouchPoints, nextOwner: GestureOwner) {
      const next = canvas();
      if (!next) return false;
      session ??= createLayerGesture(nextOwner.source);
      session.sync(nextOwner.source);
      if (!session.begin(mode, points, next)) return false;
      owner = nextOwner;
      return true;
    },
    update(points: TouchPoints) {
      if (owner && session?.active()) queue.push({ id: owner.id, source: owner.source, geometry: session.update(points) });
    },
    finish() {
      const value = session?.end();
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
  id: string; geometry: LayerGeometryInput; interactive?: boolean;
  onStart?: () => void; onChange?: (geometry: LayerGeometry) => void; onEnd?: () => void;
}) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [draft, setDraft] = useState<GestureDraft>();
  const queue = useMemo(() => createGeometryFrameQueue<GestureDraft>(requestAnimationFrame, cancelAnimationFrame, setDraft), []);
  const runtime = useMemo(() => createGestureRuntime(queue), [queue]);
  const viewRef = useRef<View | null>(null);
  const pendingRef = useRef<PendingGrant | undefined>(undefined);
  const grantTokenRef = useRef(0);

  useEffect(() => () => {
    pendingRef.current = undefined;
    grantTokenRef.current += 1;
    runtime.finish();
    queue.clear();
  }, [options.id, queue, runtime]);

  const measureCanvas = useCallback((width: number, height: number, view: View | null) => {
    if (view) viewRef.current = view;
    runtime.measure(width, height);
    (view ?? viewRef.current)?.measureInWindow(runtime.locate);
  }, [runtime]);

  const flushPending = useCallback((token: number) => {
    const pending = pendingRef.current;
    if (!pending || pending.token !== token) return;
    pendingRef.current = undefined;
    if (runtime.begin(pending.mode, pending.points, pending.owner)) {
      optionsRef.current.onStart?.();
      for (const points of pending.moves) runtime.update(points);
    }
  }, [runtime]);

  const begin = useCallback((mode: LayerGestureMode, event: GestureResponderEvent) => {
    const current = optionsRef.current;
    if (!current.interactive) return;
    const points = touches(event);
    const owner = { id: current.id, source: current.geometry, onChange: current.onChange, onEnd: current.onEnd };
    if (runtime.located()) {
      if (runtime.begin(mode, points, owner)) current.onStart?.();
      return;
    }
    const view = viewRef.current;
    if (view) {
      const token = ++grantTokenRef.current;
      pendingRef.current = { token, mode, points, owner, moves: [] };
      view.measureInWindow((pageX, pageY) => {
        if (grantTokenRef.current !== token) return;
        runtime.locate(pageX, pageY);
        flushPending(token);
      });
      return;
    }
    if (runtime.begin(mode, points, owner)) current.onStart?.();
  }, [flushPending, runtime]);

  const move = useCallback((event: GestureResponderEvent) => {
    const points = touches(event);
    if (pendingRef.current) {
      pendingRef.current.moves.push(points);
      return;
    }
    runtime.update(points);
  }, [runtime]);

  const endTouches = useCallback((event: GestureResponderEvent) => {
    if (!event.nativeEvent.touches.length) return;
    const points = touches(event);
    if (pendingRef.current) pendingRef.current.moves.push(points);
    else runtime.update(points);
  }, [runtime]);

  const finish = useCallback(() => {
    grantTokenRef.current += 1;
    pendingRef.current = undefined;
    runtime.finish();
    setDraft(undefined);
  }, [runtime]);

  const responders = useMemo(() => Object.fromEntries(
    (['move', 'corner', 'left', 'right', 'top', 'bottom'] as const).map((mode) => [
      mode,
      PanResponder.create({
        onStartShouldSetPanResponder: () => {
          return !runtime.active() && Boolean(optionsRef.current.interactive);
        },
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
  [begin, endTouches, finish, move, runtime]);

  const { id, geometry } = options;
  return {
    responders,
    measureCanvas,
    geometry: draft?.id === id && (runtime.active() || draft.source === geometry) ? draft.geometry : geometry,
  };
}

function touches(event: GestureResponderEvent) {
  return event.nativeEvent.touches.map((touch) => ({
    id: Number(touch.identifier),
    x: touch.pageX,
    y: touch.pageY,
  }));
}
