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
    if (!hit || target.order >= hit.order) hit = target;
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
  if (selected) {
    const selectedMode = selectedChromeMode(selected.geometry, point, size, deletable);
    if (selectedMode && selectedMode !== 'move') return { target: selected, mode: selectedMode };
  }
  const target = previewObjectAtPoint(targets, point, size);
  if (!target) return undefined;
  return {
    target,
    mode: target.key === selectedKey
      ? selectedChromeMode(target.geometry, point, size, false) ?? 'move'
      : 'move',
  };
}

function selectedChromeMode(
  geometry: LayerGeometryInput,
  point: PreviewPoint,
  size: PreviewSize,
  deletable: boolean,
): LayerGestureMode | 'delete' | undefined {
  if (!(size.width > 0) || !(size.height > 0)) return undefined;
  const extent = layerExtent(geometry);
  const radians = geometry.rotation * Math.PI / 180;
  const dx = point.x - geometry.position.x * size.width;
  const dy = point.y - geometry.position.y * size.height;
  const localX = dx * Math.cos(radians) + dy * Math.sin(radians);
  const localY = -dx * Math.sin(radians) + dy * Math.cos(radians);
  const halfWidth = Math.max(12, extent.width * size.width / 2);
  const halfHeight = Math.max(12, extent.height * size.height / 2);
  if (deletable && Math.hypot(localX + halfWidth, localY + halfHeight) <= 22) return 'delete';
  const cornerRadius = Math.min(22, Math.max(7, Math.min(halfWidth, halfHeight) * 0.42));
  if (Math.hypot(localX - halfWidth, localY - halfHeight) <= cornerRadius) return 'corner';
  if (Math.abs(localX) > halfWidth || Math.abs(localY) > halfHeight) return undefined;
  const horizontalThreshold = Math.min(18, Math.max(3, halfWidth * 0.42));
  const verticalThreshold = Math.min(18, Math.max(3, halfHeight * 0.42));
  const edges = [
    { mode: 'left' as const, distance: Math.abs(localX + halfWidth), active: localX <= 0 },
    { mode: 'right' as const, distance: Math.abs(localX - halfWidth), active: localX >= 0 },
    { mode: 'top' as const, distance: Math.abs(localY + halfHeight), active: localY <= 0 },
    { mode: 'bottom' as const, distance: Math.abs(localY - halfHeight), active: localY >= 0 },
  ].filter((edge) => edge.active && edge.distance <= (edge.mode === 'left' || edge.mode === 'right'
    ? horizontalThreshold : verticalThreshold));
  edges.sort((left, right) => left.distance - right.distance);
  return edges[0]?.mode ?? 'move';
}
