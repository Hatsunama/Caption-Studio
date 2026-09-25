import { layerExtent, type LayerGeometryInput, type LayerGestureMode } from '@/lib/layer-geometry';

export type PreviewPoint = { x: number; y: number };
export type PreviewSize = { width: number; height: number };
export type PreviewOrigin = { pageX: number; pageY: number };
export type PreviewInteraction<T> = {
  target: PreviewObjectTarget<T>;
  mode: LayerGestureMode | 'delete';
};
export type PreviewObjectTarget<T> = {
  key: string;
  selection: T;
  geometry: LayerGeometryInput;
  order: number;
  yieldToForeground?: boolean;
};

export function previewObjectAtPoint<T>(
  targets: readonly PreviewObjectTarget<T>[],
  point: PreviewPoint,
  size: PreviewSize,
): PreviewObjectTarget<T> | undefined {
  if (!(size.width > 0) || !(size.height > 0)) return undefined;
  let hit: PreviewObjectTarget<T> | undefined;
  for (const target of targets) {
    if (!previewObjectContainsPoint(target.geometry, point, size)) continue;
    if (!hit || target.order > hit.order || (target.order === hit.order && target.key > hit.key)) hit = target;
  }
  return hit;
}

export function previewObjectContainsPoint(
  geometry: LayerGeometryInput,
  point: PreviewPoint,
  size: PreviewSize,
): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !(size.width > 0) || !(size.height > 0)) return false;
  const extent = layerExtent(geometry);
  const radians = geometry.rotation * Math.PI / 180;
  const dx = point.x - geometry.position.x * size.width;
  const dy = point.y - geometry.position.y * size.height;
  const localX = dx * Math.cos(radians) + dy * Math.sin(radians);
  const localY = -dx * Math.sin(radians) + dy * Math.cos(radians);
  const halfWidth = Math.max(12, extent.width * size.width / 2);
  const halfHeight = Math.max(12, extent.height * size.height / 2);
  return Math.abs(localX) <= halfWidth && Math.abs(localY) <= halfHeight;
}

export function previewCanvasPoint(pageX: number, pageY: number, origin: PreviewOrigin): PreviewPoint {
  return { x: pageX - origin.pageX, y: pageY - origin.pageY };
}

export function previewInteractionAtPoint<T>(
  targets: readonly PreviewObjectTarget<T>[],
  selectedKey: string | undefined,
  point: PreviewPoint,
  size: PreviewSize,
  deletable = false,
): PreviewInteraction<T> | undefined {
  const selected = selectedKey ? targets.find((target) => target.key === selectedKey) : undefined;
  const front = previewObjectAtPoint(targets, point, size);
  if (selected?.yieldToForeground && front && front.key !== selected.key && front.order > selected.order) {
    return { target: front, mode: 'move' };
  }
  if (selected) {
    const selectedMode = selectedChromeMode(selected.geometry, point, size, deletable);
    if (selectedMode && selectedMode !== 'move') return { target: selected, mode: selectedMode };
  }
  const target = front;
  if (!target) return undefined;
  return {
    target,
    mode: target.key === selectedKey
      ? selectedChromeMode(target.geometry, point, size, false) ?? 'move'
      : 'move',
  };
}

export const PREVIEW_CHROME = { edgeWidth: 36, edgeLength: 60, cornerSize: 46, deleteSize: 40 } as const;

function selectedChromeMode(
  geometry: LayerGeometryInput,
  point: PreviewPoint,
  size: PreviewSize,
  deletable: boolean,
): LayerGestureMode | 'delete' | undefined {
  if (!(size.width > 0) || !(size.height > 0) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined;
  const extent = layerExtent(geometry);
  const radians = geometry.rotation * Math.PI / 180;
  const dx = point.x - geometry.position.x * size.width;
  const dy = point.y - geometry.position.y * size.height;
  const localX = dx * Math.cos(radians) + dy * Math.sin(radians);
  const localY = -dx * Math.sin(radians) + dy * Math.cos(radians);
  const halfWidth = extent.width * size.width / 2;
  const halfHeight = extent.height * size.height / 2;
  // Keep the center available for dragging even on very small objects.
  if (Math.abs(localX) < Math.min(8, halfWidth / 2) && Math.abs(localY) < Math.min(8, halfHeight / 2)) return 'move';
  const deleteDistance = Math.hypot(localX + halfWidth, localY + halfHeight);
  const cornerDistance = Math.hypot(localX - halfWidth, localY - halfHeight);
  const handles: { mode: LayerGestureMode | 'delete'; distance: number; priority: number }[] = [
    ...(deletable && deleteDistance <= PREVIEW_CHROME.deleteSize / 2
      ? [{ mode: 'delete' as const, distance: deleteDistance, priority: 0 }] : []),
    ...(cornerDistance <= PREVIEW_CHROME.cornerSize / 2
      ? [{ mode: 'corner' as const, distance: cornerDistance, priority: 1 }] : []),
    ...(localX <= 0 && Math.abs(localY) <= PREVIEW_CHROME.edgeLength / 2
      && Math.abs(localX + halfWidth) <= PREVIEW_CHROME.edgeWidth / 2
      ? [{ mode: 'left' as const, distance: Math.abs(localX + halfWidth), priority: 2 }] : []),
    ...(localX >= 0 && Math.abs(localY) <= PREVIEW_CHROME.edgeLength / 2
      && Math.abs(localX - halfWidth) <= PREVIEW_CHROME.edgeWidth / 2
      ? [{ mode: 'right' as const, distance: Math.abs(localX - halfWidth), priority: 2 }] : []),
    ...(localY <= 0 && Math.abs(localX) <= PREVIEW_CHROME.edgeLength / 2
      && Math.abs(localY + halfHeight) <= PREVIEW_CHROME.edgeWidth / 2
      ? [{ mode: 'top' as const, distance: Math.abs(localY + halfHeight), priority: 2 }] : []),
    ...(localY >= 0 && Math.abs(localX) <= PREVIEW_CHROME.edgeLength / 2
      && Math.abs(localY - halfHeight) <= PREVIEW_CHROME.edgeWidth / 2
      ? [{ mode: 'bottom' as const, distance: Math.abs(localY - halfHeight), priority: 2 }] : []),
  ];
  handles.sort((left, right) => left.distance - right.distance || left.priority - right.priority);
  return handles[0]?.mode ?? 'move';
}
