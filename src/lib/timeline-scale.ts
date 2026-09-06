export const MIN_TIMELINE_PIXELS_PER_SECOND = 0.5;
export const MAX_TIMELINE_PIXELS_PER_SECOND = 240;

export function minimumTimelineScale(durationMs: number, viewportWidth: number) {
  const seconds = Math.max(0.001, durationMs / 1000);
  return clamp(viewportWidth / seconds, MIN_TIMELINE_PIXELS_PER_SECOND, 32);
}

export function timelineWidth(durationMs: number, pixelsPerSecond: number, viewportWidth: number) {
  return Math.max(viewportWidth, durationMs / 1000 * pixelsPerSecond);
}

export function timelineTickInterval(pixelsPerSecond: number) {
  const intervals = [100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000];
  return intervals.find((interval) => interval / 1000 * pixelsPerSecond >= 56) ?? intervals.at(-1)!;
}

export function timelineZoomPercent(scale: number, minimum: number) {
  if (minimum >= MAX_TIMELINE_PIXELS_PER_SECOND) return 100;
  const normalized = Math.log(scale / minimum) / Math.log(MAX_TIMELINE_PIXELS_PER_SECOND / minimum);
  return Math.round(clamp(normalized, 0, 1) * 100);
}

export function timelineScrollOffset(timeMs: number, durationMs: number, trackWidth: number) {
  return clamp(timeMs / Math.max(1, durationMs), 0, 1) * Math.max(1, trackWidth);
}

export function timelineTimeAtScroll(offset: number, durationMs: number, trackWidth: number) {
  return clamp(offset / Math.max(1, trackWidth), 0, 1) * Math.max(1, durationMs);
}

export function clampTimelineScale(scale: number, minimum: number) {
  return clamp(scale, minimum, MAX_TIMELINE_PIXELS_PER_SECOND);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Equal-tile filmstrip width used while hold-drag reordering video clips. */
export function reorderFilmstripWidth(clipCount: number, tileSize: number, tileGap: number) {
  const count = Math.max(0, clipCount);
  return count * (tileSize + tileGap) + tileGap;
}

/** Track width in reorder mode: filmstrip-sized, never stretched to the full timeline. */
export function reorderTrackWidth(filmstripWidth: number, viewportContentWidth: number) {
  return Math.max(Math.max(0, filmstripWidth), Math.max(1, viewportContentWidth));
}

export function reorderTileLeft(index: number, tileSize: number, tileGap: number) {
  return Math.max(0, index) * (tileSize + tileGap);
}

/**
 * Scroll offset that keeps a filmstrip tile on-screen under the centered playhead.
 * Short filmstrips pin to the start (offset 0); longer ones center the active tile.
 */
export function reorderScrollOffsetForTile(
  tileIndex: number,
  tileSize: number,
  tileGap: number,
  trackWidth: number,
  viewportContentWidth: number,
) {
  const maxScroll = Math.max(0, trackWidth);
  // When the filmstrip is no wider than the content viewport, pin to start so tiles stay visible.
  if (trackWidth <= Math.max(1, viewportContentWidth) + 1) {
    return 0;
  }
  const tileCenter = reorderTileLeft(tileIndex, tileSize, tileGap) + tileSize / 2;
  return clamp(tileCenter, 0, maxScroll);
}

/**
 * Nudge scroll when the drop index approaches the visible edges during reorder drag.
 * Returns the current offset when the tile is comfortably inside the viewport.
 */
export function reorderAutoScrollOffset(
  currentScrollX: number,
  dropIndex: number,
  tileSize: number,
  tileGap: number,
  trackWidth: number,
  viewportWidth: number,
  edgePx = 56,
) {
  const maxScroll = Math.max(0, trackWidth);
  const scrollX = clamp(currentScrollX, 0, maxScroll);
  // Visible track window around the centered playhead.
  const half = Math.max(1, viewportWidth) / 2;
  const visibleStart = scrollX - half;
  const visibleEnd = scrollX + half;
  const tileLeft = reorderTileLeft(dropIndex, tileSize, tileGap);
  const tileRight = tileLeft + tileSize;
  if (tileLeft < visibleStart + edgePx) {
    return clamp(tileLeft + tileSize / 2, 0, maxScroll);
  }
  if (tileRight > visibleEnd - edgePx) {
    return clamp(tileLeft + tileSize / 2, 0, maxScroll);
  }
  return scrollX;
}
