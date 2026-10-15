import { isProjectIdentifier } from '@/lib/project-identifiers';
import { packTimelineLanes } from '@/lib/timeline-layout';
import type { CaptionProject, VisualLayer } from '@/types/project';

export function visualTimelineTrackId(layer: VisualLayer): string {
  return layer.kind === 'captions' ? 'captions' : layer.kind === 'image' ? 'images' : layer.watermark ? 'watermarks' : 'text';
}

export function visualTimelineGroups(layers: readonly VisualLayer[]) {
  const groups = new Map<string, Exclude<VisualLayer, { kind: 'captions' }>[]>();
  for (const layer of layers) {
    if (layer.kind === 'captions' || layer.timelineVisible === false) continue;
    const id = visualTimelineTrackId(layer);
    const items = groups.get(id) ?? [];
    items.push(layer);
    groups.set(id, items);
  }
  return [...groups].map(([id, items]) => ({ id, items, layout: packTimelineLanes(items) }));
}

export function orderedTimelineTrackIds(available: readonly string[], saved: readonly string[] = []) {
  const remaining = new Set(available);
  const ordered: string[] = [];
  for (const id of [...saved, ...available]) {
    if (!remaining.delete(id)) continue;
    ordered.push(id);
  }
  return ordered;
}

export function moveTimelineTrack(order: readonly string[], id: string, destination: number) {
  const index = order.indexOf(id);
  if (index < 0 || !Number.isFinite(destination)) return [...order];
  const next = order.filter((candidate) => candidate !== id);
  next.splice(Math.max(0, Math.min(next.length, Math.round(destination))), 0, id);
  return next;
}

export function decodeTimelineTrackOrder(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 5_006) throw new Error('Timeline track order is invalid');
  const ids = new Set<string>();
  return value.map((id) => {
    if (typeof id !== 'string' || ids.has(id) ||
      (!['video', 'audio', 'captions', 'text', 'images', 'watermarks'].includes(id) &&
        !(id.startsWith('translation:') && isProjectIdentifier(id.slice(12))))) {
      throw new Error('Timeline track order contains an invalid or duplicate track');
    }
    ids.add(id);
    return id;
  });
}

export function setTimelineTrackOrder(project: CaptionProject, order: readonly string[]): CaptionProject {
  const next = decodeTimelineTrackOrder(order);
  if (next.length === project.timelineTrackOrder?.length && next.every((id, index) => id === project.timelineTrackOrder?.[index])) return project;
  return { ...project, updatedAt: new Date().toISOString(), timelineTrackOrder: next };
}
