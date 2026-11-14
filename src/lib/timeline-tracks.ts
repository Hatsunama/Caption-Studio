import { isProjectIdentifier } from '@/lib/project-identifiers';
import { packOrderedTimelineLanes } from '@/lib/timeline-layout';
import type { CaptionProject, VisualLayer } from '@/types/project';

/** Kind base only. Resolve actual segmented rows through group membership. */
export function visualTimelineTrackId(layer: VisualLayer): string {
  return layer.kind === 'captions' ? 'captions' : layer.kind === 'image' ? 'images' : layer.kind === 'video' ? 'videos' : layer.watermark ? 'watermarks' : 'text';
}

export function visualTimelineGroups(layers: readonly VisualLayer[], heldLayouts?: ReadonlyMap<string, ReturnType<typeof packOrderedTimelineLanes>>) {
  const groups: { id: string; baseId: string; items: Exclude<VisualLayer, { kind: 'captions' }>[] }[] = [];
  const seen = new Set<string>();
  let current: (typeof groups)[number] | undefined;
  for (const layer of [...layers].reverse()) {
    if (layer.kind === 'captions') { current = undefined; continue; }
    if (layer.timelineVisible === false) continue;
    const baseId = visualTimelineTrackId(layer);
    if (!current || current.baseId !== baseId) {
      current = { id: seen.has(baseId) ? `${baseId}:${layer.id}` : baseId, baseId, items: [] };
      seen.add(baseId);
      groups.push(current);
    }
    current.items.push(layer);
  }
  return groups.map((group) => ({ ...group, layout: heldLayouts?.get(group.id) ?? packOrderedTimelineLanes(group.items) }));
}

export function visualTimelineGroupForLayer(groups: ReturnType<typeof visualTimelineGroups>, layerId: string) {
  return groups.find((group) => group.items.some((item) => item.id === layerId));
}

/** One caption container, including translations; hidden timeline items have no slot. */
export function visualTimelineLayerIds(layers: readonly VisualLayer[]): string[] {
  return [...layers].reverse().filter(isTimelineVisual).map((layer) => layer.id);
}

function isTimelineVisual(layer: VisualLayer) {
  return layer.kind === 'captions' || layer.timelineVisible !== false;
}

/** Front-to-back rows. Primary paints first, then translations in model order;
 * reverse those rows together inside their one indivisible caption bundle. */
export function visualTimelineRowIds(layers: readonly VisualLayer[], translationTrackIds: readonly string[] = [], groups = visualTimelineGroups(layers)) {
  const rowByLayer = new Map(groups.flatMap((group) => group.items.map((item) => [item.id, group.id] as const)));
  const rows = new Set<string>();
  for (const layer of [...layers].reverse()) {
    if (layer.kind === 'captions') {
      for (const id of [...translationTrackIds].reverse()) rows.add('translation:' + id);
      rows.add('captions');
    } else if (isTimelineVisual(layer)) rows.add(rowByLayer.get(layer.id)!);
  }
  return [...rows];
}

/** Replace only participating slots: hidden items retain identity and position. */
function withVisualOrder(layers: readonly VisualLayer[], frontToBack: readonly VisualLayer[]): readonly VisualLayer[] {
  let index = frontToBack.length;
  const next = layers.map((layer) => isTimelineVisual(layer) ? frontToBack[--index] : layer);
  return next.every((layer, i) => layer === layers[i]) ? layers : next;
}

/** Destination is the final global front index (0 = front), clamped to the stack. */
export function reorderVisualTimelineLayers(
  layers: readonly VisualLayer[], layerId: string, destinationFrontIndex: number,
): readonly VisualLayer[] {
  if (!Number.isFinite(destinationFrontIndex)) return layers;
  const ordered = [...layers].reverse().filter(isTimelineVisual);
  const index = ordered.findIndex((layer) => layer.id === layerId);
  if (index < 0) return layers;
  const destination = Math.max(0, Math.min(ordered.length - 1, Math.round(destinationFrontIndex)));
  if (destination === index) return layers;
  const [layer] = ordered.splice(index, 1);
  ordered.splice(destination, 0, layer);
  return withVisualOrder(layers, ordered);
}

