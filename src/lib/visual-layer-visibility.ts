export type TimedVisualLayer = Readonly<{
  visible?: boolean;
  startMs: number;
  endMs: number;
}>;

export function visualLayerVisibleAtTime(
  layer: TimedVisualLayer,
  timeMs: number,
): boolean {
  return (
    layer.visible !== false &&
    Number.isFinite(timeMs) &&
    timeMs >= layer.startMs &&
    timeMs < layer.endMs
  );
}
