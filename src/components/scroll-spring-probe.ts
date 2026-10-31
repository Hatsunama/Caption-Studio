// TEMPORARY private-build connection probe. Remove after native diagnosis.
// Expo inlines this static reference on JS; worklets capture only the boolean.
export const SCROLL_SPRING_PROBE_ENABLED =
  process.env.EXPO_PUBLIC_SCROLL_SPRING_DIAGNOSTICS === '1';
export const isScrollSpringProbeEnabled = SCROLL_SPRING_PROBE_ENABLED;

const EVENTS = [
  'reset', 'down', 'start', 'move', 'up', 'cancel', 'finalize',
  'spring-before', 'spring-start', 'spring-complete', 'activate', 'deactivate',
  'content-ready', 'options', 'reduced', 'foreground', 'geometry',
  'native-offset', 'present', 'bind', 'public-ref', 'app-state',
];
const METRICS = [
  'epoch', 'alive', 'ready', 'enabled', 'canOwn', 'nativeActive', 'active',
  'pending', 'released', 'owner', 'offset', 'viewport', 'content', 'touches',
  'motionReady', 'reduced', 'foreground', 'extra', 'contentTag',
];

export function traceScrollSpringProbe(
  event: string,
  id: number,
  values: Record<string, number | boolean | null>,
): void {
  'worklet';
  if (!SCROLL_SPRING_PROBE_ENABLED) return;
  if (typeof event !== 'string' || !EVENTS.includes(event) || !Number.isInteger(id)) return;

  const payload: Record<string, string | number | boolean> = { event, id };
  if (values !== null && typeof values === 'object' && !Array.isArray(values)) {
    for (const key of METRICS) {
      // Ignore inherited properties and getters; never serialize caller objects.
      const descriptor = Object.getOwnPropertyDescriptor(values, key);
      const value: unknown = descriptor?.value;
      if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
        payload[key] = value;
      }
    }
  }
  console.log('CAPTION_SPRING_DIAG', JSON.stringify(payload));
}
