import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type GestureResponderEvent, type LayoutChangeEvent, type View } from 'react-native';

import { createLayerGesture, resolveLayerGeometry, type LayerGeometry, type LayerGeometryInput } from '@/lib/layer-geometry';
import {
  previewCanvasPoint,
  previewInteractionAtPoint,
  previewObjectContainsPoint,
  type PreviewObjectTarget,
  type PreviewOrigin,
  type PreviewSize,
} from '@/lib/preview-object-hit-test';

export type PreviewSceneTarget<T> = PreviewObjectTarget<T> & {
  deletable?: boolean;
};

type GestureOwner<T> = {
  target?: PreviewSceneTarget<T>;
  gesture?: ReturnType<typeof createLayerGesture>;
  geometry?: LayerGeometry;
  pointers: Set<number>;
  deleteOnRelease: boolean;
};

export function usePreviewSceneGesture<T>(options: {
  targets: readonly PreviewSceneTarget<T>[];
  selectedKey?: string;
  enabled: boolean;
  onSelect: (selection: T) => void;
  onClearSelection: () => void;
  onChange: (target: PreviewSceneTarget<T>, geometry: LayerGeometry) => void;
  onDelete: (target: PreviewSceneTarget<T>) => void;
  onInteractionStart: () => void;
  onInteractionEnd: () => void;
}) {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);
  const canvasRef = useRef<View>(null);
  const metricsRef = useRef<{ size: PreviewSize; origin?: PreviewOrigin }>({ size: { width: 0, height: 0 } });
  const ownerRef = useRef<GestureOwner<T> | undefined>(undefined);
  const [draft, setDraft] = useState<{ key: string; geometry: LayerGeometry }>();
  const frameRef = useRef<number | undefined>(undefined);
  const pendingRef = useRef<{ target: PreviewSceneTarget<T>; geometry: LayerGeometry } | undefined>(undefined);

  const flush = useCallback(() => {
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    frameRef.current = undefined;
    const pending = pendingRef.current;
    pendingRef.current = undefined;
    if (!pending) return;
    setDraft({ key: pending.target.key, geometry: pending.geometry });
    optionsRef.current.onChange(pending.target, pending.geometry);
  }, []);

  const publish = useCallback((target: PreviewSceneTarget<T>, geometry: LayerGeometry) => {
    if (ownerRef.current?.target?.key === target.key) ownerRef.current.geometry = geometry;
    pendingRef.current = { target, geometry };
    if (frameRef.current !== undefined) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = undefined;
      const pending = pendingRef.current;
      pendingRef.current = undefined;
      if (!pending) return;
      setDraft({ key: pending.target.key, geometry: pending.geometry });
      optionsRef.current.onChange(pending.target, pending.geometry);
    });
  }, []);

  const locate = useCallback(() => {
    canvasRef.current?.measureInWindow((pageX, pageY) => {
      metricsRef.current = { ...metricsRef.current, origin: { pageX, pageY } };
    });
  }, []);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    metricsRef.current = {
      ...metricsRef.current,
      size: { width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height },
    };
    locate();
  }, [locate]);

  const pointFor = useCallback((touch: { pageX: number; pageY: number }) => {
    const origin = metricsRef.current.origin;
    return origin ? previewCanvasPoint(touch.pageX, touch.pageY, origin) : undefined;
  }, []);

  const pointsForOwner = useCallback((event: GestureResponderEvent, owner: GestureOwner<T>) => event.nativeEvent.touches
    .filter((touch) => owner.pointers.has(Number(touch.identifier)))
    .map((touch) => ({ id: Number(touch.identifier), x: touch.pageX, y: touch.pageY })), []);

  const finish = useCallback((commit: boolean) => {
    const owner = ownerRef.current;
    ownerRef.current = undefined;
    if (!owner) return;
    if (commit) flush();
    else {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
      frameRef.current = undefined;
      pendingRef.current = undefined;
    }
    if (commit && owner.deleteOnRelease && owner.target) optionsRef.current.onDelete(owner.target);
    if (owner.gesture) {
      owner.gesture.end();
      optionsRef.current.onInteractionEnd();
    }
    setDraft(undefined);
  }, [flush]);

  useEffect(() => () => {
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    frameRef.current = undefined;
    pendingRef.current = undefined;
    ownerRef.current = undefined;
  }, []);

  const responders = useMemo(() => ({
    onStartShouldSetResponderCapture: () => optionsRef.current.enabled,
    onMoveShouldSetResponderCapture: () => optionsRef.current.enabled,
    onResponderTerminationRequest: () => false,
    onResponderGrant: (event: GestureResponderEvent) => {
      const current = optionsRef.current;
      const touch = event.nativeEvent.touches[0] ?? event.nativeEvent.changedTouches[0];
      const point = touch ? pointFor(touch) : undefined;
      const { size, origin } = metricsRef.current;
      if (!point || !origin) return;
      const selected = current.selectedKey ? current.targets.find((target) => target.key === current.selectedKey) : undefined;
      const interaction = previewInteractionAtPoint(current.targets, current.selectedKey, point, size, Boolean(selected?.deletable));
      if (!interaction) {
        current.onClearSelection();
        ownerRef.current = { pointers: new Set(), deleteOnRelease: false };
        return;
      }
      const target = interaction.target as PreviewSceneTarget<T>;
      current.onSelect(target.selection);
      const pointers = new Set<number>();
      for (const candidate of event.nativeEvent.touches) {
        const candidatePoint = pointFor(candidate);
        if (candidatePoint && previewObjectContainsPoint(target.geometry, candidatePoint, size)) {
          pointers.add(Number(candidate.identifier));
        }
      }
      pointers.add(Number(touch.identifier));
      if (interaction.mode === 'delete') {
        ownerRef.current = { target, geometry: resolveLayerGeometry(target.geometry), pointers, deleteOnRelease: true };
        return;
      }
      const gesture = createLayerGesture(target.geometry);
      const points = event.nativeEvent.touches
        .filter((candidate) => pointers.has(Number(candidate.identifier)))
        .map((candidate) => ({ id: Number(candidate.identifier), x: candidate.pageX, y: candidate.pageY }));
      if (!gesture.begin(interaction.mode, points, { ...size, ...origin, located: true })) return;
      ownerRef.current = { target, gesture, geometry: resolveLayerGeometry(target.geometry), pointers, deleteOnRelease: false };
      current.onInteractionStart();
    },
    onResponderStart: (event: GestureResponderEvent) => {
      const owner = ownerRef.current;
      const target = owner?.target;
      if (!owner?.gesture || !target) return;
      const size = metricsRef.current.size;
      for (const touch of event.nativeEvent.changedTouches) {
        const point = pointFor(touch);
        if (point && previewObjectContainsPoint(owner.geometry ?? target.geometry, point, size)) owner.pointers.add(Number(touch.identifier));
      }
      const points = pointsForOwner(event, owner);
      if (points.length) owner.gesture.update(points);
    },
    onResponderMove: (event: GestureResponderEvent) => {
      const owner = ownerRef.current;
      if (!owner?.gesture || !owner.target) return;
      const points = pointsForOwner(event, owner);
      if (points.length) publish(owner.target, owner.gesture.update(points));
    },
    onResponderEnd: (event: GestureResponderEvent) => {
      const owner = ownerRef.current;
      if (!owner) return;
      const live = new Set(event.nativeEvent.touches.map((touch) => Number(touch.identifier)));
      for (const pointer of owner.pointers) if (!live.has(pointer)) owner.pointers.delete(pointer);
      if (owner.gesture) {
        const points = pointsForOwner(event, owner);
        if (points.length && owner.target) publish(owner.target, owner.gesture.update(points));
      }
    },
    onResponderRelease: () => finish(true),
    onResponderTerminate: () => finish(false),
  }), [finish, pointFor, pointsForOwner, publish]);

  return {
    canvasRef,
    onLayout,
    responders,
    geometryFor(key: string, geometry: LayerGeometryInput) {
      return draft?.key === key ? draft.geometry : geometry;
    },
  };
}