function projectWithVisualOrder(project: CaptionProject, layers: readonly VisualLayer[]): CaptionProject {
  return layers === project.layers ? project : { ...project, layers: [...layers], updatedAt: new Date().toISOString() };
}

export function reorderVisualTimelineLayer(project: CaptionProject, layerId: string, destinationFrontIndex: number): CaptionProject {
  return projectWithVisualOrder(project, reorderVisualTimelineLayers(project.layers, layerId, destinationFrontIndex));
}

/** Explicit user row/group order applies paint order. Never invoke on draft load.
 * Unknown/duplicate IDs reject the whole operation. Unmentioned visuals follow
 * in their existing relative order; video/audio do not participate in z-order.
 * Any primary/translation row moves the entire caption container once, at its
 * first occurrence. No per-cue or per-language z-order exists in this model. */
export function applyTimelineStackOrder(project: CaptionProject, rowIds: readonly string[]): CaptionProject {
  const groups = visualTimelineGroups(project.layers);
  const byRow = new Map<string, readonly VisualLayer[]>(groups.map((group) => [group.id, group.items]));
  const captionLayer = project.layers.find((layer) => layer.kind === 'captions');
  if (captionLayer) {
    byRow.set('captions', [captionLayer]);
    for (const track of project.captionTracks.translations) byRow.set('translation:' + track.id, [captionLayer]);
  }
  const seenRows = new Set<string>();
  const seenLayers = new Set<string>();
  const ordered: VisualLayer[] = [];
  for (const id of rowIds) {
    if (seenRows.has(id) || (!byRow.has(id) && id !== 'video' && id !== 'audio')) return project;
    seenRows.add(id);
    for (const layer of byRow.get(id) ?? []) {
      if (seenLayers.has(layer.id)) continue;
      seenLayers.add(layer.id);
      ordered.push(layer);
    }
  }
  for (const layer of [...project.layers].reverse().filter(isTimelineVisual)) {
    if (!seenLayers.has(layer.id)) ordered.push(layer);
  }
  return projectWithVisualOrder(project, withVisualOrder(project.layers, ordered));
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

/** Primary and translated subtitles share one actual render container. */
export function timelineTrackMembers(order: readonly string[], id: string) {
  if (!order.includes(id)) return [];
  return id === 'captions' || id.startsWith('translation:')
    ? order.filter((candidate) => candidate === 'captions' || candidate.startsWith('translation:'))
    : [id];
}

/** Destination is a row insertion index after removing the moving bundle.
 * Crossing any row of a neighbouring bundle crosses that whole container. */
export function moveTimelineTrack(order: readonly string[], id: string, destination: number) {
  const members = timelineTrackMembers(order, id);
  if (!members.length || !Number.isFinite(destination)) return [...order];
  const index = order.indexOf(members[0]);
  const next = order.filter((candidate) => !members.includes(candidate));
  let target = Math.max(0, Math.min(next.length, Math.round(destination)));
  if (target > 0 && target < next.length) {
    const neighbour = timelineTrackMembers(next, next[target]);
    if (neighbour.includes(next[target - 1])) {
      target = target < index ? next.indexOf(neighbour[0]) : next.indexOf(neighbour[neighbour.length - 1]) + 1;
    }
  }
  next.splice(target, 0, ...members);
  return next;
}

export function decodeTimelineTrackOrder(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 5_006) throw new Error('Timeline track order is invalid');
  const ids = new Set<string>();
  return value.map((id) => {
    if (typeof id !== 'string' || ids.has(id) ||
      (!['video', 'audio', 'captions', 'text', 'images', 'videos', 'watermarks'].includes(id) &&
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
