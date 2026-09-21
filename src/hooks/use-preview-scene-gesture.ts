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
  const [, render] = useState(0);
  const [controller] = useState(() => createPreviewSceneController<T>(() => {
    render((revision) => revision + 1);
  }));

  useEffect(() => {
    if (!options.enabled || options.contextKey !== optionsRef.current.contextKey) {
      measurement.current++;
    }
    optionsRef.current = options;
    controller.configure(options);
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.cancel();
    };
  }, [controller]);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    controller.cancel();
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
    const eventOrigin = (event: GestureResponderEvent) => {
      const { pageX, pageY, locationX, locationY } = event.nativeEvent;
      if ([pageX, pageY, locationX, locationY].every(Number.isFinite)) {
        return { pageX: pageX - locationX, pageY: pageY - locationY };
      }
      return undefined;
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
      run();
    };
    return {
      onStartShouldSetResponder: () => optionsRef.current.enabled,
      // Never acquire a sequence halfway through a drag from outside the scene.
      onMoveShouldSetResponder: () => false,
      onResponderTerminationRequest: () => false,
      onResponderGrant: (event: GestureResponderEvent) => {
        controller.cancel();
        const origin = eventOrigin(event) ?? originRef.current;
        if (!origin) return;
        originRef.current = origin;
        const points = touches(event);
        const initiating = Number(event.nativeEvent.identifier);
        points.sort((a, b) => Number(b.id === initiating) - Number(a.id === initiating));
        const initial = points.length ? points : touches(event, true);
        controller.grant(initial, origin);
      },
      onResponderStart: (event: GestureResponderEvent) => dispatch(event, 'start'),
      onResponderMove: (event: GestureResponderEvent) => dispatch(event, 'move'),
      onResponderEnd: (event: GestureResponderEvent) => dispatch(event, 'end'),
      onResponderRelease: (event?: GestureResponderEvent) => {
        if (event) dispatch(event, 'release');
        else controller.release();
      },
      onResponderTerminate: () => {
        measurement.current++;
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
