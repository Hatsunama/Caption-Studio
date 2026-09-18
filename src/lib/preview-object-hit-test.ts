import { layerExtent, type LayerGeometryInput } from '@/lib/layer-geometry';

export type PreviewPoint = { x: number; y: number };
export type PreviewSize = { width: number; height: number };
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
