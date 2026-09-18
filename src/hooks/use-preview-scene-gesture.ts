import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type GestureResponderEvent, type LayoutChangeEvent, type View } from 'react-native';
import { createPreviewSceneController, type PreviewSceneOptions } from '@/lib/preview-scene-controller';
import type { LayerGeometryInput } from '@/lib/layer-geometry';
import type { PreviewOrigin } from '@/lib/preview-object-hit-test';

export type { PreviewSceneTarget } from '@/lib/preview-scene-controller';

/** Adapter for the permanent, childless native scene input surface. */
export function usePreviewSceneGesture<T>(options: PreviewSceneOptions<T>) {
  const optionsRef = useRef(options);
  const canvasRef = useRef<View>(null);
  const originRef = useRef<PreviewOrigin | undefined>(undefined);
  const mounted = useRef(true);
  const measurement = useRef(0);
  const pendingGrant = useRef<{ token: number; events: (() => void)[] } | undefined>(undefined);
  const [, render] = useState(0);
  const [controller] = useState(() => createPreviewSceneController<T>(() => {
    render((revision) => revision + 1);
  }));

  useEffect(() => {
    if (!options.enabled || options.contextKey !== optionsRef.current.contextKey) {
      pendingGrant.current = undefined;
      measurement.current++;
    }
    optionsRef.current = options;
    controller.configure(options);
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingGrant.current = undefined;
      controller.cancel();
    };
  }, [controller]);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    controller.cancel();
    pendingGrant.current = undefined;
    controller.layout(event.nativeEvent.layout);
    originRef.current = undefined;
    const revision = ++measurement.current;
    canvasRef.current?.measureInWindow((pageX, pageY) => {
      if (mounted.current && revision === measurement.current && Number.isFinite(pageX) && Number.isFinite(pageY)) {
        originRef.current = { pageX, pageY };
      }
    });
  }, [controller]);

  const responders = useMemo(() => {
    const touches = (event: GestureResponderEvent, changed = false) =>
      (changed ? event.nativeEvent.changedTouches : event.nativeEvent.touches).map((touch) => ({
        id: Number(touch.identifier), x: touch.pageX, y: touch.pageY,
      }));
    const locate = (event: GestureResponderEvent) => {
      const { pageX, pageY, locationX, locationY } = event.nativeEvent;
      // This view has no native children: location is always surface-local.
      // Read it on each event, so scrolling/keyboard/crop translation never uses
      // a stale async measurement. All controller math still uses page coordinates.
      if ([pageX, pageY, locationX, locationY].every(Number.isFinite)) {
        const origin = { pageX: pageX - locationX, pageY: pageY - locationY };
        measurement.current++;
        originRef.current = origin;
        controller.locate(origin);
      }
      return originRef.current;
    };
    const dispatch = (event: GestureResponderEvent, action: 'start' | 'move' | 'end' | 'release') => {
      // Copy native touch data synchronously; never retain a pooled native event.
      const points = touches(event);
      const changed = touches(event, true);
      const run = () => {
        if (action === 'release') { controller.end(points, changed); controller.release(); }
        else if (action === 'end') controller.end(points, changed);
        else controller[action](points);
      };
      if (pendingGrant.current) pendingGrant.current.events.push(run);
      else { locate(event); run(); }
    };
    return {
      onStartShouldSetResponder: () => optionsRef.current.enabled,
      // Never acquire a sequence halfway through a drag from outside the scene.
      onMoveShouldSetResponder: () => false,
      onResponderTerminationRequest: () => false,
      onResponderGrant: (event: GestureResponderEvent) => {
        pendingGrant.current = undefined;
        controller.cancel();
        // Never depend on the measurement from onLayout. The event's own local
        // coordinates provide an immediate frame while native measurement runs.
        originRef.current = undefined;
        const origin = locate(event);
        const points = touches(event);
        const initiating = Number(event.nativeEvent.identifier);
        points.sort((a, b) => Number(b.id === initiating) - Number(a.id === initiating));
        const initial = points.length ? points : touches(event, true);
        const token = ++measurement.current;
        const snapshot = optionsRef.current;
        if (origin) controller.grant(initial, origin);
        else pendingGrant.current = { token, events: [] };
        canvasRef.current?.measureInWindow((pageX, pageY) => {
          if (!mounted.current || token !== measurement.current) return;
          if (!Number.isFinite(pageX) || !Number.isFinite(pageY)) {
            pendingGrant.current = undefined;
            controller.cancel();
            return;
          }
          const measured = { pageX, pageY };
          originRef.current = measured;
          const pending = pendingGrant.current;
          pendingGrant.current = undefined;
          if (pending?.token === token) {
            // Snapshot grant identity even if selection re-rendered while waiting.
            controller.configure(snapshot);
            controller.grant(initial, measured);
            controller.configure(optionsRef.current);
            pending.events.forEach((run) => run());
          } else controller.locate(measured);
        });
      },
      onResponderStart: (event: GestureResponderEvent) => dispatch(event, 'start'),
      onResponderMove: (event: GestureResponderEvent) => dispatch(event, 'move'),
      onResponderEnd: (event: GestureResponderEvent) => dispatch(event, 'end'),
      onResponderRelease: (event?: GestureResponderEvent) => {
        if (event) dispatch(event, 'release');
        else if (pendingGrant.current) pendingGrant.current.events.push(() => controller.release());
        else controller.release();
        if (!pendingGrant.current) measurement.current++;
      },
      onResponderTerminate: () => {
        measurement.current++;
        pendingGrant.current = undefined;
        controller.cancel();
      },
    };
  }, [controller]);

  return {
    canvasRef, onLayout, responders,
    selectedKey: controller.selectedKey ?? options.selectedKey,
    geometryFor: (key: string, geometry: LayerGeometryInput) => controller.geometryFor(key, geometry),
  };
}
